// R-116 [HIGH/B12]: integration tests for chat / notify / ai-draft / ai-field
// route handlers.
//
// Goal — exercise the four AI/notification routes that R-115/R-118-style
// suites have not directly covered yet:
//
//   POST /api/projects/:projectId/chat
//   POST /api/projects/:projectId/notify
//   POST /api/projects/:projectId/plans/ai-draft
//   POST /api/projects/:projectId/plans/ai-field
//
// R-044 already covers the rate-limit / owner-only guard on /notify, so this
// suite only adds the *response-shape* and *parameter-validation* paths
// (missing fields, unknown type, plan_reviewers vs plan_owner branches,
// 404 on stale planId). The chat / ai-draft / ai-field cases assert that:
//
//   - non-members get 403 FORBIDDEN before any AI work runs,
//   - input validation produces 400 VALIDATION_ERROR,
//   - the deterministic mock provider drives the success / 502 paths
//     so CI exercises every branch without holding real LLM keys.
//
// All tests drive the route handlers directly (no live server) to mirror the
// existing R-118 / R-044 conventions.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { POST as chatPost } from '@/app/api/projects/[projectId]/chat/route';
import { POST as notifyPost } from '@/app/api/projects/[projectId]/notify/route';
import { POST as aiDraftPost } from '@/app/api/projects/[projectId]/plans/ai-draft/route';
import { POST as aiFieldPost } from '@/app/api/projects/[projectId]/plans/ai-field/route';
import { resetNotifyRateLimit } from '@/lib/notify-rate-limit';
import { aiClient } from '@/lib/ai/client';
import {
  makeReq,
  createTestProject,
  addMember,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('R-116 — chat / notify / ai-draft / ai-field route integration', () => {
  const owner = 'r116-owner';
  const developer = 'r116-dev';
  const reviewerA = 'r116-reviewer-a';
  const reviewerB = 'r116-reviewer-b';
  const outsider = 'r116-outsider';

  let projectId: string;
  let planId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, developer, 'developer');
    ({ planId } = await createActivePlan(projectId, owner));

    // Two pending reviewers + one already-approved reviewer so plan_reviewers
    // notifications can prove that only `pending` rows are surfaced.
    await testPrisma.planReview.create({
      data: { planId, reviewerName: reviewerA, status: 'pending' },
    });
    await testPrisma.planReview.create({
      data: { planId, reviewerName: reviewerB, status: 'pending' },
    });
    await testPrisma.planReview.create({
      data: { planId, reviewerName: 'r116-already-approved', status: 'approved' },
    });
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  beforeEach(() => {
    resetNotifyRateLimit();
  });

  // ----------------------------------------------------------- chat ----

  describe('POST /chat', () => {
    it('rejects a non-member with 403 FORBIDDEN', async () => {
      const res = await chatPost(
        makeReq(`/api/projects/${projectId}/chat`, {
          method: 'POST',
          userName: outsider,
          body: { message: 'hello' },
        }),
        { params: Promise.resolve({ projectId }) },
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('rejects an empty message with 400 VALIDATION_ERROR', async () => {
      const res = await chatPost(
        makeReq(`/api/projects/${projectId}/chat`, {
          method: 'POST',
          userName: owner,
          body: { message: '' },
        }),
        { params: Promise.resolve({ projectId }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a history block longer than 20 entries with 400', async () => {
      const tooLongHistory = Array.from({ length: 21 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `entry ${i}`,
      }));
      const res = await chatPost(
        makeReq(`/api/projects/${projectId}/chat`, {
          method: 'POST',
          userName: owner,
          body: { message: 'still here?', history: tooLongHistory },
        }),
        { params: Promise.resolve({ projectId }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns a reply when AI is available (mock provider)', async () => {
      // Sanity-check that the test environment is running with the mock
      // provider — otherwise the assertion below would silently degrade
      // into "non-empty string from a real LLM" and lose its bite.
      expect(aiClient.providerName).toBe('mock');

      const res = await chatPost(
        makeReq(`/api/projects/${projectId}/chat`, {
          method: 'POST',
          userName: developer,
          body: { message: 'what should I work on?' },
        }),
        { params: Promise.resolve({ projectId }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.reply).toBe('string');
      expect(body.reply.length).toBeGreaterThan(0);
      // The chat mock is keyed off the chat system prompt and returns a
      // stable fixed string. Asserting the prefix keeps the test resilient
      // to small wording tweaks while still proving the dispatcher routed
      // the call through the chat capability rather than (e.g.) plan-diff.
      expect(body.reply).toMatch(/^Mock chat reply/);
    });
  });

  // ---------------------------------------------------------- notify ----

  describe('POST /notify', () => {
    it('returns 400 BAD_REQUEST when type is missing', async () => {
      const res = await notifyPost(
        makeReq(`/api/projects/${projectId}/notify`, {
          method: 'POST',
          userName: owner,
          body: { planId },
        }),
        { params: Promise.resolve({ projectId }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('BAD_REQUEST');
      expect(body.error.message).toMatch(/type and planId/);
    });

    it('returns 400 BAD_REQUEST when planId is missing', async () => {
      const res = await notifyPost(
        makeReq(`/api/projects/${projectId}/notify`, {
          method: 'POST',
          userName: owner,
          body: { type: 'plan_owner' },
        }),
        { params: Promise.resolve({ projectId }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('BAD_REQUEST');
    });

    it('returns 400 BAD_REQUEST for an unknown notify type', async () => {
      const res = await notifyPost(
        makeReq(`/api/projects/${projectId}/notify`, {
          method: 'POST',
          userName: owner,
          body: { type: 'plan_unknown', planId },
        }),
        { params: Promise.resolve({ projectId }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('BAD_REQUEST');
      expect(body.error.message).toMatch(/Unknown notify type/);
    });

    it('returns 404 NOT_FOUND when planId does not match the project', async () => {
      const res = await notifyPost(
        makeReq(`/api/projects/${projectId}/notify`, {
          method: 'POST',
          userName: owner,
          body: { type: 'plan_owner', planId: 'cl_does_not_exist_zzz' },
        }),
        { params: Promise.resolve({ projectId }) },
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('plan_reviewers returns the pending reviewers and ignores approved rows', async () => {
      const res = await notifyPost(
        makeReq(`/api/projects/${projectId}/notify`, {
          method: 'POST',
          userName: owner,
          body: { type: 'plan_reviewers', planId },
        }),
        { params: Promise.resolve({ projectId }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      // Both pending reviewers are returned; the approved reviewer is not.
      expect(new Set(body.sent)).toEqual(new Set([reviewerA, reviewerB]));
      expect(body.sent).not.toContain('r116-already-approved');
    });

    it('plan_reviewers returns sent: [] when there are no pending reviewers', async () => {
      // Spin up a fresh plan with zero pending review rows so the early-out
      // branch can be observed without disturbing the suite-level fixtures.
      // R-048 enforces "at most one active plan per project" — the helper
      // would normally bump versions but a quick draft row is enough here.
      const draft = await testPrisma.plan.create({
        data: {
          projectId,
          title: 'R-116 draft no reviewers',
          goal: 'no reviewers branch',
          scope: 's',
          version: 99,
          status: 'draft',
          createdBy: owner,
          constraints: [],
          standards: [],
          deliverables: [],
          openQuestions: [],
          requiredReviewers: [],
        },
      });

      try {
        const res = await notifyPost(
          makeReq(`/api/projects/${projectId}/notify`, {
            method: 'POST',
            userName: owner,
            body: { type: 'plan_reviewers', planId: draft.id },
          }),
          { params: Promise.resolve({ projectId }) },
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.sent).toEqual([]);
      } finally {
        await testPrisma.plan.delete({ where: { id: draft.id } });
      }
    });

    it('plan_owner returns the plan owner exactly once', async () => {
      const res = await notifyPost(
        makeReq(`/api/projects/${projectId}/notify`, {
          method: 'POST',
          userName: owner,
          body: { type: 'plan_owner', planId },
        }),
        { params: Promise.resolve({ projectId }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sent).toEqual([owner]);
    });
  });

  // -------------------------------------------------------- ai-draft ----

  describe('POST /plans/ai-draft', () => {
    it('rejects a non-member with 403 FORBIDDEN', async () => {
      const res = await aiDraftPost(
        makeReq(`/api/projects/${projectId}/plans/ai-draft`, {
          method: 'POST',
          userName: outsider,
          body: { title: 'New plan' },
        }),
        { params: Promise.resolve({ projectId }) },
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('rejects a missing title with 400 VALIDATION_ERROR', async () => {
      const res = await aiDraftPost(
        makeReq(`/api/projects/${projectId}/plans/ai-draft`, {
          method: 'POST',
          userName: owner,
          body: { description: 'no title' },
        }),
        { params: Promise.resolve({ projectId }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a title longer than 200 characters with 400', async () => {
      const res = await aiDraftPost(
        makeReq(`/api/projects/${projectId}/plans/ai-draft`, {
          method: 'POST',
          userName: owner,
          body: { title: 'x'.repeat(201) },
        }),
        { params: Promise.resolve({ projectId }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 502 when the AI response is not valid JSON', async () => {
      // The mock provider's chat fallback (matching system prompts that
      // start with "You are PlanSync AI") returns a plain-text sentence.
      // ai-draft requires a JSON object — it must surface that mismatch
      // as a 502 instead of crashing or silently returning the raw text.
      expect(aiClient.providerName).toBe('mock');

      const res = await aiDraftPost(
        makeReq(`/api/projects/${projectId}/plans/ai-draft`, {
          method: 'POST',
          userName: owner,
          body: { title: 'New plan', description: 'context' },
        }),
        { params: Promise.resolve({ projectId }) },
      );
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toMatch(/AI response was not valid JSON/);
      expect(typeof body.raw).toBe('string');
    });
  });

  // -------------------------------------------------------- ai-field ----

  describe('POST /plans/ai-field', () => {
    it('rejects a non-member with 403 FORBIDDEN', async () => {
      const res = await aiFieldPost(
        makeReq(`/api/projects/${projectId}/plans/ai-field`, {
          method: 'POST',
          userName: outsider,
          body: { field: 'goal', currentValue: '', title: 'New plan' },
        }),
        { params: Promise.resolve({ projectId }) },
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('rejects an unknown field with 400 VALIDATION_ERROR', async () => {
      const res = await aiFieldPost(
        makeReq(`/api/projects/${projectId}/plans/ai-field`, {
          method: 'POST',
          userName: owner,
          body: { field: 'not-a-field', currentValue: '', title: 'New plan' },
        }),
        { params: Promise.resolve({ projectId }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects currentValue larger than 5000 characters with 400', async () => {
      const res = await aiFieldPost(
        makeReq(`/api/projects/${projectId}/plans/ai-field`, {
          method: 'POST',
          userName: owner,
          body: {
            field: 'goal',
            currentValue: 'x'.repeat(5001),
            title: 'New plan',
          },
        }),
        { params: Promise.resolve({ projectId }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns a suggestion string for every accepted field', async () => {
      // ai-field returns plain text; the chat-fallback mock satisfies that
      // contract, so we get a stable suggestion for each enum value.
      expect(aiClient.providerName).toBe('mock');

      const fields = [
        'goal',
        'scope',
        'constraints',
        'standards',
        'deliverables',
        'openQuestions',
      ] as const;

      for (const field of fields) {
        const res = await aiFieldPost(
          makeReq(`/api/projects/${projectId}/plans/ai-field`, {
            method: 'POST',
            userName: developer,
            body: {
              field,
              currentValue: 'existing text',
              title: 'New plan',
              goal: 'to ship faster',
            },
          }),
          { params: Promise.resolve({ projectId }) },
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(typeof body.suggestion).toBe('string');
        expect(body.suggestion.length).toBeGreaterThan(0);
      }
    });
  });
});
