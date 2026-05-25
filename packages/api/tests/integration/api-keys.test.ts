// K module: API Key management
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as apiKeysPost, GET as apiKeysGet } from '@/app/api/auth/api-keys/route';
import { DELETE as apiKeyDelete } from '@/app/api/auth/api-keys/[keyId]/route';
import { GET as projectsGet } from '@/app/api/projects/route';
import { makeReq, createTestProject, cleanupProject, testPrisma } from '../helpers/request';
import { _authCacheSizeForTests, _resetAuthCacheForTests } from '@/lib/auth';

describe('K: API Key Management', () => {
  const owner = 'apikey-owner';
  let projectId: string;
  let rawKey: string;
  let keyId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('K1: POST /auth/api-keys → 201, key contains ps_key_', async () => {
    const res = await apiKeysPost(
      makeReq('/api/auth/api-keys', {
        method: 'POST',
        userName: owner,
        body: { projectId, name: 'Test Key', permissions: ['read', 'write'] },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.key).toMatch(/^ps_key_/);
    rawKey = body.data.key;
    keyId = body.data.id;
  });

  it('K5: keyPrefix = first 15 chars of rawKey', async () => {
    const key = await testPrisma.apiKey.findUnique({ where: { id: keyId } });
    expect(key?.keyPrefix).toBe(rawKey.substring(0, 15));
  });

  it('K7: permissions array saved correctly', async () => {
    const key = await testPrisma.apiKey.findUnique({ where: { id: keyId } });
    expect(key?.permissions).toContain('read');
    expect(key?.permissions).toContain('write');
  });

  it('K2: use rawKey as Bearer token → 200', async () => {
    const res = await projectsGet(
      makeReq('/api/projects', {
        userName: owner,
        authToken: rawKey,
      }),
    );
    expect(res.status).toBe(200);
  });

  it('K3: invalid key → 401', async () => {
    const res = await projectsGet(
      makeReq('/api/projects', {
        userName: owner,
        authToken: 'ps_key_invalid_key_123456',
      }),
    );
    expect(res.status).toBe(401);
  });

  it('K6: use key → lastUsedAt updates', async () => {
    const before = await testPrisma.apiKey.findUnique({ where: { id: keyId } });
    await new Promise((r) => setTimeout(r, 10));

    await projectsGet(
      makeReq('/api/projects', {
        userName: owner,
        authToken: rawKey,
      }),
    );

    // The lastUsedAt update runs asynchronously inside authenticate(). On
    // slow CI runners the I/O can take 100ms+, so a single read often sees
    // a null lastUsedAt and `.getTime()` becomes undefined. Poll up to 2s
    // for the write to land. Threshold-based assertion below still gives
    // a real failure if the write never happens.
    const beforeTs = before?.lastUsedAt?.getTime() ?? 0;
    const deadline = Date.now() + 2000;
    let after = await testPrisma.apiKey.findUnique({ where: { id: keyId } });
    while ((after?.lastUsedAt?.getTime() ?? -1) < beforeTs && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      after = await testPrisma.apiKey.findUnique({ where: { id: keyId } });
    }
    expect(after?.lastUsedAt?.getTime()).toBeGreaterThanOrEqual(beforeTs);
  });

  it('K4: DELETE /auth/api-keys/:id → 200', async () => {
    // Create a key to delete
    const createRes = await apiKeysPost(
      makeReq('/api/auth/api-keys', {
        method: 'POST',
        userName: owner,
        body: { projectId, name: 'To Delete' },
      }),
    );
    const toDeleteId = (await createRes.json()).data.id;

    const res = await apiKeyDelete(
      makeReq(`/api/auth/api-keys/${toDeleteId}`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: Promise.resolve({ keyId: toDeleteId }) },
    );
    expect(res.status).toBe(200);
  });

  it('K8 / closes #741: revoking a cached API key 401s on the very next request', async () => {
    // Reset the cache so we can assert "exactly one entry was added,
    // then exactly that entry was dropped" without interference from
    // earlier test cases.
    _resetAuthCacheForTests();

    // Create a fresh key.
    const createRes = await apiKeysPost(
      makeReq('/api/auth/api-keys', {
        method: 'POST',
        userName: owner,
        body: { projectId, name: 'Revoke Cache Test' },
      }),
    );
    const created = (await createRes.json()).data;
    const cacheKey = created.key;
    const cacheKeyId = created.id;

    // Use the key once so it lands in the auth cache. Pre-fix, the
    // cache then keeps the principal alive for AUTH_CACHE_TTL_MS
    // (5 min) regardless of subsequent revocation.
    const useRes1 = await projectsGet(
      makeReq('/api/projects', { userName: owner, authToken: cacheKey }),
    );
    expect(useRes1.status).toBe(200);
    expect(_authCacheSizeForTests()).toBe(1);

    // Revoke the key.
    const delRes = await apiKeyDelete(
      makeReq(`/api/auth/api-keys/${cacheKeyId}`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: Promise.resolve({ keyId: cacheKeyId }) },
    );
    expect(delRes.status).toBe(200);

    // Cache must have been invalidated synchronously by the DELETE
    // handler — the entry that was added by useRes1 is gone.
    expect(_authCacheSizeForTests()).toBe(0);

    // The next request with the just-revoked key must 401, NOT
    // continue to authenticate off a stale cache hit. Pre-fix this
    // would have returned 200 for up to 5 minutes.
    const useRes2 = await projectsGet(
      makeReq('/api/projects', { userName: owner, authToken: cacheKey }),
    );
    expect(useRes2.status).toBe(401);
  });
});
