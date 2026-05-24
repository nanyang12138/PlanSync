// Regression tests for review-finding issues #829 / #830 on PR #818
// (completion-verify consistency sampling correctness).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const completeMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/lib/ai/client', () => ({
  aiClient: {
    get isAvailable() {
      return true;
    },
    providerName: 'mock',
    complete: completeMock,
  },
}));

beforeEach(() => {
  completeMock.mockReset();
});

describe('Issue #830: consistency sample uses full zod schema, drops out-of-range scores', () => {
  it('drops a sample whose score is > 100 (would otherwise pollute the median)', async () => {
    completeMock
      .mockResolvedValueOnce(
        JSON.stringify({ verified: true, score: 150, gaps: [], feedback: 'crazy' }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ verified: false, score: 70, gaps: [], feedback: 'normal' }),
      );

    const { applyCompletionVerifyConsistency } = await import(
      '../../src/lib/ai/completion-verify-consistency'
    );
    const outcome = await applyCompletionVerifyConsistency(
      { verified: false, score: 72, gaps: [], feedback: 'orig' },
      'sys',
      'user',
    );
    expect(outcome.scores).toEqual([72, 70]);
    expect(outcome.result.score).toBe(71);
  });

  it('drops a sample missing required fields (no gaps array)', async () => {
    completeMock.mockResolvedValueOnce(
      JSON.stringify({ verified: true, score: 80, feedback: 'oops no gaps' }),
    );
    completeMock.mockResolvedValueOnce(
      JSON.stringify({ verified: false, score: 70, gaps: [], feedback: 'ok' }),
    );

    const { applyCompletionVerifyConsistency } = await import(
      '../../src/lib/ai/completion-verify-consistency'
    );
    const outcome = await applyCompletionVerifyConsistency(
      { verified: false, score: 72, gaps: [], feedback: 'orig' },
      'sys',
      'user',
    );
    expect(outcome.scores).toEqual([72, 70]);
  });

  it('drops a sample with negative score (lower bound check)', async () => {
    completeMock
      .mockResolvedValueOnce(
        JSON.stringify({ verified: false, score: -5, gaps: [], feedback: 'bad' }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ verified: false, score: 70, gaps: [], feedback: 'ok' }),
      );

    const { applyCompletionVerifyConsistency } = await import(
      '../../src/lib/ai/completion-verify-consistency'
    );
    const outcome = await applyCompletionVerifyConsistency(
      { verified: false, score: 72, gaps: [], feedback: 'orig' },
      'sys',
      'user',
    );
    expect(outcome.scores).toEqual([72, 70]);
  });
});

describe('Issue #829: consistency median re-derives `verified` field', () => {
  it('median crossing UP through 75 flips verified false → true', async () => {
    completeMock
      .mockResolvedValueOnce(
        JSON.stringify({ verified: true, score: 80, gaps: [], feedback: 'a' }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ verified: true, score: 78, gaps: [], feedback: 'b' }),
      );

    const { applyCompletionVerifyConsistency } = await import(
      '../../src/lib/ai/completion-verify-consistency'
    );
    const outcome = await applyCompletionVerifyConsistency(
      { verified: false, score: 70, gaps: [], feedback: 'orig' },
      'sys',
      'user',
    );
    expect(outcome.result.score).toBe(78); // median(70, 78, 80) = 78
    expect(outcome.result.verified).toBe(true); // 78 >= 75
  });

  it('median crossing DOWN through 75 flips verified true → false', async () => {
    completeMock
      .mockResolvedValueOnce(
        JSON.stringify({ verified: false, score: 70, gaps: [], feedback: 'a' }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ verified: false, score: 60, gaps: [], feedback: 'b' }),
      );

    const { applyCompletionVerifyConsistency } = await import(
      '../../src/lib/ai/completion-verify-consistency'
    );
    const outcome = await applyCompletionVerifyConsistency(
      { verified: true, score: 76, gaps: [], feedback: 'orig' },
      'sys',
      'user',
    );
    expect(outcome.result.score).toBe(70); // median(60, 70, 76) = 70
    expect(outcome.result.verified).toBe(false); // 70 < 75
  });

  it('boundary value: median exactly 75 keeps verified=true', async () => {
    completeMock
      .mockResolvedValueOnce(
        JSON.stringify({ verified: true, score: 75, gaps: [], feedback: 'a' }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ verified: true, score: 80, gaps: [], feedback: 'b' }),
      );

    const { applyCompletionVerifyConsistency } = await import(
      '../../src/lib/ai/completion-verify-consistency'
    );
    const outcome = await applyCompletionVerifyConsistency(
      { verified: false, score: 70, gaps: [], feedback: 'orig' },
      'sys',
      'user',
    );
    expect(outcome.result.score).toBe(75); // median(70, 75, 80) = 75
    expect(outcome.result.verified).toBe(true); // 75 >= 75 (inclusive)
  });
});
