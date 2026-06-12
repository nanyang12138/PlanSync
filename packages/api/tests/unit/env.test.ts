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

describe('env validation — AUTH_DISABLED production guard', () => {
  // A strong secret so the superRefine block doesn't short-circuit on the
  // PLANSYNC_SECRET check (it `return`s early when the secret is missing).
  const strongSecret = 'a'.repeat(64);

  it('accepts AUTH_DISABLED=true in development', () => {
    const result = envSchema.safeParse({
      ...baseValid,
      NODE_ENV: 'development',
      AUTH_DISABLED: 'true',
    });
    expect(result.success).toBe(true);
  });

  it('rejects AUTH_DISABLED=true in production', () => {
    const result = envSchema.safeParse({
      ...baseValid,
      NODE_ENV: 'production',
      PLANSYNC_SECRET: strongSecret,
      AUTH_DISABLED: 'true',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === 'AUTH_DISABLED');
      expect(issue).toBeDefined();
      expect(issue!.message).toMatch(/forbidden in production/);
    }
  });

  it('accepts AUTH_DISABLED=false in production (with a strong secret)', () => {
    const result = envSchema.safeParse({
      ...baseValid,
      NODE_ENV: 'production',
      PLANSYNC_SECRET: strongSecret,
      AUTH_DISABLED: 'false',
    });
    expect(result.success).toBe(true);
  });
});

describe('env validation — runtime env vars (R-035)', () => {
  it('accepts AI provider env vars (LLM_API_KEY / LLM_API_BASE / ANTHROPIC_API_KEY)', () => {
    const result = envSchema.safeParse({
      ...baseValid,
      LLM_API_KEY: 'k-abc',
      LLM_API_BASE: 'https://llm-api.amd.com/Anthropic',
      LLM_MODEL_NAME: 'Claude-Sonnet-4.5',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-20250514',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Foo=bar',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.LLM_API_KEY).toBe('k-abc');
      expect(result.data.LLM_API_BASE).toBe('https://llm-api.amd.com/Anthropic');
      expect(result.data.ANTHROPIC_API_KEY).toBe('sk-ant-test');
    }
  });

  it('accepts email env vars (EMAIL_FROM / EMAIL_DOMAIN / EMAIL_SENDMAIL)', () => {
    const result = envSchema.safeParse({
      ...baseValid,
      EMAIL_FROM: 'plansync@example.com',
      EMAIL_DOMAIN: 'example.com',
      EMAIL_SENDMAIL: '/usr/sbin/sendmail',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.EMAIL_FROM).toBe('plansync@example.com');
      expect(result.data.EMAIL_SENDMAIL).toBe('/usr/sbin/sendmail');
    }
  });

  it('treats AI/email env vars as optional (all unset is valid)', () => {
    const result = envSchema.safeParse(baseValid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.LLM_API_KEY).toBeUndefined();
      expect(result.data.ANTHROPIC_API_KEY).toBeUndefined();
      expect(result.data.EMAIL_FROM).toBeUndefined();
      expect(result.data.EMAIL_SENDMAIL).toBeUndefined();
    }
  });

  it('rejects malformed LLM_API_BASE URL', () => {
    const result = envSchema.safeParse({
      ...baseValid,
      LLM_API_BASE: 'not-a-url',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === 'LLM_API_BASE');
      expect(issue).toBeDefined();
    }
  });

  it('rejects empty-string optional secrets (must be either unset or non-empty)', () => {
    const result = envSchema.safeParse({
      ...baseValid,
      LLM_API_KEY: '',
    });
    expect(result.success).toBe(false);
  });
});
