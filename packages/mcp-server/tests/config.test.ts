// U module: MCP server config loading
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { loadConfig } from '../src/config';

describe('U: MCP Server Config (loadConfig)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Ensure a valid token by default so individual tests focus on what they
    // claim to test, not on R-040's token-presence requirement.
    process.env.PLANSYNC_API_KEY = 'test-key';
  });

  afterEach(() => {
    // Restore env vars
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  it('U3: no env → apiBaseUrl defaults to http://localhost:3001', () => {
    delete process.env.PLANSYNC_API_URL;
    const config = loadConfig();
    expect(config.apiBaseUrl).toBe('http://localhost:3001');
  });

  it('U5: no PORT env → default port 3001 in apiBaseUrl', () => {
    delete process.env.PLANSYNC_API_URL;
    const config = loadConfig();
    expect(config.apiBaseUrl).toContain('3001');
  });

  it('PLANSYNC_API_URL env is used as apiBaseUrl', () => {
    process.env.PLANSYNC_API_URL = 'http://custom-host:4000';
    const config = loadConfig();
    expect(config.apiBaseUrl).toBe('http://custom-host:4000');
  });

  it('config has apiBaseUrl, apiToken, userName fields', () => {
    const config = loadConfig();
    expect(typeof config.apiBaseUrl).toBe('string');
    expect(typeof config.apiToken).toBe('string');
    expect(typeof config.userName).toBe('string');
  });

  // R-040 ---------------------------------------------------------------
  describe('R-040: PLANSYNC_API_KEY presence validation', () => {
    it('throws with actionable message when PLANSYNC_API_KEY is unset', () => {
      delete process.env.PLANSYNC_API_KEY;
      delete process.env.AUTH_DISABLED;
      expect(() => loadConfig()).toThrowError(/PLANSYNC_API_KEY is not set/);
      expect(() => loadConfig()).toThrowError(/bin\/plansync/);
    });

    it('throws when PLANSYNC_API_KEY is an empty string', () => {
      process.env.PLANSYNC_API_KEY = '';
      delete process.env.AUTH_DISABLED;
      expect(() => loadConfig()).toThrowError(/PLANSYNC_API_KEY is not set/);
    });

    it('does NOT throw when PLANSYNC_API_KEY is set to a non-empty value', () => {
      process.env.PLANSYNC_API_KEY = 'sk_live_abc';
      delete process.env.AUTH_DISABLED;
      const cfg = loadConfig();
      expect(cfg.apiToken).toBe('sk_live_abc');
    });

    it('skips the check when AUTH_DISABLED=true (local-dev / test escape hatch)', () => {
      delete process.env.PLANSYNC_API_KEY;
      process.env.AUTH_DISABLED = 'true';
      const cfg = loadConfig();
      expect(cfg.apiToken).toBe('');
    });

    it('still enforces the check when AUTH_DISABLED is any value other than "true"', () => {
      delete process.env.PLANSYNC_API_KEY;
      process.env.AUTH_DISABLED = 'false';
      expect(() => loadConfig()).toThrowError(/PLANSYNC_API_KEY is not set/);

      process.env.AUTH_DISABLED = '1';
      expect(() => loadConfig()).toThrowError(/PLANSYNC_API_KEY is not set/);
    });
  });
});
