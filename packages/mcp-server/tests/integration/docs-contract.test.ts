/**
 * R-176: docs ↔ tools contract test.
 *
 * Catches the failure mode where a tool gets renamed / removed in
 * `packages/mcp-server/src/tools/*.ts` but CLAUDE.md / AGENTS.md still
 * tell agents (and humans) to call the old name. Before this test, doc
 * drift was only caught when an LLM tried the dead name in production
 * and got "tool not found".
 *
 * Approach: pure static analysis on both sides — no MCP server needed.
 *   - registered set: every `server.tool('plansync_X', ...)` /
 *     `server.registerTool('plansync_X', ...)` call across
 *     `packages/mcp-server/src/tools/*.ts`.
 *   - doc-referenced set: every `plansync_X` that opens an inline code
 *     span in `CLAUDE.md` and `AGENTS.md` at the repo root. The mention
 *     may be followed by call syntax inside the same code span — e.g.
 *     `` `plansync_run({action:"start", ...})` ``,
 *     `` `plansync_task_pack <taskId>` ``,
 *     `` `plansync_project_update { ... }` `` — and the regex still
 *     extracts the bare tool name. The regex also expands the
 *     slash-suffix shorthand the docs use to compress related tools,
 *     e.g. `` `plansync_task_list/show/pack` `` → three names
 *     (`plansync_task_list`, `plansync_task_show`, `plansync_task_pack`).
 *
 * The opening backtick must sit immediately before `plansync_` for a
 * mention to count. That filters out substrings that just happen to
 * contain `plansync_` mid-string — e.g. the Postgres DB name in
 * `` `postgresql://$USER@localhost:15432/plansync_dev` ``, or any
 * `plansync_dev` reference inside a fenced shell snippet — which would
 * otherwise produce false positives.
 *
 * The assertion is one-way: doc ⊆ registered. The reverse direction
 * (an undocumented tool) is a separate concern — some tools are
 * deprecated aliases kept around for one release; CLAUDE.md
 * intentionally only documents the canonical surface.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const TOOLS_DIR = path.join(REPO_ROOT, 'packages', 'mcp-server', 'src', 'tools');
const DOC_FILES = ['CLAUDE.md', 'AGENTS.md'].map((f) => path.join(REPO_ROOT, f));

const TOOL_REGISTRATION_RE = /server\.(?:tool|registerTool)\(\s*'(plansync_[a-z_]+)'/g;
// Matches an inline code span that opens with a `plansync_X` tool name.
//   group 1: bare tool name (e.g. `plansync_task_list`)
//   group 2: optional slash-suffix shorthand (e.g. `/show/pack`)
// The opening backtick MUST sit immediately before `plansync_` so we
// don't pick up incidental occurrences inside URLs / shell snippets.
// After the tool name (and any slash-suffix), arbitrary non-backtick
// content is allowed before the closing backtick — this is how we
// catch call-syntax mentions like `plansync_run({action:"start"})`,
// `plansync_task_pack <taskId>`, `plansync_drift_resolve action=rebind`.
const DOC_MENTION_RE = /`(plansync_[a-z_]+)((?:\/[a-z_]+)+)?[^`]*`/g;

function expandToolMention(base: string, slashSuffixes: string | undefined): string[] {
  const out = [base];
  if (!slashSuffixes) return out;
  // The shorthand replaces the LAST `_segment` of the base with each
  // slash-separated suffix. So `plansync_task_list/show/pack` =>
  //   prefix = "plansync_task_"
  //   suffixes = ["show", "pack"]   (the leading "list" is the base)
  //   => plansync_task_list, plansync_task_show, plansync_task_pack
  const lastUnderscore = base.lastIndexOf('_');
  if (lastUnderscore < 0) return out;
  const prefix = base.slice(0, lastUnderscore + 1);
  for (const suffix of slashSuffixes.split('/').filter(Boolean)) {
    out.push(prefix + suffix);
  }
  return out;
}

function collectRegisteredTools(): Set<string> {
  const all = new Set<string>();
  for (const entry of fs.readdirSync(TOOLS_DIR)) {
    if (!entry.endsWith('.ts')) continue;
    const src = fs.readFileSync(path.join(TOOLS_DIR, entry), 'utf8');
    for (const m of src.matchAll(TOOL_REGISTRATION_RE)) {
      all.add(m[1]);
    }
  }
  return all;
}

function collectDocMentionsFromText(content: string): Set<string> {
  const out = new Set<string>();
  for (const m of content.matchAll(DOC_MENTION_RE)) {
    for (const name of expandToolMention(m[1], m[2])) {
      out.add(name);
    }
  }
  return out;
}

function collectDocMentions(): Map<string, Set<string>> {
  const perFile = new Map<string, Set<string>>();
  for (const filePath of DOC_FILES) {
    const content = fs.readFileSync(filePath, 'utf8');
    perFile.set(path.basename(filePath), collectDocMentionsFromText(content));
  }
  return perFile;
}

describe('R-176: docs ↔ MCP tools contract', () => {
  it('every `plansync_X` mentioned in CLAUDE.md / AGENTS.md is a registered tool', () => {
    const registered = collectRegisteredTools();
    expect(registered.size).toBeGreaterThan(0); // sanity: parsing actually found something
    const perFile = collectDocMentions();
    const missing: Array<{ file: string; tool: string }> = [];
    for (const [file, mentions] of perFile) {
      for (const tool of mentions) {
        if (!registered.has(tool)) missing.push({ file, tool });
      }
    }
    expect(
      missing,
      `Doc references to tools that are not registered:\n${missing
        .map((m) => `  ${m.file}: \`${m.tool}\``)
        .join('\n')}\nRegistered tools at the time of this run:\n  ${[...registered]
        .sort()
        .join('\n  ')}`,
    ).toEqual([]);
  });

  it('parses at least one tool reference out of CLAUDE.md', () => {
    // Guard against the regex silently breaking (e.g. someone reformats
    // CLAUDE.md to use a different quoting style) — if CLAUDE.md ever
    // stops mentioning any tool, the first assertion above would pass
    // vacuously.
    const claudeMd = fs.readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
    expect(collectDocMentionsFromText(claudeMd).size).toBeGreaterThan(10);
  });

  describe('DOC_MENTION_RE — call-syntax forms (regression test for #2911)', () => {
    it('extracts tool name from `plansync_run({action:"start", ...})`', () => {
      const found = collectDocMentionsFromText('Call `plansync_run({action:"start", ...})` next.');
      expect(found.has('plansync_run')).toBe(true);
    });

    it('extracts tool name from `plansync_task_pack <taskId>`', () => {
      const found = collectDocMentionsFromText('Run `plansync_task_pack <taskId>` first.');
      expect(found.has('plansync_task_pack')).toBe(true);
    });

    it('extracts tool name from `plansync_project_update { ... }`', () => {
      const found = collectDocMentionsFromText(
        'Use `plansync_project_update { phase: "active" }`.',
      );
      expect(found.has('plansync_project_update')).toBe(true);
    });

    it('extracts tool name from `plansync_drift_resolve action=rebind`', () => {
      const found = collectDocMentionsFromText('`plansync_drift_resolve action=rebind`');
      expect(found.has('plansync_drift_resolve')).toBe(true);
    });

    it('expands slash-suffix shorthand `plansync_task_list/show/pack`', () => {
      const found = collectDocMentionsFromText('Read-only: `plansync_task_list/show/pack`');
      expect(found.has('plansync_task_list')).toBe(true);
      expect(found.has('plansync_task_show')).toBe(true);
      expect(found.has('plansync_task_pack')).toBe(true);
    });

    it('expands four-segment slash-suffix `plansync_plan_list/show/active/diff`', () => {
      const found = collectDocMentionsFromText('`plansync_plan_list/show/active/diff`');
      expect(found.has('plansync_plan_list')).toBe(true);
      expect(found.has('plansync_plan_show')).toBe(true);
      expect(found.has('plansync_plan_active')).toBe(true);
      expect(found.has('plansync_plan_diff')).toBe(true);
    });

    it('expands `plansync_execution_start/heartbeat/complete`', () => {
      const found = collectDocMentionsFromText(
        '`plansync_execution_start/heartbeat/complete` are deprecated aliases.',
      );
      expect(found.has('plansync_execution_start')).toBe(true);
      expect(found.has('plansync_execution_heartbeat')).toBe(true);
      expect(found.has('plansync_execution_complete')).toBe(true);
    });

    it('handles multiple mentions on a single line', () => {
      const found = collectDocMentionsFromText(
        'Either `plansync_status` or `plansync_project_list` works.',
      );
      expect(found.has('plansync_status')).toBe(true);
      expect(found.has('plansync_project_list')).toBe(true);
    });

    it('does NOT pick up plansync_X embedded mid-URL inside a code span', () => {
      // A backtick must sit immediately before `plansync_` — this guards
      // against false positives like the Postgres DB name appearing in
      // a connection-string code span.
      const found = collectDocMentionsFromText(
        'See `postgresql://$USER@localhost:15432/plansync_dev`.',
      );
      expect(found.has('plansync_dev')).toBe(false);
      expect(found.size).toBe(0);
    });

    it('does NOT pick up plansync_X inside a fenced shell snippet', () => {
      const fenced = '```bash\ncreatedb -p 15432 plansync_dev\n```\n';
      const found = collectDocMentionsFromText(fenced);
      expect(found.has('plansync_dev')).toBe(false);
    });
  });
});
