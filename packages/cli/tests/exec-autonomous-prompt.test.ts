/**
 * Fix #1436 — Genie autonomous-mode prompt must use the unified
 * `plansync_run({action:"complete", ...})` surface instead of the
 * deprecated `plansync_execution_complete` alias.
 *
 * Background: PR #1271 (R-204) collapsed the three execution_* MCP tools
 * into a single `plansync_run(action, ...)` tool. The autonomous worker
 * path in `commands.ts` was migrated to call `plansync_run({action:"start"})`
 * directly, but `buildAutonomousPrompt` — the prompt the worker hands to
 * the spawned Genie child — still told the LLM to call
 * `plansync_execution_complete` at step 6. Once the deprecated alias is
 * removed (per the R-204 plan: "registered for one release") Genie would
 * have no completion path and the autonomous run would hang until the
 * heartbeat scanner declared it stale.
 *
 * This test pins the prompt to the new surface so the regression cannot
 * sneak back in.
 */
import { describe, it, expect } from 'vitest';
import { buildAutonomousPrompt } from '../src/exec.js';

describe('buildAutonomousPrompt — Genie autonomous-mode prompt (#1436)', () => {
  it('instructs Genie to complete the run via plansync_run({action:"complete"})', () => {
    const prompt = buildAutonomousPrompt('/tmp/plansync-test/.plansync-exec/run-1');
    expect(prompt).toMatch(/plansync_run/);
    expect(prompt).toMatch(/action="complete"/);
  });

  it('does not give a positive instruction to call the deprecated plansync_execution_complete alias', () => {
    const prompt = buildAutonomousPrompt('/tmp/plansync-test/.plansync-exec/run-1');
    // The prompt is allowed to *mention* the legacy alias (e.g. to warn
    // the LLM that it's deprecated), but it must never contain a "Call X"
    // directive that points at the soon-to-be-removed name.
    expect(prompt).not.toMatch(/Call plansync_execution_complete/);
  });

  it('still embeds the worktree dir in the path-isolation block', () => {
    const worktree = '/tmp/plansync-test/.plansync-exec/run-xyz';
    const prompt = buildAutonomousPrompt(worktree);
    expect(prompt).toContain(worktree);
  });
});
