// R-044: notify route is owner-only AND rate-limited (3 calls / 5 min / user)
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { POST as notifyPost } from '@/app/api/projects/[projectId]/notify/route';
import { resetNotifyRateLimit } from '@/lib/notify-rate-limit';
import {
  makeReq,
  createTestProject,
  addMember,
  createActivePlan,
  cleanupProject,
} from '../helpers/request';

describe('R-044: notify route — owner-only + per-user rate limit', () => {
  const owner = 'r044-owner';
  const developer = 'r044-dev';
  let projectId: string;
  let planId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, developer, 'developer');
    ({ planId } = await createActivePlan(projectId, owner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  beforeEach(() => {
    // each test starts with a clean rate-limit window
    resetNotifyRateLimit();
  });

  it('rejects developer (non-owner) with 403 FORBIDDEN', async () => {
    const res = await notifyPost(
      makeReq(`/api/projects/${projectId}/notify`, {
        method: 'POST',
        userName: developer,
        body: { type: 'plan_owner', planId },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('allows owner up to 3 calls within window, then returns 429 RATE_LIMITED on the 4th', async () => {
    const callOnce = () =>
      notifyPost(
        makeReq(`/api/projects/${projectId}/notify`, {
          method: 'POST',
          userName: owner,
          body: { type: 'plan_owner', planId },
        }),
        { params: { projectId } },
      );

    const r1 = await callOnce();
    const r2 = await callOnce();
    const r3 = await callOnce();
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);

    const r4 = await callOnce();
    expect(r4.status).toBe(429);
    const body = await r4.json();
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.details?.limit).toBe(3);
    expect(typeof body.error.details?.retryAfterSec).toBe('number');
  });
});
