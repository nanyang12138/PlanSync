// S module: Auth
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GET as projectGet } from '@/app/api/projects/[projectId]/route';
import { GET as membersGet } from '@/app/api/projects/[projectId]/members/route';
import { POST as membersPost } from '@/app/api/projects/[projectId]/members/route';
import { POST as loginPost } from '@/app/api/auth/login/route';
import { POST as refreshPost } from '@/app/api/auth/refresh/route';
import { POST as logoutPost } from '@/app/api/auth/logout/route';
import { makeReq, createTestProject, addMember, cleanupProject, testPrisma } from '../helpers/request';

describe('S: Authentication & Authorization', () => {
  const owner = 'auth-owner';
  const dev = 'auth-dev';
  const outsider = 'auth-outsider';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, dev);
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('S5: AUTH_DISABLED=true, only x-user-name header → 200', async () => {
    // AUTH_DISABLED=true is set in setup.ts, so just x-user-name should work
    const res = await projectGet(makeReq(`/api/projects/${projectId}`, { userName: owner }), {
      params: { projectId },
    });
    expect(res.status).toBe(200);
  });

  it('S1: Bearer PLANSYNC_SECRET + x-user-name → 200', async () => {
    const secret = process.env.PLANSYNC_SECRET || 'test-secret';
    const res = await projectGet(
      makeReq(`/api/projects/${projectId}`, {
        userName: owner,
        authToken: secret,
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(200);
  });

  it('S7: non-member accesses project → 403', async () => {
    const res = await projectGet(makeReq(`/api/projects/${projectId}`, { userName: outsider }), {
      params: { projectId },
    });
    expect(res.status).toBe(403);
  });

  it('S8: developer tries owner-only operation → 403', async () => {
    const res = await membersPost(
      makeReq(`/api/projects/${projectId}/members`, {
        method: 'POST',
        userName: dev,
        body: { name: 'new-person', role: 'developer', type: 'human' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(403);
  });

  it('S10: Alice is member → 200', async () => {
    const res = await membersGet(
      makeReq(`/api/projects/${projectId}/members`, { userName: owner }),
      { params: { projectId } },
    );
    expect(res.status).toBe(200);
  });

  it('S11: Bob is not member → 403', async () => {
    const res = await membersGet(
      makeReq(`/api/projects/${projectId}/members`, { userName: 'not-bob-not-member' }),
      { params: { projectId } },
    );
    expect(res.status).toBe(403);
  });
});

describe('S-JWT: JWT Authentication', () => {
  const jwtUser = 'jwt-test-user';
  const jwtPass = 'jwt-test-password-123';
  let jwtProjectId: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'test-jwt-secret-32-chars-minimum!!';
    ({ projectId: jwtProjectId } = await createTestProject(jwtUser));
  });

  afterAll(async () => {
    await testPrisma.apiKey.deleteMany({ where: { createdBy: jwtUser, name: 'jwt-refresh' } });
    await testPrisma.userAccount.deleteMany({ where: { userName: jwtUser } });
    await cleanupProject(jwtProjectId);
    delete process.env.JWT_SECRET;
  });

  it('S-JWT-1: login returns accessToken + refreshToken when JWT_SECRET set', async () => {
    const res = await loginPost(
      makeReq('/api/auth/login', { method: 'POST', body: { userName: jwtUser, password: jwtPass } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    // JWT has 3 dot-separated parts
    expect(body.accessToken.split('.').length).toBe(3);
    expect(body.refreshToken.split('.').length).toBe(3);
  });

  it('S-JWT-2: valid accessToken accepted in Authorization header → 200', async () => {
    const loginRes = await loginPost(
      makeReq('/api/auth/login', { method: 'POST', body: { userName: jwtUser, password: jwtPass } }),
    );
    const { accessToken } = await loginRes.json();

    // Use JWT Bearer token to access an endpoint — no x-user-name header
    const res = await projectGet(
      makeReq(`/api/projects/${jwtProjectId}`, { authToken: accessToken }),
      { params: { projectId: jwtProjectId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(jwtProjectId);
  });

  it('S-JWT-3: /auth/refresh returns new accessToken', async () => {
    const loginRes = await loginPost(
      makeReq('/api/auth/login', { method: 'POST', body: { userName: jwtUser, password: jwtPass } }),
    );
    const { refreshToken } = await loginRes.json();

    const res = await refreshPost(
      makeReq('/api/auth/refresh', { method: 'POST', authToken: refreshToken }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.data.accessToken).toBe('string');
    expect(body.data.accessToken.split('.').length).toBe(3);
  });

  it('S-JWT-4: after logout, refresh token is rejected with 401', async () => {
    const loginRes = await loginPost(
      makeReq('/api/auth/login', { method: 'POST', body: { userName: jwtUser, password: jwtPass } }),
    );
    const { refreshToken } = await loginRes.json();

    // Logout
    await logoutPost(
      makeReq('/api/auth/logout', { method: 'POST', userName: jwtUser }),
    );

    // Refresh should now fail
    const res = await refreshPost(
      makeReq('/api/auth/refresh', { method: 'POST', authToken: refreshToken }),
    );
    expect(res.status).toBe(401);
  });

  it('S-JWT-5: tampered JWT signature → falls through, rejected if no other auth', async () => {
    const loginRes = await loginPost(
      makeReq('/api/auth/login', { method: 'POST', body: { userName: jwtUser, password: jwtPass } }),
    );
    const { accessToken } = await loginRes.json();

    // Corrupt the last character of the signature
    const tampered = accessToken.slice(0, -1) + (accessToken.endsWith('A') ? 'B' : 'A');

    // No x-user-name, tampered JWT → should not be authenticated
    // With AUTH_DISABLED=true, fallthrough gives 'anonymous' user → 403 (not a project member)
    const res = await projectGet(
      makeReq(`/api/projects/${jwtProjectId}`, { authToken: tampered }),
      { params: { projectId: jwtProjectId } },
    );
    // Either 401 (auth rejected entirely) or 403 (fell through to anonymous user)
    expect([401, 403]).toContain(res.status);
  });
});
