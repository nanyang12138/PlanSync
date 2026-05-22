import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * R-098 guard: CLAUDE.md "Comment Templates" header sentence must be the
 * corrected single-line version, not the older two-line copy that contained
 * a contradiction.
 *
 * Background (from `syntax-inconsistencies-report.md` item #11):
 *   The original CLAUDE.md "Comment Templates" section opened with
 *     "Three contexts produce comments. Pick the matching template."
 *   then immediately followed up with a blockquote
 *     "> **Why two templates?** Review = judgment ..."
 *   The "three contexts" vs "two templates" copy contradicted each other:
 *   `<decision>` is the third context but is free-form, not a structured
 *   template. New agents tried to fit decisions into a template they could
 *   not find.
 *
 *   R-098's fix is to collapse the header to a single sentence and drop
 *   the blockquote entirely, so the count of contexts and the count of
 *   structured templates are stated together unambiguously.
 *
 *   This test pins the corrected wording so a future doc edit cannot
 *   silently bring back the contradictory copy.
 */

const repoRoot = resolve(__dirname, '../../../..');

function readRepoFile(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), 'utf8');
}

describe('R-098 — CLAUDE.md "Three contexts produce comments" wording', () => {
  const claudeMd = readRepoFile('CLAUDE.md');

  it('uses the corrected single-line wording from fix_steps', () => {
    expect(claudeMd).toContain(
      'Three contexts produce comments — two structured templates and one free-form. Pick the matching format.',
    );
  });

  it('no longer contains the contradictory pre-R-098 copy', () => {
    expect(claudeMd).not.toMatch(/Three contexts produce comments\.\s+Pick the matching template/);
    expect(claudeMd).not.toMatch(/Why two templates\?/);
  });

  it('only states the wording once (no stale duplicate left behind)', () => {
    const matches = claudeMd.match(/Three contexts produce comments/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
