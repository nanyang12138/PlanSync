// R-186: validate/ shared layer tests.
//
// Exercises the four primitives (validateOrNull / assertIdsInAllowlist /
// assertLiteralsInContext / normalizeAiList / normalizeAiText) and the
// two callers that adopt them (conflict-prediction's allowlist guard,
// plan-diff's literal grounding warning).
//
// The validate functions are pure so there's no env / singleton reset
// dance; the caller tests reuse the r183/r185 mock pattern.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const recordAiCallMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/lib/ai/usage', () => ({
  recordAiCall: recordAiCallMock,
}));

const ENV_KEYS = [
  'LLM_API_KEY',
  'LLM_API_BASE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'PLANSYNC_AI_MOCK',
] as const;
const originals: Record<string, string | undefined> = {};

function snapshotEnv() {
  for (const k of ENV_KEYS) originals[k] = process.env[k];
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (originals[k] === undefined) delete process.env[k];
    else process.env[k] = originals[k];
  }
}

function makeToolUseResponse(toolName: string, input: object): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'tool_use', id: 't1', name: toolName, input }],
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('R-186 validate primitives', () => {
  describe('validateOrNull', () => {
    it('returns ok with parsed value for valid JSON + schema match', async () => {
      const { validateOrNull } = await import('../../src/lib/ai/validate');
      const schema = z.object({ a: z.number(), b: z.string() });
      const r = validateOrNull('{"a":1,"b":"x"}', schema);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({ a: 1, b: 'x' });
    });

    it('returns fail with json_parse_failed for invalid JSON', async () => {
      const { validateOrNull } = await import('../../src/lib/ai/validate');
      const schema = z.object({ a: z.number() });
      const r = validateOrNull('not json', schema);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues[0]).toMatch(/json_parse_failed/);
    });

    it('returns fail with field-path issues for schema mismatch', async () => {
      const { validateOrNull } = await import('../../src/lib/ai/validate');
      const schema = z.object({ a: z.number() });
      const r = validateOrNull('{"a":"oops"}', schema);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues[0]).toMatch(/^a:/);
    });
  });

  describe('assertIdsInAllowlist', () => {
    it('keeps allowed ids, drops unknown ones, surfaces warning', async () => {
      const { assertIdsInAllowlist } = await import('../../src/lib/ai/validate');
      const r = assertIdsInAllowlist(
        ['t1', 't2', 'fake', 'phantom'],
        new Set(['t1', 't2', 't3']),
        'conflict.taskIds',
      );
      expect(r.kept).toEqual(['t1', 't2']);
      expect(r.dropped).toEqual(['fake', 'phantom']);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toMatch(/conflict\.taskIds/);
      expect(r.warnings[0]).toMatch(/hallucinated/);
    });

    it('no warning when nothing is dropped', async () => {
      const { assertIdsInAllowlist } = await import('../../src/lib/ai/validate');
      const r = assertIdsInAllowlist(['a', 'b'], new Set(['a', 'b', 'c']), 'f');
      expect(r.dropped).toEqual([]);
      expect(r.warnings).toEqual([]);
    });

    it('truncates very long dropped lists in the warning', async () => {
      const { assertIdsInAllowlist } = await import('../../src/lib/ai/validate');
      const bad = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'];
      const r = assertIdsInAllowlist(bad, new Set(), 'f');
      expect(r.warnings[0]).toMatch(/x1, x2, x3, x4, x5…/);
    });
  });

  describe('assertLiteralsInContext', () => {
    it('flags ungrounded ISO dates', async () => {
      const { assertLiteralsInContext } = await import('../../src/lib/ai/validate');
      const r = assertLiteralsInContext(
        { reasoning: 'deadline moved to 2027-12-31' },
        'original deadline 2026-06-01',
        ['reasoning'],
      );
      expect(r.ungrounded).toHaveLength(1);
      expect(r.ungrounded[0].kind).toBe('iso_date');
      expect(r.ungrounded[0].value).toBe('2027-12-31');
    });

    it('does NOT flag dates that appear in context', async () => {
      const { assertLiteralsInContext } = await import('../../src/lib/ai/validate');
      const r = assertLiteralsInContext(
        { reasoning: 'shift to 2026-06-01' },
        'original 2026-06-01 deadline',
        ['reasoning'],
      );
      expect(r.ungrounded).toEqual([]);
    });

    it('flags ungrounded $ amounts and % literals', async () => {
      const { assertLiteralsInContext } = await import('../../src/lib/ai/validate');
      const r = assertLiteralsInContext(
        { description: 'budget cut by $9,999 (12%)' },
        'budget mentions 2%',
        ['description'],
      );
      const kinds = r.ungrounded.map((u) => u.kind);
      expect(kinds).toContain('money');
      expect(kinds).toContain('percent');
    });

    it('flags ungrounded quoted strings >= 4 chars', async () => {
      const { assertLiteralsInContext } = await import('../../src/lib/ai/validate');
      const r = assertLiteralsInContext(
        { from: 'old goal "ship by friday"' },
        'old goal mentions launch',
        ['from'],
      );
      expect(r.ungrounded.map((u) => u.value)).toContain('"ship by friday"');
    });

    it('ignores empty / non-string fields', async () => {
      const { assertLiteralsInContext } = await import('../../src/lib/ai/validate');
      const r = assertLiteralsInContext(
        { from: '', to: undefined as unknown as string, other: 42 as unknown as string },
        'anything',
        ['from', 'to', 'other'],
      );
      expect(r.ungrounded).toEqual([]);
    });
  });

  describe('normalizeAiList / normalizeAiText', () => {
    it('strips markdown bullet prefixes', async () => {
      const { normalizeAiList } = await import('../../src/lib/ai/validate');
      const r = normalizeAiList('- alpha\n* beta\n• gamma\n· delta');
      expect(r).toEqual(['alpha', 'beta', 'gamma', 'delta']);
    });

    it('strips numbered list prefixes (1. and 1))', async () => {
      const { normalizeAiList } = await import('../../src/lib/ai/validate');
      const r = normalizeAiList('1. first\n2) second\n3.  third');
      expect(r).toEqual(['first', 'second', 'third']);
    });

    it('drops empty lines and caps at maxItems', async () => {
      const { normalizeAiList } = await import('../../src/lib/ai/validate');
      const input = Array.from({ length: 30 }, (_, i) => `item ${i}`).join('\n\n');
      const r = normalizeAiList(input, 5);
      expect(r).toHaveLength(5);
      expect(r[0]).toBe('item 0');
    });

    it('handles CRLF line endings', async () => {
      const { normalizeAiList } = await import('../../src/lib/ai/validate');
      expect(normalizeAiList('a\r\nb\r\n')).toEqual(['a', 'b']);
    });

    it('normalizeAiText trims and caps at maxChars', async () => {
      const { normalizeAiText } = await import('../../src/lib/ai/validate');
      expect(normalizeAiText('   hi   ')).toBe('hi');
      const long = 'x'.repeat(3000);
      const r = normalizeAiText(long, 100);
      expect(r.length).toBe(100);
      expect(r.endsWith('…')).toBe(true);
    });

    it('normalizeAiText does NOT append ellipsis when not truncated', async () => {
      const { normalizeAiText } = await import('../../src/lib/ai/validate');
      expect(normalizeAiText('short', 100)).toBe('short');
    });
  });
});

describe('R-186 conflict-prediction allowlist guard', () => {
  beforeEach(() => {
    snapshotEnv();
    vi.resetModules();
    delete (globalThis as { aiClient?: unknown }).aiClient;
    for (const k of ENV_KEYS) delete process.env[k];
    recordAiCallMock.mockReset();
    recordAiCallMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { aiClient?: unknown }).aiClient;
    restoreEnv();
  });

  it('drops conflicts whose taskIds reference hallucinated ids', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeToolUseResponse('emit_conflict_prediction', {
        conflicts: [
          {
            taskIds: ['real-a', 'real-b'],
            type: 'resource',
            severity: 'medium',
            description: 'genuine conflict',
            recommendation: 'split work',
          },
          {
            // both ids hallucinated → should be dropped entirely (kept count < 2)
            taskIds: ['phantom-x', 'phantom-y'],
            type: 'resource',
            severity: 'high',
            description: 'fake',
            recommendation: 'fake',
          },
          {
            // one real, one hallucinated → after filter kept=1, < 2 → drop
            taskIds: ['real-a', 'phantom-z'],
            type: 'scope_overlap',
            severity: 'low',
            description: 'edge case',
            recommendation: 'edge',
          },
        ],
      }),
    );

    const { predictConflicts } = await import('../../src/lib/ai/conflict-prediction');
    const out = await predictConflicts([
      { id: 'real-a', title: 'A', status: 'in_progress' },
      { id: 'real-b', title: 'B', status: 'todo' },
    ]);

    expect(out).not.toBeNull();
    expect(out!.conflicts).toHaveLength(1);
    expect(out!.conflicts[0].taskIds).toEqual(['real-a', 'real-b']);
  });

  it('returns empty conflicts on schema violation (no throw)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeToolUseResponse('emit_conflict_prediction', { conflicts: 'not-an-array' }),
    );

    const { predictConflicts } = await import('../../src/lib/ai/conflict-prediction');
    const out = await predictConflicts([
      { id: 'a', title: 'A', status: 'todo' },
      { id: 'b', title: 'B', status: 'todo' },
    ]);
    expect(out).toEqual({ conflicts: [] });
  });
});
