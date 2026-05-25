// R-109: comment edit/delete 写 activity
//
// PATCH /plans/:planId/comments/:commentId and DELETE on the same path are
// the only two mutations that can alter a published review/decision
// comment after the fact. Without an activity row, a reviewer's original
// "REJECT — security gap on X" can be silently rewritten to "APPROVE" or
// deleted by an owner override, leaving no audit trail tying the change
// to a user. R-104..R-108 closed the same hole on plan, task, and drift
// surfaces; R-109 finishes the audit coverage on the comment surface.
//
// This test asserts that:
//   1. A successful PATCH (author editing their own comment) writes
//      exactly one `comment_updated` activity whose metadata captures the
//      pre-edit content snapshot, the planId, commentId and authorName,
//      and whose actorName matches the editor.
//   2. A successful DELETE by the author writes exactly one
//      `comment_deleted` activity with `deletedByAuthor: true` in
//      metadata, captures the pre-delete content snapshot, and the
//      summary reflects "by author".
//   3. A successful DELETE by a project owner overriding another
//      member's comment writes `comment_deleted` with
//      `deletedByAuthor: false` and a summary reflecting "by owner".
//   4. Failed mutations (PATCH by non-author 403, PATCH of an already
//      soft-deleted comment 409, DELETE of a non-existent comment 404)
//      write NO activity row — we only audit on success so the feed
//      reflects what actually happened.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as commentsPost } from '@/app/api/projects/[projectId]/plans/[planId]/comments/route';
import {
  PATCH as commentPatch,
  DELETE as commentDelete,
} from '@/app/api/projects/[projectId]/plans/[planId]/comments/[commentId]/route';
import {
  makeReq,
  createTestProject,
  addMember,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('R-109: comment edit/delete writes activity', () => {
  const owner = 'r109-owner';
  const dev = 'r109-dev';
  let projectId: string;
  let planId: string;
  let planVersion: number;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, dev);
    const plan = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'R-109 Comment Activity Plan',
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
    planVersion = plan.version;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  async function createComment(opts: { author: string; content: string }): Promise<string> {
    const res = await commentsPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: opts.author,
        body: { content: opts.content },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(res.status).toBe(201);
    return (await res.json()).data.id;
  }

  it('successful PATCH (author edits own comment) writes a comment_updated activity with the pre-edit snapshot', async () => {
    const originalContent = `R109 original ${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const newContent = `R109 edited ${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const commentId = await createComment({ author: dev, content: originalContent });

    const before = await testPrisma.activity.count({
      where: { projectId, type: 'comment_updated' },
    });

    const res = await commentPatch(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments/${commentId}`, {
        method: 'PATCH',
        userName: dev,
        body: { content: newContent },
      }),
      { params: Promise.resolve({ projectId, planId, commentId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.content).toBe(newContent);

    const after = await testPrisma.activity.findMany({
      where: { projectId, type: 'comment_updated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(after.length).toBe(before + 1);

    const activity = after[0];
    expect(activity.actorName).toBe(dev);
    expect(activity.actorType).toBe('human');
    expect(activity.summary).toContain(`v${planVersion}`);
    expect(activity.summary).toContain('edited');

    const md = activity.metadata as {
      planId?: string;
      commentId?: string;
      authorName?: string;
      previousContent?: string;
    } | null;
    expect(md?.planId).toBe(planId);
    expect(md?.commentId).toBe(commentId);
    expect(md?.authorName).toBe(dev);
    expect(md?.previousContent).toBe(originalContent);
  });

  it('successful DELETE by the author writes a comment_deleted activity flagged deletedByAuthor=true', async () => {
    const content = `R109 author-del ${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const commentId = await createComment({ author: dev, content });

    const before = await testPrisma.activity.count({
      where: { projectId, type: 'comment_deleted' },
    });

    const res = await commentDelete(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments/${commentId}`, {
        method: 'DELETE',
        userName: dev,
      }),
      { params: Promise.resolve({ projectId, planId, commentId }) },
    );
    expect(res.status).toBe(200);

    const after = await testPrisma.activity.findMany({
      where: { projectId, type: 'comment_deleted' },
      orderBy: { createdAt: 'desc' },
    });
    expect(after.length).toBe(before + 1);

    const activity = after[0];
    expect(activity.actorName).toBe(dev);
    expect(activity.actorType).toBe('human');
    expect(activity.summary).toContain(`v${planVersion}`);
    expect(activity.summary).toContain('by author');

    const md = activity.metadata as {
      planId?: string;
      commentId?: string;
      authorName?: string;
      deletedByAuthor?: boolean;
      previousContent?: string;
    } | null;
    expect(md?.planId).toBe(planId);
    expect(md?.commentId).toBe(commentId);
    expect(md?.authorName).toBe(dev);
    expect(md?.deletedByAuthor).toBe(true);
    expect(md?.previousContent).toBe(content);
  });

  it('successful DELETE by owner over a member comment writes comment_deleted with deletedByAuthor=false', async () => {
    const content = `R109 owner-del ${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const commentId = await createComment({ author: dev, content });

    const before = await testPrisma.activity.count({
      where: { projectId, type: 'comment_deleted' },
    });

    const res = await commentDelete(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments/${commentId}`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: Promise.resolve({ projectId, planId, commentId }) },
    );
    expect(res.status).toBe(200);

    const after = await testPrisma.activity.findMany({
      where: { projectId, type: 'comment_deleted' },
      orderBy: { createdAt: 'desc' },
    });
    expect(after.length).toBe(before + 1);

    const activity = after[0];
    expect(activity.actorName).toBe(owner);
    expect(activity.summary).toContain('by owner');

    const md = activity.metadata as {
      authorName?: string;
      deletedByAuthor?: boolean;
      previousContent?: string;
    } | null;
    expect(md?.authorName).toBe(dev);
    expect(md?.deletedByAuthor).toBe(false);
    expect(md?.previousContent).toBe(content);
  });

  it('PATCH rejected because the caller is not the author writes NO comment_updated activity', async () => {
    const commentId = await createComment({
      author: dev,
      content: `R109 forbidden-edit ${Date.now()}`,
    });

    const before = await testPrisma.activity.count({
      where: { projectId, type: 'comment_updated' },
    });

    const res = await commentPatch(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments/${commentId}`, {
        method: 'PATCH',
        userName: owner,
        body: { content: 'hostile rewrite' },
      }),
      { params: Promise.resolve({ projectId, planId, commentId }) },
    );
    expect(res.status).toBe(403);

    const after = await testPrisma.activity.count({
      where: { projectId, type: 'comment_updated' },
    });
    expect(after).toBe(before);
  });

  it('PATCH on an already soft-deleted comment writes NO comment_updated activity', async () => {
    const commentId = await createComment({
      author: dev,
      content: `R109 conflict-edit ${Date.now()}`,
    });

    await commentDelete(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments/${commentId}`, {
        method: 'DELETE',
        userName: dev,
      }),
      { params: Promise.resolve({ projectId, planId, commentId }) },
    );

    const before = await testPrisma.activity.count({
      where: { projectId, type: 'comment_updated' },
    });

    const res = await commentPatch(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments/${commentId}`, {
        method: 'PATCH',
        userName: dev,
        body: { content: 'after delete' },
      }),
      { params: Promise.resolve({ projectId, planId, commentId }) },
    );
    expect(res.status).toBe(409);

    const after = await testPrisma.activity.count({
      where: { projectId, type: 'comment_updated' },
    });
    expect(after).toBe(before);
  });

  it('DELETE of a non-existent comment writes NO comment_deleted activity', async () => {
    const before = await testPrisma.activity.count({
      where: { projectId, type: 'comment_deleted' },
    });

    const res = await commentDelete(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments/does-not-exist`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: Promise.resolve({ projectId, planId, commentId: 'does-not-exist' }) },
    );
    expect(res.status).toBe(404);

    const after = await testPrisma.activity.count({
      where: { projectId, type: 'comment_deleted' },
    });
    expect(after).toBe(before);
  });
});
