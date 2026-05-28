/**
 * Issue #2756 regression-prevention pin.
 *
 * Context: in PR #2755 (R-205 — collapse `plansync_task_*` into a unified
 * `plansync_task(action, ...)` tool) cursor-review flagged that simply
 * adding `plansync_task` to `EXEC_ALLOWED` would silently re-open
 * `update` / `claim` / `decline` to exec-scoped MCP sessions whenever
 * the per-call FSM is bypassed — i.e. in the default deploy where
 * `PLANSYNC_EXEC_STATE_ENFORCE=off` or `PLANSYNC_SECRET` is unset. That
 * is a quiet permission-boundary regression: pre-R-205 the only
 * task-write reachable from exec scope was `plansync_task_rebind`, and
 * the new unified surface must preserve that boundary.
 *
 * These tests pin the allowlists so any future patch that widens the
 * exec-mode task-write surface fails CI loudly, forcing the author to
 * add a per-action exec gate (e.g. in `tool-wrapper.ts` or `task-action.ts`)
 * BEFORE registering `plansync_task` for exec scope.
 *
 * The pins are deliberately narrow: they only enforce the task-write
 * subset called out by the finding, plus the related delegation-mode
 * boundary. Read-only task tools and unrelated surfaces are not pinned
 * by this file (other tests cover those).
 */
import { describe, expect, it } from 'vitest';
import { EXEC_ALLOWED, DELEGATION_ALLOWED } from '../src/exec-allowlist';

/** Task-write tool names that must NEVER be exec-reachable without per-action gating. */
const EXEC_FORBIDDEN_TASK_WRITES = [
  'plansync_task_create',
  'plansync_task_update',
  'plansync_task_claim',
  'plansync_task_decline',
] as const;

describe('issue #2756: exec-mode task-write boundary is pinned', () => {
  it('EXEC_ALLOWED contains exactly one task-write tool: plansync_task_rebind', () => {
    const taskWrites = [...EXEC_ALLOWED].filter(
      (name) =>
        name === 'plansync_task_rebind' ||
        EXEC_FORBIDDEN_TASK_WRITES.includes(
          name as (typeof EXEC_FORBIDDEN_TASK_WRITES)[number],
        ),
    );
    expect(taskWrites).toEqual(['plansync_task_rebind']);
  });

  it.each(EXEC_FORBIDDEN_TASK_WRITES)(
    'EXEC_ALLOWED must not include %s (owner-/agent-mode-only)',
    (name) => {
      expect(EXEC_ALLOWED.has(name)).toBe(false);
    },
  );

  it('EXEC_ALLOWED must not include the unified `plansync_task` surface without per-action gating', () => {
    // If a future patch (e.g. R-205 / PR #2755) adds `plansync_task` to
    // `EXEC_ALLOWED`, this test must be updated **only after** the
    // accompanying per-action exec-mode gate (rejecting `action ∈
    // {create, update, claim, decline}` before the handler runs) lands
    // in `tool-wrapper.ts` or the new `task-action.ts`. Editing this
    // assertion without that gate would silently regress the boundary
    // described by issue #2756.
    expect(EXEC_ALLOWED.has('plansync_task')).toBe(false);
  });

  it('plansync_task_rebind stays exec-allowed (the one supported drift-resolution write)', () => {
    expect(EXEC_ALLOWED.has('plansync_task_rebind')).toBe(true);
  });
});

describe('issue #2756: delegation-mode allowlist still permits the per-agent task writes', () => {
  it.each([
    'plansync_task_rebind',
    'plansync_task_update',
    'plansync_task_claim',
    'plansync_task_decline',
  ] as const)('DELEGATION_ALLOWED includes %s', (name) => {
    expect(DELEGATION_ALLOWED.has(name)).toBe(true);
  });

  it('DELEGATION_ALLOWED still excludes plansync_task_create (owner-only)', () => {
    // `create` is a project-shaping write and must remain owner-only
    // even in delegation mode — the API layer also rejects it, but the
    // allowlist provides defence in depth.
    expect(DELEGATION_ALLOWED.has('plansync_task_create')).toBe(false);
  });
});
