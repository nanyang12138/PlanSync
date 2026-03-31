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
      { params: { projectId, planId } },
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
      { params: { projectId, planId } },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.parentId).toBe(parentCommentId);
  });

  it('E3: GET /comments → 200, 含回复', async () => {
    const res = await GET(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, { userName: owner }),
      { params: { projectId, planId } },
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
      { params: { projectId, planId, commentId } },
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
      { params: { projectId, planId, commentId } },
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
      { params: { projectId, planId } },
    );
    const devCommentId = (await devCommentRes.json()).data.id;

    const res = await DELETE(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments/${devCommentId}`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: { projectId, planId, commentId: devCommentId } },
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
      { params: { projectId, planId } },
    );
    const ownerCommentId = (await ownerCommentRes.json()).data.id;

    const res = await DELETE(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments/${ownerCommentId}`, {
        method: 'DELETE',
        userName: dev,
      }),
      { params: { projectId, planId, commentId: ownerCommentId } },
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
      { params: { projectId, planId } },
    );
    const toDeleteId = (await createRes.json()).data.id;

    const res = await DELETE(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments/${toDeleteId}`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: { projectId, planId, commentId: toDeleteId } },
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
      { params: { projectId, planId } },
    );
    const newParentId = (await parentRes.json()).data.id;

    // Create child comment
    const childRes = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: dev,
        body: { content: 'Child reply', parentId: newParentId },
      }),
      { params: { projectId, planId } },
    );
    const childId = (await childRes.json()).data.id;

    // Delete parent
    await DELETE(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments/${newParentId}`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: { projectId, planId, commentId: newParentId } },
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
      { params: { projectId, planId } },
    );
    expect(res.status).toBe(400);
  });
});
