/**
 * Repo-root .env loader for worker-side scripts.
 *
 * Same semantics as bash `set -a; . .env; set +a`:
 *   - existing process.env values WIN (env > .env)
 *   - quoted values have their surrounding quotes stripped
 *   - escapes are not interpreted
 *   - blank / comment-only lines are skipped
 *
 * Pulled out of run-worker.ts so worker-env-setup.ts (loaded via
 * `node --require`) can run it BEFORE applying its env defaults.
 * #571 / #572 / #605 / #608: the previous version of worker-env-setup.ts
 * applied PLANSYNC_EVENT_BUS=postgres in --require land, which fired
 * before run-worker.ts's dotenv preamble. If `.env` set
 * PLANSYNC_EVENT_BUS=memory, the preamble's "env wins over .env" rule
 * meant the file value was silently overwritten by the default.
 *
 * The fix is to load .env in --require land too, so the order is:
 *   1. existing env (from the operator's shell)
 *   2. .env file (filling in unset values)
 *   3. worker defaults (only when still unset)
 *
 * Idempotent — calling it twice is harmless.
 */
import path from 'node:path';
import fs from 'node:fs';

export function loadRepoDotenv(): void {
  // From packages/api/scripts/* the repo root is three levels up.
  const rootEnv = path.resolve(__dirname, '../../../.env');
  if (!fs.existsSync(rootEnv)) return;
  const text = fs.readFileSync(rootEnv, 'utf-8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
