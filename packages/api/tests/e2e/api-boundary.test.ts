// E2E: API permission boundaries, plan state machine, drift engine, review workflow.
// Uses raw fetch against the REST API — no Genie, no MCP client.
// All tests are deterministic and do not require an LLM.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const SERVER_URL = `http://localhost:${process.env.PORT || 3001}`;
const SECRET = process.env.PLANSYNC_SECRET || 'dev-secret';

const OWNER = 'e2e-bnd-owner';
const DEV = 'e2e-bnd-dev';
const REV1 = 'e2e-bnd-rev1';
const REV2 = 'e2e-bnd-rev2';

function hdr(user: string): Record<string, string> {
  return {
    Authorization: `Bearer ${SECRET}`,
    'X-User-Name': user,
    'Content-Type': 'application/json',
  };
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  user = OWNER,
): Promise<{ status: number; data: any; error: any }> {
  const r = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers: hdr(user),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = {};
  try {
    json = await r.json();
  } catch {
    /* ignore */
  }
  return { status: r.status, data: json.data, error: json.error };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite P: Role-based access control
// ─────────────────────────────────────────────────────────────────────────────

describe('P: Role-based access control', () => {
  let projectId: string;

  beforeAll(async () => {
    const proj = await api('POST', '/api/projects', { name: `e2e-perm-${Date.now()}` });
    projectId = proj.data.id;
    await api('POST', `/api/projects/${projectId}/members`, { name: DEV, role: 'developer' });
    // Activate a plan so developer can create tasks (task creation requires active plan)
    const plan = await api('POST', `/api/projects/${projectId}/plans`, {
      title: 'Perm Test Plan',
      goal: 'G',
      scope: 'S',
    });
    await api('POST', `/api/projects/${projectId}/plans/${plan.data.id}/activate`, {});
  }, 30_000);

  afterAll(async () => {
    if (projectId) await api('DELETE', `/api/projects/${projectId}`);
  });

  it('P1: developer cannot create plan → 403', async () => {
    const r = await api(
      'POST',
      `/api/projects/${projectId}/plans`,
      { title: 'T', goal: 'G', scope: 'S' },
      DEV,
    );
    expect(r.status).toBe(403);
  });

  it('P2: developer can read plans → 200', async () => {
    const r = await api('GET', `/api/projects/${projectId}/plans`, undefined, DEV);
    expect(r.status).toBe(200);
  });

  it('P3: developer can read tasks → 200', async () => {
    const r = await api('GET', `/api/projects/${projectId}/tasks`, undefined, DEV);
    expect(r.status).toBe(200);
  });

  it('P4: developer can create task → 201', async () => {
    const r = await api(
      'POST',
      `/api/projects/${projectId}/tasks`,
      { title: 'Dev task', type: 'code' },
      DEV,
    );
    expect(r.status).toBe(201);
  });

  it('P5: developer cannot add member → 403', async () => {
    const r = await api(
      'POST',
      `/api/projects/${projectId}/members`,
      { name: 'new-user', role: 'developer' },
      DEV,
    );
    expect(r.status).toBe(403);
  });

  it('P6: developer cannot delete project → 403', async () => {
    const r = await api('DELETE', `/api/projects/${projectId}`, undefined, DEV);
    expect(r.status).toBe(403);
  });

  it('P7: developer cannot update project name → 403', async () => {
    const r = await api('PATCH', `/api/projects/${projectId}`, { name: 'Hacked Name' }, DEV);
    expect(r.status).toBe(403);
  });

  it('P8: non-member cannot access project → 403', async () => {
    const r = await api('GET', `/api/projects/${projectId}`, undefined, 'total-stranger');
    expect(r.status).toBe(403);
  });

  it('P9: owner can activate plan directly (no propose required)', async () => {
    const p = await api('POST', `/api/projects/${projectId}/plans`, {
      title: 'Direct Activate',
      goal: 'G',
      scope: 'S',
    });
    expect(p.status).toBe(201);
    const r = await api('POST', `/api/projects/${projectId}/plans/${p.data.id}/activate`, {});
    expect(r.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite S: Plan state machine
// ─────────────────────────────────────────────────────────────────────────────

describe('S: Plan state machine', () => {
  let projectId: string;

  beforeAll(async () => {
    const proj = await api('POST', '/api/projects', { name: `e2e-sm-${Date.now()}` });
    projectId = proj.data.id;
    await api('POST', `/api/projects/${projectId}/members`, { name: REV1, role: 'developer' });
  }, 15_000);

  afterAll(async () => {
    if (projectId) await api('DELETE', `/api/projects/${projectId}`);
  });

  it('S1: can edit a draft plan', async () => {
    const p = await api('POST', `/api/projects/${projectId}/plans`, {
      title: 'Draft',
      goal: 'Goal',
      scope: 'Scope',
    });
    expect(p.status).toBe(201);
    const r = await api('PATCH', `/api/projects/${projectId}/plans/${p.data.id}`, {
      title: 'Draft Updated',
    });
    expect(r.status).toBe(200);
    expect(r.data.title).toBe('Draft Updated');
  });

  it('S2: cannot edit a proposed plan content → 409', async () => {
    const p = await api('POST', `/api/projects/${projectId}/plans`, {
      title: 'Propose Me',
      goal: 'G',
      scope: 'S',
    });
    await api('POST', `/api/projects/${projectId}/plans/${p.data.id}/propose`, {
      reviewers: [REV1],
    });
    const r = await api('PATCH', `/api/projects/${projectId}/plans/${p.data.id}`, {
      title: 'Changed Title',
    });
    expect(r.status).toBe(409);
  });

  it('S3: can add requiredReviewers to proposed plan → creates review record', async () => {
    const p = await api('POST', `/api/projects/${projectId}/plans`, {
      title: 'Add Reviewer',
      goal: 'G',
      scope: 'S',
    });
    await api('POST', `/api/projects/${projectId}/plans/${p.data.id}/propose`, {
      reviewers: [REV1],
    });
    // Add REV2 — note: REV2 is not a project member, but requiredReviewers is just a string list
    const r = await api('PATCH', `/api/projects/${projectId}/plans/${p.data.id}`, {
      requiredReviewers: [REV1, 'e2e-bnd-rev2'],
    });
    expect(r.status).toBe(200);
    const reviews = await api('GET', `/api/projects/${projectId}/plans/${p.data.id}/reviews`);
    expect(reviews.status).toBe(200);
    const names = reviews.data.map((rv: any) => rv.reviewerName);
    expect(names).toContain(REV1);
    expect(names).toContain('e2e-bnd-rev2');
  });

  it('S4: cannot delete a proposed plan → 409', async () => {
    const p = await api('POST', `/api/projects/${projectId}/plans`, {
      title: 'Cant Delete Proposed',
      goal: 'G',
      scope: 'S',
    });
    await api('POST', `/api/projects/${projectId}/plans/${p.data.id}/propose`, {
      reviewers: [REV1],
    });
    const r = await api('DELETE', `/api/projects/${projectId}/plans/${p.data.id}`);
    expect(r.status).toBe(409);
  });

  it('S5: cannot edit an active plan → 409', async () => {
    const p = await api('POST', `/api/projects/${projectId}/plans`, {
      title: 'Active Plan',
      goal: 'G',
      scope: 'S',
    });
    await api('POST', `/api/projects/${projectId}/plans/${p.data.id}/activate`, {});
    const r = await api('PATCH', `/api/projects/${projectId}/plans/${p.data.id}`, {
      title: 'Changed',
    });
    expect(r.status).toBe(409);
  });

  it('S6: cannot delete an active plan → 409', async () => {
    const plans = await api('GET', `/api/projects/${projectId}/plans`);
    const active = plans.data?.find((p: any) => p.status === 'active');
    if (!active) {
      console.warn('No active plan found, skipping S6');
      return;
    }
    const r = await api('DELETE', `/api/projects/${projectId}/plans/${active.id}`);
    expect(r.status).toBe(409);
  });

  it('S7: can delete a draft plan → 200', async () => {
    const p = await api('POST', `/api/projects/${projectId}/plans`, {
      title: 'Deletable Draft',
      goal: 'G',
      scope: 'S',
    });
    expect(p.status).toBe(201);
    const r = await api('DELETE', `/api/projects/${projectId}/plans/${p.data.id}`);
    expect(r.status).toBe(200);
    expect(r.data?.deleted).toBe(true);
  });

  it('S8: can reactivate a superseded plan (rollback)', async () => {
    // v_old was activated in S5; a v_new was activated in P9 (same project? no, different projects)
    // Create fresh sequence: v_old → activate → v_new → activate → reactivate v_old
    const vOld = await api('POST', `/api/projects/${projectId}/plans`, {
      title: 'Rollback v1',
      goal: 'G',
      scope: 'S',
    });
    await api('POST', `/api/projects/${projectId}/plans/${vOld.data.id}/activate`, {});
    const vNew = await api('POST', `/api/projects/${projectId}/plans`, {
      title: 'Rollback v2',
      goal: 'G2',
      scope: 'S2',
    });
    await api('POST', `/api/projects/${projectId}/plans/${vNew.data.id}/activate`, {});
    // Reactivate old
    const r = await api('POST', `/api/projects/${projectId}/plans/${vOld.data.id}/reactivate`, {});
    expect(r.status).toBe(200);
    // Verify it's active now
    const active = await api('GET', `/api/projects/${projectId}/plans/active`);
    expect(active.data.id).toBe(vOld.data.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite D: Drift engine
// ─────────────────────────────────────────────────────────────────────────────

describe('D: Drift engine', () => {
  let projectId: string;
  let taskIds: string[] = [];
  let driftIds: string[] = [];

  beforeAll(async () => {
    const proj = await api('POST', '/api/projects', { name: `e2e-drift-${Date.now()}` });
    projectId = proj.data.id;

    // Plan v1 → activate
    const p1 = await api('POST', `/api/projects/${projectId}/plans`, {
      title: 'v1',
      goal: 'G',
      scope: 'S',
    });
    await api('POST', `/api/projects/${projectId}/plans/${p1.data.id}/activate`, {});

    // 3 tasks (bound to v1 on creation)
    for (let i = 0; i < 3; i++) {
      const t = await api('POST', `/api/projects/${projectId}/tasks`, {
        title: `Drift Task ${i + 1}`,
        type: 'code',
      });
      taskIds.push(t.data.id);
    }

    // Plan v2 → activate (triggers drift for all 3 tasks)
    const p2 = await api('POST', `/api/projects/${projectId}/plans`, {
      title: 'v2',
      goal: 'G2',
      scope: 'S2',
    });
    await api('POST', `/api/projects/${projectId}/plans/${p2.data.id}/activate`, {});

    // Wait for drifts (drift engine is sync but give it a moment)
    for (let i = 0; i < 10; i++) {
      const d = await api('GET', `/api/projects/${projectId}/drifts?status=open`);
      if ((d.data?.length ?? 0) >= 3) {
        driftIds = d.data.map((x: any) => x.id);
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }, 45_000);

  afterAll(async () => {
    if (projectId) await api('DELETE', `/api/projects/${projectId}`);
  });

  it('D1: activating v2 creates drift alert for all 3 v1-bound tasks', () => {
    expect(driftIds.length).toBeGreaterThanOrEqual(3);
  });

  it('D2: resolve action=rebind → drift closed, open count decreases', async () => {
    if (!driftIds[0]) return;
    const r = await api('POST', `/api/projects/${projectId}/drifts/${driftIds[0]}`, {
      action: 'rebind',
    });
    expect(r.status).toBe(200);
    const d = await api('GET', `/api/projects/${projectId}/drifts?status=open`);
    const stillOpen = d.data?.find((x: any) => x.id === driftIds[0]);
    expect(stillOpen).toBeUndefined();
  });

  it('D3: resolve action=no_impact → drift closed', async () => {
    if (!driftIds[1]) return;
    const r = await api('POST', `/api/projects/${projectId}/drifts/${driftIds[1]}`, {
      action: 'no_impact',
    });
    expect(r.status).toBe(200);
    const d = await api('GET', `/api/projects/${projectId}/drifts?status=open`);
    const stillOpen = d.data?.find((x: any) => x.id === driftIds[1]);
    expect(stillOpen).toBeUndefined();
  });

  it('D4: resolve action=cancel → task status becomes cancelled', async () => {
    if (!driftIds[2] || !taskIds[2]) return;
    const r = await api('POST', `/api/projects/${projectId}/drifts/${driftIds[2]}`, {
      action: 'cancel',
    });
    expect(r.status).toBe(200);
    const task = await api('GET', `/api/projects/${projectId}/tasks/${taskIds[2]}`);
    expect(task.data.status).toBe('cancelled');
  });

  it('D5: already-resolved drift cannot be resolved again → 409 or 400', async () => {
    if (!driftIds[0]) return;
    const r = await api('POST', `/api/projects/${projectId}/drifts/${driftIds[0]}`, {
      action: 'no_impact',
    });
    expect([400, 409]).toContain(r.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite R: Review workflow
// ─────────────────────────────────────────────────────────────────────────────

describe('R: Review workflow', () => {
  let projectId: string;
  let planId: string;

  beforeAll(async () => {
    const proj = await api('POST', '/api/projects', { name: `e2e-rev-${Date.now()}` });
    projectId = proj.data.id;
    await api('POST', `/api/projects/${projectId}/members`, { name: REV1, role: 'developer' });
    await api('POST', `/api/projects/${projectId}/members`, { name: REV2, role: 'developer' });

    // Create and propose plan with 2 required reviewers
    const p = await api('POST', `/api/projects/${projectId}/plans`, {
      title: 'Review Plan',
      goal: 'G',
      scope: 'S',
      requiredReviewers: [REV1, REV2],
    });
    await api('POST', `/api/projects/${projectId}/plans/${p.data.id}/propose`, {});
    planId = p.data.id;
  }, 30_000);

  afterAll(async () => {
    if (projectId) await api('DELETE', `/api/projects/${projectId}`);
  });

  it('R1: propose creates pending review records for all required reviewers', async () => {
    const r = await api('GET', `/api/projects/${projectId}/plans/${planId}/reviews`);
    expect(r.status).toBe(200);
    const names = r.data.map((rv: any) => rv.reviewerName);
    expect(names).toContain(REV1);
    expect(names).toContain(REV2);
    r.data.forEach((rv: any) => expect(rv.status).toBe('pending'));
  });

  it('R2: REV1 approves → that review status becomes approved', async () => {
    const reviews = await api('GET', `/api/projects/${projectId}/plans/${planId}/reviews`);
    const rev1 = reviews.data.find((rv: any) => rv.reviewerName === REV1);
    if (!rev1) {
      console.warn('REV1 review not found; skip R2');
      return;
    }
    const r = await api(
      'POST',
      `/api/projects/${projectId}/plans/${planId}/reviews/${rev1.id}?action=approve`,
      { comment: 'LGTM' },
      REV1,
    );
    expect(r.status).toBe(200);
    const updated = await api('GET', `/api/projects/${projectId}/plans/${planId}/reviews`);
    const rv1Updated = updated.data.find((rv: any) => rv.reviewerName === REV1);
    expect(rv1Updated.status).toBe('approved');
  });

  it('R3: plan stays "proposed" after partial approval (REV2 still pending)', async () => {
    const plan = await api('GET', `/api/projects/${projectId}/plans/${planId}`);
    expect(plan.data.status).toBe('proposed');
  });

  it('R4: REV2 rejects → plan remains proposed', async () => {
    const reviews = await api('GET', `/api/projects/${projectId}/plans/${planId}/reviews`);
    const rev2 = reviews.data.find((rv: any) => rv.reviewerName === REV2);
    if (!rev2) {
      console.warn('REV2 review not found; skip R4');
      return;
    }
    const r = await api(
      'POST',
      `/api/projects/${projectId}/plans/${planId}/reviews/${rev2.id}?action=reject`,
      { comment: 'Needs more detail' },
      REV2,
    );
    expect(r.status).toBe(200);
    const plan = await api('GET', `/api/projects/${projectId}/plans/${planId}`);
    expect(plan.data.status).toBe('proposed');
  });

  it("R5: owner (not a reviewer) cannot approve another user's review → 403", async () => {
    const reviews = await api('GET', `/api/projects/${projectId}/plans/${planId}/reviews`);
    // Try to approve REV1's review as OWNER
    const rev1 = reviews.data.find((rv: any) => rv.reviewerName === REV1);
    if (!rev1) return;
    const r = await api(
      'POST',
      `/api/projects/${projectId}/plans/${planId}/reviews/${rev1.id}?action=approve`,
      {},
      OWNER,
    );
    expect([403, 404]).toContain(r.status);
  });

  it('R6: all-approved plan can be activated by owner', async () => {
    // Create fresh plan with single reviewer, approve it, then activate
    const p = await api('POST', `/api/projects/${projectId}/plans`, {
      title: 'Full Approval Flow',
      goal: 'G',
      scope: 'S',
      requiredReviewers: [REV1],
    });
    await api('POST', `/api/projects/${projectId}/plans/${p.data.id}/propose`, {});
    const reviews = await api('GET', `/api/projects/${projectId}/plans/${p.data.id}/reviews`);
    const rev = reviews.data.find((rv: any) => rv.reviewerName === REV1);
    if (!rev) {
      console.warn('Review not found; skip R6');
      return;
    }
    await api(
      'POST',
      `/api/projects/${projectId}/plans/${p.data.id}/reviews/${rev.id}?action=approve`,
      {},
      REV1,
    );
    // Owner activates
    const r = await api('POST', `/api/projects/${projectId}/plans/${p.data.id}/activate`, {});
    expect(r.status).toBe(200);
    const plan = await api('GET', `/api/projects/${projectId}/plans/${p.data.id}`);
    expect(plan.data.status).toBe('active');
  });
});
