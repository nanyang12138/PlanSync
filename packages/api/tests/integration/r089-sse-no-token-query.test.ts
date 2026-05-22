// R-089: SSE endpoints must reject `?token=` to keep secrets out of URLs,
// browser history, and access logs. Cookie / header auth remain supported.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GET as projectEventsGet } from '@/app/api/projects/[projectId]/events/route';
import { GET as userEventsGet } from '@/app/api/user-events/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
} from '../helpers/request';

describe('R-089: SSE rejects ?token= query param', () => {
  const owner = 'r089-owner';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await createActivePlan(projectId, owner);
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('GET /api/projects/:projectId/events?token=anything → 401', async () => {
    const req = makeReq(`/api/projects/${projectId}/events`, {
      userName: owner,
      searchParams: { token: 'leaked-secret-value' },
    });
    const res = await projectEventsGet(req, { params: { projectId } });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body.toLowerCase()).toContain('token');
  });

  it('GET /api/projects/:projectId/events?token=&user= → 401 (token still wins as reject)', async () => {
    // Even a benign-looking empty token-presence triggers rejection: the rule
    // is "the `token` key may not appear", not "the value must be non-empty".
    const req = makeReq(`/api/projects/${projectId}/events`, {
      userName: owner,
      searchParams: { token: '', user: owner },
    });
    const res = await projectEventsGet(req, { params: { projectId } });
    expect(res.status).toBe(401);
  });

  it('GET /api/user-events?token=anything → 401', async () => {
    const req = makeReq(`/api/user-events`, {
      userName: owner,
      searchParams: { token: 'leaked-secret-value' },
    });
    const res = await userEventsGet(req);
    expect(res.status).toBe(401);
  });

  it('GET /api/projects/:projectId/events (no token) → 200 via header/cookie auth', async () => {
    // Sanity: cookie/header path (X-User-Name + AUTH_DISABLED in test env)
    // still produces an open stream. This guards against an over-broad
    // rejection.
    const req = makeReq(`/api/projects/${projectId}/events`, { userName: owner });
    const res = await projectEventsGet(req, { params: { projectId } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await res.body!.cancel();
  });

  it('GET /api/projects/:projectId/events?user= (no token) → 200', async () => {
    // ?user= is preserved (carries only an identity hint, not a secret).
    const req = makeReq(`/api/projects/${projectId}/events`, {
      userName: owner,
      searchParams: { user: owner },
    });
    const res = await projectEventsGet(req, { params: { projectId } });
    expect(res.status).toBe(200);
    await res.body!.cancel();
  });
});
