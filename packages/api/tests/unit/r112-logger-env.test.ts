import { describe, it, expect } from 'vitest';

/**
 * R-112: logger must read LOG_LEVEL / NODE_ENV from the validated `env` helper
 * instead of reading `process.env` directly. The setup file (tests/setup.ts)
 * pre-sets:
 *   LOG_LEVEL = 'error'
 *   NODE_ENV  = 'test'
 * so importing the logger here should yield a pino instance whose `level`
 * tracks `env.LOG_LEVEL`. If logger.ts were still reading raw process.env it
 * would still happen to be 'error' here — but env.ts also rejects values
 * outside the enum, which is the load-bearing behaviour this rewires onto.
 */
describe('logger — env-derived LOG_LEVEL / NODE_ENV (R-112)', () => {
  it('logger.level equals env.LOG_LEVEL', async () => {
    const { logger } = await import('../../src/lib/logger');
    const { env } = await import('../../src/lib/env');
    expect(logger.level).toBe(env.LOG_LEVEL);
    expect(logger.level).toBe('error');
  });

  it('env.NODE_ENV is "test" in this suite — pino-pretty transport is not active', async () => {
    const { env } = await import('../../src/lib/env');
    expect(env.NODE_ENV).toBe('test');
  });

  it('logger.ts no longer references process.env (regression guard)', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(__dirname, '../../src/lib/logger.ts'),
      'utf8',
    );
    // The comment block intentionally mentions `process.env` in prose to
    // explain the migration; strip line comments before asserting no live
    // `process.env.LOG_LEVEL` / `process.env.NODE_ENV` references remain.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(codeOnly).not.toMatch(/process\.env\.LOG_LEVEL/);
    expect(codeOnly).not.toMatch(/process\.env\.NODE_ENV/);
    expect(src).toMatch(/from\s+['"]\.\/env['"]/);
    expect(src).toMatch(/env\.LOG_LEVEL/);
    expect(src).toMatch(/env\.NODE_ENV/);
  });

  it('envSchema rejects LOG_LEVEL outside the enum (fail-fast guard env.ts already owns)', async () => {
    const { envSchema } = await import('../../src/lib/env');
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
});
