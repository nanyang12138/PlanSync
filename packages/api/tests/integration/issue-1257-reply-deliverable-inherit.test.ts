// #1257 (R-156 follow-up): replies to deliverable-anchored comments must
// either inherit the parent's deliverableId or refuse a mismatched one.
//
// Before this fix the POST /comments handler only validated parent.planId
// and parent.isDeleted, then created the reply with whatever (or no)
// deliverableId the client sent. Two concrete failure modes:
//
//   1. The "Reply" button on a deliverable-A comment posts without
//      forwarding deliverableId → reply silently drops onto the
//      plan-level thread and disappears from the deliverable timeline.
//   2. A buggy/malicious client posts a reply to a deliverable-A comment
//      with deliverableId=B → reply ends up on deliverable B, splitting
//      the discussion across two timelines.
//
// The cases below pin down the new contract end-to-end through the
// route handler the UI calls.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST } from '@/app/api/projects/[projectId]/plans/[planId]/comments/route';
import { makeReq, createTestProject, cleanupProject, testPrisma } from '../helpers/request';

describe('#1257: reply inherits / validates parent deliverableId', () => {
  const owner = `i1257-owner-${Date.now()}`;
  let projectId: string;
  let planId: string;
  let deliverableA: string;
  let deliverableB: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    const plan = await testPrisma.plan.create({
      data: {
        projectId,
        title: '#1257 plan',
        goal: 'goal',
        scope: 'scope',
        version: 1,
        status: 'draft',
        createdBy: owner,
      },
    });
    planId = plan.id;
    const [a, b] = await Promise.all([
      testPrisma.planDeliverable.create({
        data: { planId, slug: 'i1257-a', title: 'A', body: 'first', refType: 'free' },
      }),
      testPrisma.planDeliverable.create({
        data: { planId, slug: 'i1257-b', title: 'B', body: 'second', refType: 'free' },
      }),
    ]);
    deliverableA = a.id;
    deliverableB = b.id;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  async function postComment(body: {
    content: string;
    parentId?: string;
    deliverableId?: string;
  }) {
    return POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: owner,
        body,
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
  }

  async function createParentOn(deliverableId: string | undefined) {
    const res = await postComment({
      content: `parent on ${deliverableId ?? 'plan-level'}`,
      ...(deliverableId ? { deliverableId } : {}),
    });
    expect(res.status).toBe(201);
    const parsed = await res.json();
    return parsed.data.id as string;
  }

  it('reply WITHOUT deliverableId inherits parent.deliverableId (the dropped-reply regression)', async () => {
    const parentId = await createParentOn(deliverableA);

    const res = await postComment({ content: 'reply, no deliverableId', parentId });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.parentId).toBe(parentId);
    expect(body.data.deliverableId).toBe(deliverableA);

    // Direct DB read — guard against the server returning an in-memory
    // echo while persisting NULL.
    const row = await testPrisma.planComment.findUnique({ where: { id: body.data.id } });
    expect(row?.deliverableId).toBe(deliverableA);
  });

  it('reply WITH matching deliverableId is accepted and stays on the same thread', async () => {
    const parentId = await createParentOn(deliverableA);

    const res = await postComment({
      content: 'reply, matching deliverableId',
      parentId,
      deliverableId: deliverableA,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.deliverableId).toBe(deliverableA);
  });

  it('reply WITH mismatched deliverableId is rejected (no cross-deliverable thread)', async () => {
    const parentId = await createParentOn(deliverableA);

    const res = await postComment({
      content: 'reply, wrong deliverableId',
      parentId,
      deliverableId: deliverableB,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toMatch(/deliverableId must match parent/);

    // Regression guard: the bad reply was never written to deliverable B.
    const stray = await testPrisma.planComment.findFirst({
      where: { planId, parentId, deliverableId: deliverableB },
    });
    expect(stray).toBeNull();
  });

  it('reply to a plan-level parent with an explicit deliverableId is rejected', async () => {
    const parentId = await createParentOn(undefined);

    const res = await postComment({
      content: 'reply tries to escalate plan-level → deliverable A',
      parentId,
      deliverableId: deliverableA,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toMatch(/deliverableId must match parent/);
  });

  it('reply to a plan-level parent without deliverableId stays plan-level (back-compat)', async () => {
    const parentId = await createParentOn(undefined);

    const res = await postComment({ content: 'plan-level reply', parentId });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.deliverableId).toBeNull();
  });
});
