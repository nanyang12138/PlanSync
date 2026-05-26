/**
 * Closes #1205 — the `bin/plansync --exec` legacy fallback (reachable only
 * with `PLANSYNC_ALLOW_LEGACY_EXEC=1`) previously unwrapped the API's
 * `{ data: pack }` envelope ONLY for the drift gate. The `EXEC_PROMPT`
 * still interpolated the raw `${TASK_PACK_JSON}`, so the spawned LLM saw
 * `{"data":{…}}` instead of the actual task pack — leaving #739
 * (PR #1111) unfixed on this code path.
 *
 * The fix unwraps `TASK_PACK_JSON` once, right after fetching, so every
 * downstream consumer (drift gate AND prompt) sees the bare pack. This
 * file tests both halves of the contract:
 *
 *   1. Structural — read `bin/plansync` source and assert the unwrap is
 *      applied BEFORE the `EXEC_PROMPT` heredoc is constructed, so a
 *      future refactor can't silently regress the ordering.
 *   2. Functional — execute the exact inline node snippet from
 *      `bin/plansync` and assert it unwraps `{ data: pack }` while
 *      leaving a bare pack untouched.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const BIN_PATH = join(REPO_ROOT, 'bin', 'plansync');
const BIN_SOURCE = readFileSync(BIN_PATH, 'utf8');

// The exact inline node snippet that `bin/plansync` runs to unwrap the
// task-pack envelope. Indentation matches the bash heredoc exactly so
// the structural test below can byte-compare the two without massaging
// whitespace. If the script ever drifts, the structural assertion fails
// first and points the reader here.
const UNWRAP_SNIPPET = [
  '',
  '      try {',
  '        const raw = process.argv[1] || "{}";',
  '        const wrapper = JSON.parse(raw);',
  '        const pack = (wrapper && typeof wrapper === "object" && wrapper.data && typeof wrapper.data === "object")',
  '          ? wrapper.data',
  '          : wrapper;',
  '        process.stdout.write(JSON.stringify(pack, null, 2));',
  '      } catch { process.stdout.write(process.argv[1] || "{}"); }',
  '    ',
].join('\n');

function runUnwrap(input: string): string {
  const out = spawnSync(process.execPath, ['-e', UNWRAP_SNIPPET, input], {
    encoding: 'utf8',
  });
  expect(out.status).toBe(0);
  return out.stdout;
}

describe('bin/plansync legacy /exec — unwrap is applied before EXEC_PROMPT (closes #1205)', () => {
  it('keeps the inline unwrap snippet in `bin/plansync` byte-identical to the one tested here', () => {
    // If this fails, update UNWRAP_SNIPPET above to match the new
    // implementation. The structural ordering check below depends on it.
    expect(BIN_SOURCE).toContain(UNWRAP_SNIPPET);
  });

  it('unwraps the {data: pack} envelope before EXEC_PROMPT is built', () => {
    // The fix relies on `TASK_PACK_JSON="$(…unwrap…)"` running BEFORE
    // the `EXEC_PROMPT="…${TASK_PACK_JSON}…"` heredoc. If a future
    // refactor moves the unwrap after the prompt construction, the
    // legacy path silently regresses to #739.
    const unwrapIdx = BIN_SOURCE.indexOf(UNWRAP_SNIPPET);
    const promptIdx = BIN_SOURCE.indexOf('Task Pack (from PlanSync):\n${TASK_PACK_JSON}');
    expect(unwrapIdx).toBeGreaterThan(0);
    expect(promptIdx).toBeGreaterThan(0);
    expect(unwrapIdx).toBeLessThan(promptIdx);
  });

  it('legacy bypass advisory still mentions PLANSYNC_ALLOW_LEGACY_EXEC (no accidental rename)', () => {
    // Sanity guard: this fix is meaningful ONLY because the legacy path
    // is reachable. If the bypass env var is renamed without updating
    // the test, the structural checks above could pass against an
    // unreachable branch.
    expect(BIN_SOURCE).toContain('PLANSYNC_ALLOW_LEGACY_EXEC');
  });
});

describe('bin/plansync inline unwrap snippet — functional behaviour', () => {
  it('returns the bare pack JSON when given a {data: pack} envelope', () => {
    const wrapped = JSON.stringify({
      data: {
        task: { id: 't1', assignee: 'alice', assigneeType: 'agent' },
        driftAlerts: [{ status: 'open', reason: 'plan v2 changed scope' }],
      },
    });
    const out = runUnwrap(wrapped);
    // Must NOT carry the wrapper key through to the prompt — that's
    // exactly the bug #1205 was reporting.
    expect(out).not.toMatch(/"data"\s*:/);
    expect(out).toContain('"assignee": "alice"');
    expect(out).toContain('"plan v2 changed scope"');
    // Round-trip: the unwrapped JSON parses to the bare pack object.
    const parsed = JSON.parse(out);
    expect(parsed.task.assignee).toBe('alice');
    expect(parsed.driftAlerts).toHaveLength(1);
  });

  it('passes a bare pack through untouched (test fixtures / future API shape)', () => {
    const bare = JSON.stringify({
      task: { id: 't1', assignee: 'alice', assigneeType: 'agent' },
      driftAlerts: [],
    });
    const out = runUnwrap(bare);
    expect(out).not.toMatch(/"data"\s*:/);
    const parsed = JSON.parse(out);
    expect(parsed.task.assignee).toBe('alice');
  });

  it('does not unwrap when `.data` is a primitive (defensive — not the success shape)', () => {
    const oddShape = JSON.stringify({ data: 'string-value', task: { id: 't1' } });
    const out = runUnwrap(oddShape);
    const parsed = JSON.parse(out);
    // The input is left as-is because `.data` isn't an object envelope.
    expect(parsed.data).toBe('string-value');
    expect(parsed.task.id).toBe('t1');
  });

  it('falls back to the raw input on malformed JSON instead of crashing', () => {
    const out = runUnwrap('not-json{');
    // The bash script must not lose the data — better to embed the raw
    // text than to silently empty the prompt.
    expect(out).toBe('not-json{');
  });
});
