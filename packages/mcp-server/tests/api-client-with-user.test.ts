// R-017: withUser must fail loudly when PLANSYNC_SECRET is not configured.
//
// Previously, ApiClient.withUser silently fell back to the caller's own apiToken
// when delegationSecret was empty. That meant every "delegated" request actually
// ran as the key owner — a hidden privilege escalation / wrong-actor bug. We now
// throw an explicit Error('Delegation requires PLANSYNC_SECRET') so misconfigured
// MCP servers fail loudly instead of producing audit-misleading writes.
import { describe, it, expect } from 'vitest';
import { ApiClient } from '../src/api-client';
import type { McpConfig } from '../src/config';

const baseConfig = (overrides: Partial<McpConfig> = {}): McpConfig => ({
  apiBaseUrl: 'http://localhost:3001',
  apiToken: 'owner-token',
  userName: 'owner',
  delegationSecret: '',
  ...overrides,
});

describe('R-017: ApiClient.withUser requires PLANSYNC_SECRET', () => {
  it('throws when delegationSecret is empty', () => {
    const client = new ApiClient(baseConfig({ delegationSecret: '' }));
    expect(() => client.withUser('genie')).toThrowError(/Delegation requires PLANSYNC_SECRET/);
  });

  it('does NOT silently fall back to the owner apiToken', () => {
    // The pre-fix behaviour returned a working ApiClient that posted as the owner.
    // The post-fix contract is that the call throws synchronously — no partially-
    // configured client must ever be returned.
    const client = new ApiClient(baseConfig({ apiToken: 'owner-token', delegationSecret: '' }));
    let returned: unknown;
    try {
      returned = client.withUser('genie');
    } catch (err) {
      expect((err as Error).message).toMatch(/PLANSYNC_SECRET/);
      returned = undefined;
    }
    expect(returned).toBeUndefined();
  });

  it('succeeds and returns a delegating client when delegationSecret is set', () => {
    const client = new ApiClient(
      baseConfig({ apiToken: 'owner-token', delegationSecret: 'super-secret' }),
    );
    const delegated = client.withUser('genie');
    expect(delegated).toBeInstanceOf(ApiClient);
    expect(delegated).not.toBe(client);
  });
});
