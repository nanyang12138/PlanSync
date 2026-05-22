import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * R-096 guard: the README files used to advertise two helper scripts
 * (`scripts/demo-terminal.sh` and `scripts/demo-webui.js`) that have
 * never existed in this repo. Pointing users at non-existent scripts
 * eroded trust in the onboarding flow.
 *
 * If you re-introduce these scripts, also re-introduce the references
 * here AND drop this test.
 */

const repoRoot = resolve(__dirname, '../../../..');
const readmes = ['README.md', 'README.zh-CN.md'];

const forbiddenSnippets = ['demo-terminal.sh', 'demo-webui.js'];

describe('R-096 — README does not reference non-existent demo scripts', () => {
  for (const readme of readmes) {
    it(`${readme} contains no stale demo-script references`, () => {
      const content = readFileSync(resolve(repoRoot, readme), 'utf8');
      for (const snippet of forbiddenSnippets) {
        expect(
          content.includes(snippet),
          `${readme} should not reference ${snippet}; the script does not exist in this repo`,
        ).toBe(false);
      }
    });
  }
});
