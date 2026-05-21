import { describe, it, expect } from 'vitest';
import { envSchema } from '../../src/lib/env';

const baseValid = {
  DATABASE_URL: 'postgresql://user@localhost:5432/db',
  AUTH_DISABLED: 'false',
};

describe('env validation — PLANSYNC_SECRET production guard (R-010)', () => {
  it('accepts a missing PLANSYNC_SECRET in development', () => {
    const result = envSchema.safeParse({ ...baseValid, NODE_ENV: 'development' });
    expect(result.success).toBe(true);
  });

  it('accepts a missing PLANSYNC_SECRET in test', () => {
    const result = envSchema.safeParse({ ...baseValid, NODE_ENV: 'test' });
    expect(result.success).toBe(true);
  });

  it('accepts the legacy "dev-secret" value in development (back-compat)', () => {
    const result = envSchema.safeParse({
      ...baseValid,
      NODE_ENV: 'development',
      PLANSYNC_SECRET: 'dev-secret',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing PLANSYNC_SECRET in production', () => {
    const result = envSchema.safeParse({ ...baseValid, NODE_ENV: 'production' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === 'PLANSYNC_SECRET');
      expect(issue).toBeDefined();
      expect(issue!.message).toMatch(/required in production/);
    }
  });

  it('rejects the literal "dev-secret" default in production', () => {
    const result = envSchema.safeParse({
      ...baseValid,
      NODE_ENV: 'production',
      PLANSYNC_SECRET: 'dev-secret',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const matched = result.error.issues.some(
        (i) => i.path[0] === 'PLANSYNC_SECRET' && /dev-secret/.test(i.message),
      );
      expect(matched).toBe(true);
    }
  });

  it('rejects a short PLANSYNC_SECRET (<32 chars) in production', () => {
    const result = envSchema.safeParse({
      ...baseValid,
      NODE_ENV: 'production',
      PLANSYNC_SECRET: 'too-short-secret-value',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const matched = result.error.issues.some(
        (i) => i.path[0] === 'PLANSYNC_SECRET' && /at least 32 characters/.test(i.message),
      );
      expect(matched).toBe(true);
    }
  });

  it('accepts a strong PLANSYNC_SECRET (>=32 chars, not default) in production', () => {
    const result = envSchema.safeParse({
      ...baseValid,
      NODE_ENV: 'production',
      PLANSYNC_SECRET: 'a'.repeat(64),
    });
    expect(result.success).toBe(true);
  });
});
