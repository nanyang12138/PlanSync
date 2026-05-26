/**
 * Closes #1191 — the `bin/plansync --exec` legacy fallback (reachable only
 * with `PLANSYNC_ALLOW_LEGACY_EXEC=1`) used to silently downgrade to a
 * bash-only path that skipped R-062 controls: assignee gating, execution
 * run pre-registration, and exec-scoped API-key issuance. Because the
 * env var could be set by any local caller, the bypass constituted a
 * routine-reachable security boundary.
 *
 * This file pins three structural invariants on `bin/plansync` so a
 * future refactor cannot silently bring the bypass back:
 *
 *   1. The only `--exec` code path delegates to the unified R-062
 *      orchestrator (`packages/cli/src/exec-cli.mjs`). If the file is
 *      missing, the script must fail loud — there is no env var that
 *      re-enables a bash fallback.
 *   2. The legacy inline implementation (manual /pack fetch, inline
 *      drift gate, inline `EXEC_PROMPT` heredoc) is gone. These were
 *      the markers of the bypassed-controls branch; if they ever
 *      reappear, this test fails before the bypass can ship.
 *   3. `PLANSYNC_ALLOW_LEGACY_EXEC` may still be mentioned, but only
 *      inside a deprecation notice that explicitly says the var is no
 *      longer honored. We assert no executable branch consumes it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const BIN_PATH = join(REPO_ROOT, 'bin', 'plansync');
const BIN_SOURCE = readFileSync(BIN_PATH, 'utf8');

describe('bin/plansync legacy /exec bypass — fully removed (closes #1191)', () => {
  it('does not contain the inline /pack fetch that powered the legacy bypass', () => {
    // The bash inline fetch was the entry point of the bypassed-controls
    // path. Its presence in any form means the security-sensitive branch
    // is back and skipping assignee gating + run pre-registration.
    expect(BIN_SOURCE).not.toContain('/tasks/" + process.env._PS_EXEC_TASK_ID + "/pack"');
    expect(BIN_SOURCE).not.toMatch(/Fetching task pack for \$EXEC_TASK_ID/);
  });

  it('does not contain the inline EXEC_PROMPT heredoc that bypassed assignee gating', () => {
    // The bash-side EXEC_PROMPT embedded the task pack JSON inline and
    // told the LLM to call `plansync_execution_start` itself — i.e. no
    // server-side assignee validation, no run pre-registration. The
    // unified orchestrator builds the prompt in JS via buildExecPrompt.
    expect(BIN_SOURCE).not.toMatch(/EXEC_PROMPT="You are PlanSync agent/);
    expect(BIN_SOURCE).not.toContain('Task Pack (from PlanSync):');
  });

  it('does not contain the inline drift gate that ran on a parallel un-gated path', () => {
    // The standalone HAS_DRIFT shell var only existed inside the legacy
    // path; the unified orchestrator handles drift inside exec-cli.mjs.
    expect(BIN_SOURCE).not.toMatch(/HAS_DRIFT=/);
  });

  it('exec-cli.mjs is the ONLY launch path; missing file fails loud (no env-var bypass)', () => {
    // Find the `exec)` case and check that the only `exec` of an engine
    // binary inside it goes through `$LOCAL_NODE_BIN $EXEC_CLI`. The
    // legacy fallback used `exec "$EXEC_BIN" --mcp-config …`.
    const execCaseStart = BIN_SOURCE.indexOf('\n  exec)\n');
    expect(execCaseStart).toBeGreaterThan(0);
    const execCaseEnd = BIN_SOURCE.indexOf('\n    ;;\n', execCaseStart);
    expect(execCaseEnd).toBeGreaterThan(execCaseStart);
    const execCase = BIN_SOURCE.slice(execCaseStart, execCaseEnd);

    // The unified orchestrator is invoked exactly once.
    expect(execCase).toMatch(/exec\s+"\$LOCAL_NODE_BIN"\s+"\$EXEC_CLI"/);

    // No other `exec "$EXEC_BIN" …` lines (the legacy fallback's
    // engine-launch pattern). The unified path delegates engine spawning
    // to exec-cli.mjs in Node, never directly from bash.
    expect(execCase).not.toMatch(/exec\s+"\$EXEC_BIN"/);

    // The fail-loud branch is unconditional on `! -f "$EXEC_CLI"` —
    // it must not be guarded by `PLANSYNC_ALLOW_LEGACY_EXEC` or any
    // sibling env-variable check.
    expect(execCase).toMatch(/if \[ ! -f "\$EXEC_CLI" \]; then[\s\S]*?exit 1\s*\n\s*fi/);
  });

  it('PLANSYNC_ALLOW_LEGACY_EXEC is only referenced in a deprecation/advisory context', () => {
    // We allow the env var name to appear so that operators who set it
    // out of habit get a clear "this is no longer honored" message.
    // What must NOT happen is any branch that *changes behaviour* based
    // on the var (which is what the original bypass did).
    const advisoryPattern =
      /PLANSYNC_ALLOW_LEGACY_EXEC.*?(no longer honored|removed in #1191|was removed)/s;
    if (BIN_SOURCE.includes('PLANSYNC_ALLOW_LEGACY_EXEC')) {
      expect(BIN_SOURCE).toMatch(advisoryPattern);
    }

    // The only legal `if`/`case`/`[[ ]]` that may *test* the variable
    // is the deprecation advisory itself (which prints a warning and
    // falls through — it does NOT branch the launch path). We assert
    // that no test of the variable is followed by `exec ` (legacy
    // launch) or a `TASK_PACK_JSON=` assignment (legacy fetch) within
    // the same `if … fi` block.
    const ifBlockPattern =
      /if\s+\[\s*"\$\{PLANSYNC_ALLOW_LEGACY_EXEC[^"]*"\s*=\s*"1"\s*\]\s*;\s*then([\s\S]*?)\n\s*fi/g;
    for (const match of BIN_SOURCE.matchAll(ifBlockPattern)) {
      const body = match[1] ?? '';
      expect(body).not.toMatch(/^\s*exec\s/m);
      expect(body).not.toMatch(/TASK_PACK_JSON=/);
      expect(body).not.toMatch(/MCP_CONFIG_JSON=/);
    }
  });
});
