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
 *   - doc-referenced set: every backtick-wrapped `plansync_X` in
 *     `CLAUDE.md` and `AGENTS.md` at the repo root.
 *
 * Backticks are required for a doc mention to count. That filters out
 * substrings that just happen to start with `plansync_` (e.g. the
 * Postgres DB name `plansync_dev` referenced from a shell snippet in
 * AGENTS.md), which would otherwise produce false positives.
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
const DOC_MENTION_RE = /`(plansync_[a-z_]+)`/g;

function collectMatches(content: string, re: RegExp): Set<string> {
  const out = new Set<string>();
  for (const m of content.matchAll(re)) {
    out.add(m[1]);
  }
  return out;
}

function collectRegisteredTools(): Set<string> {
  const all = new Set<string>();
  for (const entry of fs.readdirSync(TOOLS_DIR)) {
    if (!entry.endsWith('.ts')) continue;
    const src = fs.readFileSync(path.join(TOOLS_DIR, entry), 'utf8');
    for (const name of collectMatches(src, TOOL_REGISTRATION_RE)) {
      all.add(name);
    }
  }
  return all;
}

function collectDocMentions(): Map<string, Set<string>> {
  const perFile = new Map<string, Set<string>>();
  for (const filePath of DOC_FILES) {
    const content = fs.readFileSync(filePath, 'utf8');
    perFile.set(path.basename(filePath), collectMatches(content, DOC_MENTION_RE));
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
    expect(collectMatches(claudeMd, DOC_MENTION_RE).size).toBeGreaterThan(10);
  });
});
