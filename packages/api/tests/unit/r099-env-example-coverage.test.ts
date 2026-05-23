import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const ENV_EXAMPLE = resolve(REPO_ROOT, '.env.example');
const ENV_TS = resolve(REPO_ROOT, 'packages/api/src/lib/env.ts');

/**
 * R-099: `.env.example` must document every env variable declared in env.ts.
 *
 * Background: env.ts is the runtime inventory of every PlanSync env var. Any
 * variable validated there but missing from .env.example causes operators to
 * miss configuration knobs (the prior occurrences were PLANSYNC_SECRET,
 * AUTH_DISABLED, the AI keys, and the EMAIL_* family — see R-035 for the
 * env.ts side of the fix).
 *
 * Strategy: extract the literal keys from env.ts's z.object({...}) declaration
 * (we only need quoted property names; the schema authors all use bare
 * `KEY: z....` so we anchor on the upper-snake-case identifier followed by ':')
 * and assert each appears in .env.example either as `KEY=` or `# KEY=`.
 */
function extractEnvTsKeys(source: string): string[] {
  const keys = new Set<string>();
  const re = /^\s*([A-Z][A-Z0-9_]+)\s*:\s*z\./gm;
  for (const m of source.matchAll(re)) {
    keys.add(m[1]);
  }
  return [...keys].sort();
}

function envExampleHasKey(content: string, key: string): boolean {
  const re = new RegExp(`^\\s*#?\\s*${key}\\s*=`, 'm');
  return re.test(content);
}

describe('R-099 .env.example covers all env.ts variables', () => {
  it('every env.ts key appears (set or commented) in .env.example', () => {
    const envTsSource = fs.readFileSync(ENV_TS, 'utf8');
    const envExample = fs.readFileSync(ENV_EXAMPLE, 'utf8');

    const keys = extractEnvTsKeys(envTsSource);
    expect(keys.length, 'env.ts must declare at least one variable').toBeGreaterThan(0);

    const missing = keys.filter((k) => !envExampleHasKey(envExample, k));
    expect(missing, `.env.example missing keys declared in env.ts: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('specifically documents the keys called out in R-099', () => {
    const envExample = fs.readFileSync(ENV_EXAMPLE, 'utf8');
    const required = [
      'PLANSYNC_SECRET',
      'AUTH_DISABLED',
      'LLM_API_KEY',
      'LLM_API_BASE',
      'ANTHROPIC_API_KEY',
      'EMAIL_FROM',
      'EMAIL_DOMAIN',
      'EMAIL_SENDMAIL',
    ];
    const missing = required.filter((k) => !envExampleHasKey(envExample, k));
    expect(missing).toEqual([]);
  });
});
