import { describe, it, expect } from 'vitest';
import { planReviewSchema } from '../../src/schemas/plan';

// R-030: planReviewSchema must preserve `focusNotes` because the API and Prisma layer
// already carry that column (see packages/api/prisma/schema.prisma `PlanReview.focusNotes`
// and packages/api/src/app/api/projects/[projectId]/plans/[planId]/propose/route.ts).
// Before R-030 the shared zod schema lacked the field, so any client that parsed an API
// response through `planReviewSchema` silently stripped owner-specified review focus.

describe('planReviewSchema — focusNotes (R-030)', () => {
  const baseReview = {
    id: 'rev_01H',
    planId: 'plan_01H',
    reviewerName: 'genie',
    status: 'pending' as const,
    comment: null,
    createdAt: '2026-05-20T12:00:00.000Z',
    updatedAt: '2026-05-20T12:00:00.000Z',
  };

  it('preserves a non-empty focusNotes value coming from the API response', () => {
    const parsed = planReviewSchema.parse({
      ...baseReview,
      focusNotes: 'Please verify the auth flow and rate limits.',
    });

    expect(parsed.focusNotes).toBe('Please verify the auth flow and rate limits.');
  });

  it('accepts focusNotes as null (Prisma returns null when unset)', () => {
    const parsed = planReviewSchema.parse({
      ...baseReview,
      focusNotes: null,
    });

    expect(parsed.focusNotes).toBeNull();
  });

  it('accepts the field being omitted entirely (backwards compatible)', () => {
    const parsed = planReviewSchema.parse(baseReview);

    expect(parsed.focusNotes).toBeUndefined();
    expect(parsed.reviewerName).toBe('genie');
  });

  it('rejects non-string, non-null focusNotes values', () => {
    const result = planReviewSchema.safeParse({
      ...baseReview,
      focusNotes: 42,
    });

    expect(result.success).toBe(false);
  });

  it('parses a realistic /api/my-work review record without dropping focusNotes', () => {
    // Shape mirrors packages/api/src/app/api/my-work/route.ts:130-141 with the additional
    // server-side fields a full /reviews endpoint would expose.
    const apiResponse = {
      id: 'rev_real',
      planId: 'plan_real',
      reviewerName: 'alice',
      status: 'approved',
      comment: 'LGTM with the security note.',
      focusNotes: 'Focus on the new webhook signature scheme.',
      createdAt: '2026-05-21T09:30:00.000Z',
      updatedAt: '2026-05-21T10:15:00.000Z',
    };

    const parsed = planReviewSchema.parse(apiResponse);
    expect(parsed.focusNotes).toBe('Focus on the new webhook signature scheme.');
    expect(parsed.status).toBe('approved');
  });
});
