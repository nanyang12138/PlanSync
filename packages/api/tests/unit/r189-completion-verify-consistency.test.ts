// R-189: completion-verify boundary-score self-consistency sampling.
//
// Tests the helper in isolation (mocks aiClient.complete) — the
// integration with the runs route is covered by the existing r143
// integration suite which exercises the same code path end-to-end.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { completeMock } = vi.hoisted(() => ({ completeMock: vi.fn() }));

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

afterEach(() => {
  vi.restoreAllMocks();
});

function initial(score: number, feedback = 'okay'): {
  verified: boolean;
  score: number;
  breakdown?: { specificity: number; coherence: number; coverage: number };
  gaps: string[];
  feedback: string;
} {
  return {
    verified: score >= 75,
    score,
    breakdown: { specificity: 25, coherence: 25, coverage: 25 },
    gaps: [],
    feedback,
  };
}

describe('R-189 completion-verify self-consistency', () => {
  it('does NOT trigger when score is clearly passing (>80)', async () => {
    const { applyCompletionVerifyConsistency } = await import(
      '../../src/lib/ai/completion-verify-consistency'
    );
    const outcome = await applyCompletionVerifyConsistency(initial(92), 'sys', 'user');
    expect(outcome.result.score).toBe(92);
    expect(outcome.lowConfidence).toBe(false);
    expect(outcome.scores).toEqual([92]);
    expect(completeMock).not.toHaveBeenCalled();
    expect(outcome.metadataPatch).toEqual({});
  });

  it('does NOT trigger when score is clearly failing (<60)', async () => {
    const { applyCompletionVerifyConsistency } = await import(
      '../../src/lib/ai/completion-verify-consistency'
    );
    const outcome = await applyCompletionVerifyConsistency(initial(45), 'sys', 'user');
    expect(outcome.result.score).toBe(45);
    expect(outcome.lowConfidence).toBe(false);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('triggers in the [60, 80] boundary zone and median-corrects', async () => {
    const { applyCompletionVerifyConsistency } = await import(
      '../../src/lib/ai/completion-verify-consistency'
    );
    completeMock
      .mockResolvedValueOnce(JSON.stringify(initial(78)))
      .mockResolvedValueOnce(JSON.stringify(initial(80)));

    const outcome = await applyCompletionVerifyConsistency(initial(72), 'sys', 'user');

    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(outcome.scores).toEqual([72, 78, 80]);
    expect(outcome.result.score).toBe(78); // median(72,78,80)
    expect(outcome.lowConfidence).toBe(false); // spread = 8, ≤ 15
    expect(outcome.metadataPatch.consistencyMedian).toBe(78);
    expect(outcome.metadataPatch.consistencySpread).toBe(8);
  });

  it('flags low confidence when sample spread > 15', async () => {
    const { applyCompletionVerifyConsistency } = await import(
      '../../src/lib/ai/completion-verify-consistency'
    );
    completeMock
      .mockResolvedValueOnce(JSON.stringify(initial(45, 'second')))
      .mockResolvedValueOnce(JSON.stringify(initial(95, 'third')));

    const outcome = await applyCompletionVerifyConsistency(
      initial(72, 'first'),
      'sys',
      'user',
    );

    expect(outcome.lowConfidence).toBe(true);
    expect(outcome.result.score).toBe(72); // median(45,72,95)
    expect(outcome.result.feedback).toMatch(/unstable across 3 samples/);
    expect(outcome.result.feedback).toMatch(/45 \/ 72 \/ 95|72 \/ 45 \/ 95/); // order preserved
    expect(outcome.result.feedback).toContain('Original feedback: first');
    expect(outcome.metadataPatch.consistencyLowConfidence).toBe(true);
  });

  it('boundary zone is inclusive on both ends', async () => {
    const { applyCompletionVerifyConsistency } = await import(
      '../../src/lib/ai/completion-verify-consistency'
    );
    completeMock.mockResolvedValue(JSON.stringify(initial(60)));
    const lower = await applyCompletionVerifyConsistency(initial(60), 'sys', 'user');
    expect(completeMock).toHaveBeenCalled();
    expect(lower.scores.length).toBeGreaterThanOrEqual(2);

    completeMock.mockReset();
    completeMock.mockResolvedValue(JSON.stringify(initial(80)));
    const upper = await applyCompletionVerifyConsistency(initial(80), 'sys', 'user');
    expect(completeMock).toHaveBeenCalled();
    expect(upper.scores.length).toBeGreaterThanOrEqual(2);
  });

  it('survives all extra samples returning null', async () => {
    const { applyCompletionVerifyConsistency } = await import(
      '../../src/lib/ai/completion-verify-consistency'
    );
    completeMock.mockResolvedValue(null);
    const outcome = await applyCompletionVerifyConsistency(initial(70), 'sys', 'user');
    expect(outcome.result.score).toBe(70);
    expect(outcome.lowConfidence).toBe(false);
    expect(outcome.scores).toEqual([70]);
    expect(outcome.metadataPatch.consistencySampleFailed).toBe(true);
  });

  it('survives extra samples throwing — uses available samples', async () => {
    const { applyCompletionVerifyConsistency } = await import(
      '../../src/lib/ai/completion-verify-consistency'
    );
    completeMock
      .mockRejectedValueOnce(new Error('provider blew up'))
      .mockResolvedValueOnce(JSON.stringify(initial(78)));

    const outcome = await applyCompletionVerifyConsistency(initial(72), 'sys', 'user');
    expect(outcome.scores).toEqual([72, 78]);
    expect(outcome.result.score).toBe(75); // median(72,78) = 75
    expect(outcome.lowConfidence).toBe(false);
  });

  it('survives extra samples returning malformed JSON', async () => {
    const { applyCompletionVerifyConsistency } = await import(
      '../../src/lib/ai/completion-verify-consistency'
    );
    completeMock.mockResolvedValue('garbage{not json');
    const outcome = await applyCompletionVerifyConsistency(initial(70), 'sys', 'user');
    expect(outcome.result.score).toBe(70);
    expect(outcome.metadataPatch.consistencySampleFailed).toBe(true);
  });

  it('salts each follow-up user message so cache cannot serve duplicates', async () => {
    const { applyCompletionVerifyConsistency } = await import(
      '../../src/lib/ai/completion-verify-consistency'
    );
    completeMock
      .mockResolvedValueOnce(JSON.stringify(initial(75)))
      .mockResolvedValueOnce(JSON.stringify(initial(78)));

    await applyCompletionVerifyConsistency(initial(72), 'SYS', 'ORIGINAL_USER');

    const calls = completeMock.mock.calls;
    const firstSalted = calls[0][1] as string;
    const secondSalted = calls[1][1] as string;
    expect(firstSalted).toContain('Sample 2 of 3');
    expect(secondSalted).toContain('Sample 3 of 3');
    expect(firstSalted).toContain('ORIGINAL_USER');
    expect(secondSalted).toContain('ORIGINAL_USER');
    expect(firstSalted).not.toBe(secondSalted);
  });
});
