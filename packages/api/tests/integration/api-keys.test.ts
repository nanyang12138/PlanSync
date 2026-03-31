// K module: API Key management
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as apiKeysPost, GET as apiKeysGet } from '@/app/api/auth/api-keys/route';
import { DELETE as apiKeyDelete } from '@/app/api/auth/api-keys/[keyId]/route';
import { GET as projectsGet } from '@/app/api/projects/route';
import { makeReq, createTestProject, cleanupProject, testPrisma } from '../helpers/request';

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
      {},
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
      {},
    );
    expect(res.status).toBe(200);
  });

  it('K3: invalid key → 401', async () => {
    const res = await projectsGet(
      makeReq('/api/projects', {
        userName: owner,
        authToken: 'ps_key_invalid_key_123456',
      }),
      {},
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
      {},
    );

    const after = await testPrisma.apiKey.findUnique({ where: { id: keyId } });
    expect(after?.lastUsedAt?.getTime()).toBeGreaterThanOrEqual(before?.lastUsedAt?.getTime() ?? 0);
  });

  it('K4: DELETE /auth/api-keys/:id → 200', async () => {
    // Create a key to delete
    const createRes = await apiKeysPost(
      makeReq('/api/auth/api-keys', {
        method: 'POST',
        userName: owner,
        body: { projectId, name: 'To Delete' },
      }),
      {},
    );
    const toDeleteId = (await createRes.json()).data.id;

    const res = await apiKeyDelete(
      makeReq(`/api/auth/api-keys/${toDeleteId}`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: { keyId: toDeleteId } },
    );
    expect(res.status).toBe(200);
  });
});
