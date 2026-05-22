import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * R-097 guard: CLAUDE.md must not promise that `plansync_task_update` is
 * partially allowed in execution mode.
 *
 * Background:
 *   The MCP server in `packages/mcp-server/src/index.ts` defines an
 *   `EXEC_ALLOWED` whitelist. Tools missing from that set are not even
 *   registered when the server boots in exec mode — calling them yields a
 *   bare "tool not found" error. `plansync_task_update` is intentionally
 *   blocked there (status changes happen via `plansync_execution_complete`).
 *
 *   Until R-097 the table row in CLAUDE.md described `plansync_task_update`
 *   as "Blocked … (status field on the assigned task is allowed via the
 *   runtime; other writes are owner-only)" — a partial-allow promise the
 *   runtime never honoured. Agents that took the doc at face value
 *   crashed with `tool not found`.
 *
 *   This test pins the two sources together so the false promise cannot
 *   silently regress:
 *     1. EXEC_ALLOWED in index.ts must NOT contain `plansync_task_update`.
 *     2. CLAUDE.md must NOT contain either the partial-allow caveat or the
 *        "other writes are owner-only" follow-up; the tool must still be
 *        listed in the Blocked row.
 */

const repoRoot = resolve(__dirname, '../../../..');

function readRepoFile(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), 'utf8');
}

function parseExecAllowed(source: string): Set<string> {
  const start = source.indexOf('const EXEC_ALLOWED = new Set([');
  if (start < 0) throw new Error('EXEC_ALLOWED literal not found in index.ts');
  const end = source.indexOf(']);', start);
  if (end < 0) throw new Error('EXEC_ALLOWED closing bracket not found');
  const body = source.slice(start, end);
  const names = new Set<string>();
  for (const match of body.matchAll(/'([a-z_]+)'/g)) {
    names.add(match[1]);
  }
  return names;
}

describe('R-097 — CLAUDE.md exec-mode tool table matches EXEC_ALLOWED', () => {
  const claudeMd = readRepoFile('CLAUDE.md');
  const indexTs = readRepoFile('packages/mcp-server/src/index.ts');
  const execAllowed = parseExecAllowed(indexTs);

  it('EXEC_ALLOWED whitelist excludes plansync_task_update', () => {
    expect(execAllowed.has('plansync_task_update')).toBe(false);
    // Sanity: the lifecycle tools that should be allowed are still there.
    expect(execAllowed.has('plansync_execution_start')).toBe(true);
    expect(execAllowed.has('plansync_execution_complete')).toBe(true);
  });

  it('CLAUDE.md no longer claims task_update is partially allowed in exec mode', () => {
    expect(claudeMd).not.toMatch(
      /status field on the assigned task is allowed via the runtime/,
    );
    expect(claudeMd).not.toMatch(/other writes are owner-only/);
  });

  it('CLAUDE.md still lists plansync_task_update among the Blocked tools', () => {
    const blockedRow = claudeMd
      .split('\n')
      .find((line) => line.includes('**Blocked**'));
    expect(blockedRow, 'Blocked row missing from exec-mode tool table').toBeTruthy();
    const row = blockedRow as string;
    expect(row).toContain('plansync_task_update');
    expect(row).toContain('plansync_task_create');
    expect(row).toContain('plansync_plan_create');
  });
});
