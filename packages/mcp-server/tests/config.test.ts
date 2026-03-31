// U module: MCP server config loading
import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig } from '../src/config';

describe('U: MCP Server Config (loadConfig)', () => {
  const originalEnv = { ...process.env };

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
});
