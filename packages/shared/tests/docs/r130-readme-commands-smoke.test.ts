import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * R-130 guard: every executable command example shown in the user-facing
 * README files must point at a file that actually exists in the repo, and
 * every shell script referenced there must parse with `bash -n`.
 *
 * Background:
 *   The README and its Chinese mirror list a handful of "copy/paste this"
 *   commands (`./bin/ps-admin start`, `bash scripts/build.sh`, etc.).
 *   Until R-096 there were stale references to scripts that no longer
 *   existed; R-130 widens that guard into a positive assertion — every
 *   `./bin/X` and `bash scripts/X.sh` mentioned inside a fenced bash/text
 *   block must resolve to a file on disk, otherwise the onboarding flow
 *   silently breaks for new users.
 *
 *   The test deliberately stays a smoke test:
 *     - It parses fenced code blocks (```bash ... ``` / ```text ... ```)
 *       inside the README files; commented-out or prose-only references
 *       are ignored on purpose.
 *     - It only checks files we ship in the repo. Commands that just run
 *       system tools (`cp`, `psql`, `$EDITOR`, `cd`) are not validated.
 *     - For shell scripts we additionally run `bash -n` to catch obvious
 *       syntax regressions without actually executing the script.
 */

const repoRoot = resolve(__dirname, '../../../..');
const readmes = ['README.md', 'README.zh-CN.md'];

interface CommandReference {
  source: string;
  raw: string;
  relPath: string;
}

function readRepoFile(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), 'utf8');
}

function extractFencedBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const fenceRegex = /```([^\n]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(markdown)) !== null) {
    const lang = match[1].trim().toLowerCase();
    if (lang === '' || lang === 'bash' || lang === 'sh' || lang === 'shell' || lang === 'text') {
      blocks.push(match[2]);
    }
  }
  return blocks;
}

function extractCommandRefs(source: string, blocks: string[]): CommandReference[] {
  const refs: CommandReference[] = [];
  // Matches either:
  //   ./bin/<name>           (with optional args)
  //   bash scripts/<name>.sh (with optional args)
  //   scripts/<name>.sh
  // We anchor the path part so trailing args don't pollute relPath.
  const patterns: RegExp[] = [
    /\.\/(bin\/[a-zA-Z0-9._-]+)/g,
    /\bbash\s+(scripts\/[a-zA-Z0-9._-]+\.sh)/g,
    /(?<![\w./])(scripts\/[a-zA-Z0-9._-]+\.sh)/g,
  ];

  for (const block of blocks) {
    // Skip lines that look like shell comments to avoid false positives.
    const meaningful = block
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(meaningful)) !== null) {
        refs.push({ source, raw: m[0], relPath: m[1] });
      }
    }
  }
  return refs;
}

describe('R-130 — README command examples reference real files', () => {
  const fileToSources = new Map<string, Set<string>>();

  for (const readme of readmes) {
    const content = readRepoFile(readme);
    const blocks = extractFencedBlocks(content);
    const refs = extractCommandRefs(readme, blocks);
    for (const ref of refs) {
      if (!fileToSources.has(ref.relPath)) {
        fileToSources.set(ref.relPath, new Set());
      }
      fileToSources.get(ref.relPath)!.add(ref.source);
    }
  }

  it('at least one command reference was extracted (smoke test sanity check)', () => {
    // The README has been documenting bin/* and scripts/* helpers since v0.1.
    // If this assertion ever fails, the extractor is likely broken — not the
    // README being legitimately empty.
    expect(fileToSources.size).toBeGreaterThan(0);
  });

  it('every ./bin/* and scripts/*.sh reference in the README points to an existing file', () => {
    const missing: string[] = [];
    for (const [relPath, sources] of fileToSources) {
      const absPath = resolve(repoRoot, relPath);
      if (!existsSync(absPath)) {
        missing.push(`${relPath} (referenced in ${[...sources].join(', ')})`);
      }
    }
    expect(
      missing,
      `README references files that do not exist in the repo:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('shell scripts referenced in the README pass `bash -n` syntax check', () => {
    const broken: string[] = [];
    for (const [relPath] of fileToSources) {
      if (!relPath.endsWith('.sh')) continue;
      const absPath = resolve(repoRoot, relPath);
      if (!existsSync(absPath)) continue; // covered by the previous test
      const result = spawnSync('bash', ['-n', absPath], { encoding: 'utf8' });
      if (result.status !== 0) {
        broken.push(`${relPath}: ${result.stderr.trim() || `exit ${result.status}`}`);
      }
    }
    expect(broken, `shell scripts with syntax errors:\n  ${broken.join('\n  ')}`).toEqual([]);
  });

  it('bin/* launchers referenced in the README are executable files', () => {
    const issues: string[] = [];
    for (const [relPath] of fileToSources) {
      if (!relPath.startsWith('bin/')) continue;
      const absPath = resolve(repoRoot, relPath);
      if (!existsSync(absPath)) continue;
      const st = statSync(absPath);
      if (!st.isFile()) {
        issues.push(`${relPath} is not a regular file`);
        continue;
      }
      // POSIX exec bit on owner. We use the explicit mode check rather than
      // fs.constants.X_OK so the failure message is deterministic across
      // platforms (and so we surface checked-in non-exec files instead of
      // depending on the runner's identity).
      const mode = st.mode & 0o111;
      if (mode === 0) {
        issues.push(`${relPath} is checked in without the executable bit`);
      }
    }
    expect(issues, `bin launchers with wrong filesystem state:\n  ${issues.join('\n  ')}`).toEqual(
      [],
    );
  });

  it('known anchor commands are still mentioned in the English README', () => {
    // Lightweight regression catch: if someone removes the canonical commands
    // entirely, this test reminds them to update the smoke test alongside.
    const englishReadme = readRepoFile('README.md');
    const anchors = ['./bin/ps-admin', './bin/plansync', 'bash scripts/build.sh'];
    for (const anchor of anchors) {
      expect(
        englishReadme.includes(anchor),
        `README.md no longer documents \`${anchor}\`; update the smoke test if intentional`,
      ).toBe(true);
    }
  });
});
