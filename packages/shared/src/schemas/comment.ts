import { z } from 'zod';

export const createCommentSchema = z.object({
  content: z.string().min(1).max(10000),
  parentId: z.string().optional(),
  // R-156: optionally anchor the comment to a specific PlanDeliverable row
  // so the deliverable-timeline UI can render a thread next to the card.
  // Routes validate that the deliverable belongs to the same plan before
  // accepting the value (cross-plan ids are rejected with NOT_FOUND, same
  // contract as `parentId`).
  deliverableId: z.string().optional(),
});

export const updateCommentSchema = z.object({
  content: z.string().min(1).max(10000),
});

export const commentSchema = z.object({
  id: z.string(),
  planId: z.string(),
  authorName: z.string(),
  authorType: z.enum(['human', 'agent']),
  content: z.string(),
  parentId: z.string().nullable(),
  deliverableId: z.string().nullable(),
  isDeleted: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

// R-156 + Issue #1256 follow-up: list-comments query parameters.
//
// Two surfaces share the same route, distinguished by the `deliverableId`
// query param:
//
//   - `?deliverableId=<id>` → comments anchored to that PlanDeliverable
//     (used by the deliverable-timeline page to render a focused thread).
//   - (no `deliverableId`)  → PLAN-LEVEL comments only, i.e. rows where
//     `deliverableId IS NULL`. This is what the legacy plan Comments
//     sidebar wants. We deliberately do NOT return a mixed listing here:
//     mixing per-deliverable threads into the plan sidebar broke the
//     "one discussion per surface" UX (Issue #1256).
//
// Issue #1356: `?deliverableId=` (empty value, common URL serialization
// for an unselected filter) MUST be treated as "no filter" — without the
// transform below the empty string flows into the Prisma `where` clause
// as a literal id, silently returning an empty list instead of either
// plan-level comments or a 400. Coercing empty → undefined picks the
// more user-friendly of the two acceptable behaviours called out in the
// finding (plan-level comments), and keeps the contract symmetric with
// the omitted-param case.
export const listCommentsQuerySchema = z.object({
  deliverableId: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
});
