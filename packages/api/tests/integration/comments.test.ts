// E module: Comment system
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GET, POST } from '@/app/api/projects/[projectId]/plans/[planId]/comments/route';
import {
  PATCH,
  DELETE,
} from '@/app/api/projects/[projectId]/plans/[planId]/comments/[commentId]/route';
import {
  makeReq,
  createTestProject,
  addMember,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('E: Comment System', () => {
  const owner = 'cmt-owner';
  const dev = 'cmt-dev';
  let projectId: string;
  let planId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, dev);
    const plan = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'Comment Test Plan',
        goal: 'goal',
        scope: 'scope',
        version: 1,
        status: 'draft',
        createdBy: owner,
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
        requiredReviewers: [],
      },
    });
    planId = plan.id;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  let commentId: string;
  let parentCommentId: string;

  it('E1: POST /comments {content} → 201', async () => {
    const res = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: owner,
        body: { content: 'First comment' },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.content).toBe('First comment');
    parentCommentId = body.data.id;
    commentId = body.data.id;
  });

  it('E2: POST /comments {content, parentId} → 201, parentId 关联', async () => {
    const res = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: dev,
        body: { content: 'Reply comment', parentId: parentCommentId },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.parentId).toBe(parentCommentId);
  });

  it('E3: GET /comments → 200, 含回复', async () => {
    const res = await GET(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, { userName: owner }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('E4: PATCH /comments/:id (作者) → 200', async () => {
    const res = await PATCH(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments/${commentId}`, {
        method: 'PATCH',
        userName: owner,
        body: { content: 'Edited comment' },
      }),
      { params: Promise.resolve({ projectId, planId, commentId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.content).toBe('Edited comment');
  });

  it('E4边: PATCH (非作者) → 403', async () => {
    const res = await PATCH(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments/${commentId}`, {
        method: 'PATCH',
        userName: dev,
        body: { content: 'Hacked' },
      }),
      { params: Promise.resolve({ projectId, planId, commentId }) },
    );
    expect(res.status).toBe(403);
  });

  it('E6: owner DELETE developer 的评论 → 200', async () => {
    // Create a comment by dev
    const devCommentRes = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: dev,
        body: { content: "Dev's comment" },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    const devCommentId = (await devCommentRes.json()).data.id;

    const res = await DELETE(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments/${devCommentId}`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: Promise.resolve({ projectId, planId, commentId: devCommentId }) },
    );
    expect(res.status).toBe(200);
  });

  it('E6边: developer DELETE 别人评论 → 403', async () => {
    const ownerCommentRes = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: owner,
        body: { content: "Owner's comment" },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    const ownerCommentId = (await ownerCommentRes.json()).data.id;

    const res = await DELETE(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments/${ownerCommentId}`, {
        method: 'DELETE',
        userName: dev,
      }),
      { params: Promise.resolve({ projectId, planId, commentId: ownerCommentId }) },
    );
    expect(res.status).toBe(403);
  });

  it('E5+E8: DELETE (作者) → 软删除, isDeleted=true, content=""', async () => {
    const createRes = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: owner,
        body: { content: 'To be deleted' },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    const toDeleteId = (await createRes.json()).data.id;

    const res = await DELETE(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments/${toDeleteId}`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: Promise.resolve({ projectId, planId, commentId: toDeleteId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.isDeleted).toBe(true);
    expect(body.data.content).toBe('');
  });

  it('E9: 删除父评论 → 子回复保留', async () => {
    // Create parent comment
    const parentRes = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: owner,
        body: { content: 'Parent to delete' },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    const newParentId = (await parentRes.json()).data.id;

    // Create child comment
    const childRes = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: dev,
        body: { content: 'Child reply', parentId: newParentId },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    const childId = (await childRes.json()).data.id;

    // Delete parent
    await DELETE(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments/${newParentId}`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: Promise.resolve({ projectId, planId, commentId: newParentId }) },
    );

    // Child should still exist
    const child = await testPrisma.planComment.findUnique({ where: { id: childId } });
    expect(child).not.toBeNull();
    expect(child?.isDeleted).toBe(false);

    // Parent should be soft-deleted
    const parent = await testPrisma.planComment.findUnique({ where: { id: newParentId } });
    expect(parent?.isDeleted).toBe(true);
  });

  it('E10: content 超 2000 字符 → 400', async () => {
    const res = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: owner,
        body: { content: 'x'.repeat(10001) },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(res.status).toBe(400);
  });

  // ---- #162: parentId must belong to the SAME plan -----------------------

  it('#162: POST with parentId pointing to a comment in a different plan → 404', async () => {
    // Create a second plan in the same project, plus a comment that belongs
    // to that other plan. The cross-plan parent reference must be rejected.
    const otherPlan = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'Other plan',
        goal: 'goal',
        scope: 'scope',
        version: 9,
        status: 'draft',
        createdBy: owner,
      },
    });
    const otherPlanComment = await testPrisma.planComment.create({
      data: {
        planId: otherPlan.id,
        authorName: owner,
        authorType: 'human',
        content: 'belongs to the other plan',
      },
    });

    try {
      const res = await POST(
        makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
          method: 'POST',
          userName: owner,
          // parentId targets a comment from a different plan in the same project.
          body: { content: 'cross-plan reply', parentId: otherPlanComment.id },
        }),
        { params: Promise.resolve({ projectId, planId }) },
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.message).toMatch(/Parent comment not found in this plan/);

      // The DB must not contain a stray cross-plan reply (regression guard).
      const stray = await testPrisma.planComment.findFirst({
        where: { planId: planId, parentId: otherPlanComment.id },
      });
      expect(stray).toBeNull();
    } finally {
      await testPrisma.planComment.delete({ where: { id: otherPlanComment.id } });
      await testPrisma.plan.delete({ where: { id: otherPlan.id } });
    }
  });

  it('#162: POST with non-existent parentId → 404 (no cross-plan info leak)', async () => {
    const res = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: owner,
        body: { content: 'reply to ghost', parentId: 'cmt_does_not_exist_123' },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('#162: POST with parentId of a soft-deleted comment in this plan → 400', async () => {
    // Create a comment, then soft-delete it; replying to it should be refused
    // with a clear 400 (not silently accepted, which would create a reply
    // hanging off an empty thread root).
    const target = await testPrisma.planComment.create({
      data: {
        planId,
        authorName: owner,
        authorType: 'human',
        content: 'doomed parent',
      },
    });
    await testPrisma.planComment.update({
      where: { id: target.id },
      data: { isDeleted: true, content: '' },
    });

    try {
      const res = await POST(
        makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
          method: 'POST',
          userName: dev,
          body: { content: 'reply', parentId: target.id },
        }),
        { params: Promise.resolve({ projectId, planId }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('BAD_REQUEST');
    } finally {
      await testPrisma.planComment.delete({ where: { id: target.id } });
    }
  });
});

// R7 (closes #953) — concurrent DELETE must not produce duplicate
// comment_deleted Activity rows. The race exists because the
// original guard read isDeleted into JS, then ran a separate UPDATE.
// Two requests that both observed isDeleted=false each issued an
// UPDATE AND each wrote an audit row. The fix moves the
// isDeleted=false predicate INTO the SQL WHERE clause via
// updateMany; Postgres row-locks the row, exactly one updater sees
// count=1, everyone else sees count=0 and bails before the audit
// write.
describe('R7 concurrent DELETE writes at most one audit row (#953)', () => {
  it('parallel DELETE on the same comment yields exactly one comment_deleted Activity', async () => {
    // Self-contained setup so this test can't be order-coupled with
    // the rest of the suite.
    const r7OwnerName = `r7-owner-${Date.now()}`;
    const proj = await testPrisma.project.create({
      data: {
        name: `r7-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        phase: 'planning',
        createdBy: r7OwnerName,
      },
    });
    await testPrisma.projectMember.create({
      data: { projectId: proj.id, name: r7OwnerName, role: 'owner', type: 'human' },
    });
    const plan = await testPrisma.plan.create({
      data: {
        projectId: proj.id,
        title: 'r7-plan',
        goal: 'g',
        scope: 's',
        version: 1,
        status: 'active',
        createdBy: r7OwnerName,
      },
    });

    try {
      const createRes = await POST(
        makeReq(`/api/projects/${proj.id}/plans/${plan.id}/comments`, {
          method: 'POST',
          userName: r7OwnerName,
          body: { content: 'race target' },
        }),
        { params: { projectId: proj.id, planId: plan.id } },
      );
      const cid = (await createRes.json()).data.id;

      // Fire two DELETEs in parallel.
      const both = await Promise.all([
        DELETE(
          makeReq(`/api/projects/${proj.id}/plans/${plan.id}/comments/${cid}`, {
            method: 'DELETE',
            userName: r7OwnerName,
          }),
          { params: { projectId: proj.id, planId: plan.id, commentId: cid } },
        ),
        DELETE(
          makeReq(`/api/projects/${proj.id}/plans/${plan.id}/comments/${cid}`, {
            method: 'DELETE',
            userName: r7OwnerName,
          }),
          { params: { projectId: proj.id, planId: plan.id, commentId: cid } },
        ),
      ]);

      // Exactly one 200 + one 409.
      const statuses = both.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409]);

      // Critical: only ONE comment_deleted Activity row for this comment.
      const audits = await testPrisma.activity.findMany({
        where: { projectId: proj.id, type: 'comment_deleted' },
      });
      const hits = audits.filter((a) => {
        const meta = a.metadata as { commentId?: string } | null;
        return meta?.commentId === cid;
      });
      expect(hits).toHaveLength(1);
    } finally {
      await testPrisma.project.delete({ where: { id: proj.id } }).catch(() => {});
    }
  });
});
