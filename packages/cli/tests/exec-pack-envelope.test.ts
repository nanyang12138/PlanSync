/**
 * Closes #725 / #735 / #737 / #739 — every PlanSync REST route wraps
 * its successful response as `{ data: ... }`, including
 * `/api/projects/:projectId/tasks/:taskId/pack`. Pre-fix, both
 * `/exec` entry points (CLI `/exec` slash command at `exec.ts` and
 * `bin/plansync --exec` orchestrator at `exec-cli.mjs`) used the
 * raw response object directly, so:
 *
 *   - `openDriftAlerts(response).length === 0` was always true →
 *     drift gate silently failed even on a high-severity drift.
 *   - `response.task.assignee` was undefined → assignee gating ran
 *     against an empty record and rejected every legitimate task.
 *   - `buildExecPrompt({ taskPack: response, … })` dumped the
 *     wrapper as JSON, so the LLM saw `{"data":{…}}` instead of the
 *     actual pack.
 *
 * The fix routes every reader through `unwrapTaskPack`, which is
 * a no-op on a bare pack and unwraps the `.data` field when present.
 */
import { describe, it, expect } from 'vitest';
import { unwrapTaskPack, openDriftAlerts, buildExecPrompt } from '../src/exec-shared.mjs';

const BARE_PACK = {
  task: { id: 't1', title: 'T1', assignee: 'alice', assigneeType: 'human' },
  driftAlerts: [
    { status: 'open', reason: 'plan v2 changed scope' },
    { status: 'resolved', reason: 'rebound earlier' },
  ],
};

const WRAPPED_PACK = { data: BARE_PACK };

describe('unwrapTaskPack — accepts both bare and { data: ... } shapes', () => {
  it('returns the bare pack untouched when no envelope present', () => {
    expect(unwrapTaskPack(BARE_PACK)).toBe(BARE_PACK);
  });

  it('returns response.data when the envelope is present', () => {
    expect(unwrapTaskPack(WRAPPED_PACK)).toBe(BARE_PACK);
  });

  it('does not unwrap a non-object data field', () => {
    // The route always wraps with an object on success; if `data` is
    // a primitive (e.g. an error envelope built differently), we
    // pass through rather than guessing.
    expect(unwrapTaskPack({ data: 'string-value' })).toEqual({ data: 'string-value' });
    expect(unwrapTaskPack({ data: null })).toEqual({ data: null });
    expect(unwrapTaskPack({ data: undefined })).toEqual({ data: undefined });
  });

  it('passes through null / non-object inputs unchanged', () => {
    expect(unwrapTaskPack(null)).toBe(null);
    expect(unwrapTaskPack(undefined)).toBe(undefined);
    expect(unwrapTaskPack(42)).toBe(42);
    expect(unwrapTaskPack('not-an-object')).toBe('not-an-object');
  });
});

describe('openDriftAlerts — drift gate is robust to envelope shape', () => {
  it('produces the same list for bare pack and wrapped pack (closes #725)', () => {
    const fromBare = openDriftAlerts(BARE_PACK);
    const fromWrapped = openDriftAlerts(WRAPPED_PACK);
    expect(fromBare).toHaveLength(1);
    expect(fromWrapped).toHaveLength(1);
    // Same first reason confirms the wrapped path went through unwrap.
    expect(fromBare[0]?.reason).toBe('plan v2 changed scope');
    expect(fromWrapped[0]?.reason).toBe('plan v2 changed scope');
  });

  it('was empty pre-fix on the wrapped shape (regression direction)', () => {
    // We can prove the regression direction is not silent by asserting
    // that `response.driftAlerts` (top-level on the wrapper) is
    // undefined — i.e. the pre-fix code path had nothing to filter.
    expect((WRAPPED_PACK as { driftAlerts?: unknown }).driftAlerts).toBeUndefined();
    // And the post-fix function still finds the alert.
    expect(openDriftAlerts(WRAPPED_PACK)).toHaveLength(1);
  });
});

describe('buildExecPrompt — embeds the unwrapped pack (closes #735 #739)', () => {
  it('renders the task fields verbatim from a wrapped response', () => {
    const prompt = buildExecPrompt({ taskId: 't1', taskPack: WRAPPED_PACK });
    // Wrapper key MUST NOT appear in the rendered JSON — that's the
    // smoking-gun regression test. Pre-fix, the prompt contained
    // `"data": { "task": ... }`.
    expect(prompt).not.toMatch(/"data"\s*:/);
    expect(prompt).toContain('"task"');
    expect(prompt).toContain('"assignee": "alice"');
  });

  it('still renders correctly when given a bare pack', () => {
    const prompt = buildExecPrompt({ taskId: 't1', taskPack: BARE_PACK });
    expect(prompt).toContain('"assignee": "alice"');
    expect(prompt).not.toMatch(/"data"\s*:/);
  });
});
