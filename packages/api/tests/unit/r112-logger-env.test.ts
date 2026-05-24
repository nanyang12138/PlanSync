import { describe, expect, it } from 'vitest';
import { env } from '../../src/lib/env';
import { envSchema } from '../../src/lib/env';
import { logger } from '../../src/lib/logger';

/**
 * R-112: `logger` must read LOG_LEVEL from the validated `env` module (R-035),
 * not `process.env.LOG_LEVEL` directly.
 *
 * Two failure modes the prior wiring allowed:
 *   1. A typo like `LOG_LEVL=debug` would silently fall through to the
 *      hard-coded `info` default — the validated env was never consulted.
 *   2. An invalid LOG_LEVEL value (e.g. `verbose`) would NOT be rejected at
 *      startup. Now zod's enum on env.LOG_LEVEL refuses any non-pino level
 *      so misconfiguration fails fast at boot.
 *
 * These assertions pin both directions:
 *   - The live logger's `level` equals `env.LOG_LEVEL` (i.e. the same path
 *     that R-035 already validates).
 *   - `envSchema` rejects unknown LOG_LEVEL values; this guarantees the
 *     logger can never be initialised with a value pino does not understand.
 */
describe('R-112 logger uses validated env.LOG_LEVEL', () => {
  it('logger.level matches env.LOG_LEVEL exactly (no process.env fallback)', () => {
    expect(logger.level).toBe(env.LOG_LEVEL);
  });

  it('env.LOG_LEVEL defaults to a pino-recognised level when LOG_LEVEL is unset', () => {
    expect(['debug', 'info', 'warn', 'error']).toContain(env.LOG_LEVEL);
  });

  it('envSchema rejects an invalid LOG_LEVEL (catches typos at boot)', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://user@localhost:5432/db',
      AUTH_DISABLED: 'false',
      LOG_LEVEL: 'verbose',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === 'LOG_LEVEL');
      expect(issue).toBeDefined();
    }
  });

  it('envSchema accepts each valid LOG_LEVEL value', () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      const result = envSchema.safeParse({
        DATABASE_URL: 'postgresql://user@localhost:5432/db',
        AUTH_DISABLED: 'false',
        LOG_LEVEL: level,
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.LOG_LEVEL).toBe(level);
    }
  });
});
