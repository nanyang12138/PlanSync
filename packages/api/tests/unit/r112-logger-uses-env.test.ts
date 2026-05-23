import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../../src/lib/env';
import { logger } from '../../src/lib/logger';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGGER_TS = resolve(__dirname, '../../src/lib/logger.ts');

/**
 * R-112: `logger.ts` must read LOG_LEVEL (and NODE_ENV) off the validated
 * `env` singleton — not raw `process.env` — so a typo (LOG_LEVEL=infoo)
 * fails fast at boot via the zod enum in env.ts instead of silently
 * degrading to pino's default level at runtime.
 *
 * The depends_on chain (R-035 → R-112) tracks the env.ts side of the
 * inventory; this test is the runtime-wiring side: it pins the source
 * to use `env.LOG_LEVEL` / `env.NODE_ENV` and asserts the pino instance
 * built at module load actually picks up the validated level.
 */
describe('R-112 logger sources LOG_LEVEL from env, not process.env', () => {
  it('logger.ts imports the validated env singleton', () => {
    const src = fs.readFileSync(LOGGER_TS, 'utf8');
    expect(src).toMatch(/from\s+['"]\.\/env['"]/);
  });

  it('logger.ts no longer references process.env.LOG_LEVEL', () => {
    const src = fs.readFileSync(LOGGER_TS, 'utf8');
    expect(src).not.toMatch(/process\.env\.LOG_LEVEL/);
  });

  it('logger.ts no longer reads NODE_ENV off process.env (uses env.NODE_ENV)', () => {
    // R-112 widens the scope to all process.env reads in logger.ts; the
    // previous NODE_ENV branch chose pino-pretty transport in dev, and it
    // must now flow through the same validated singleton.
    const src = fs.readFileSync(LOGGER_TS, 'utf8');
    expect(src).not.toMatch(/process\.env\.NODE_ENV/);
    expect(src).toMatch(/env\.NODE_ENV/);
  });

  it('the live pino logger.level reflects env.LOG_LEVEL', () => {
    // The exported logger is constructed at module load. After the fix
    // its `.level` must match the validated `env.LOG_LEVEL` exactly —
    // i.e. one of the four enum values, never an unvalidated string.
    expect(logger.level).toBe(env.LOG_LEVEL);
    expect(['debug', 'info', 'warn', 'error']).toContain(logger.level);
  });
});
