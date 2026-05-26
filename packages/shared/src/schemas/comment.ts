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

// R-156: list-comments query parameters. Lets the deliverable-timeline page
// pull comments for a single deliverable without scanning the whole plan
// thread client-side. Kept additive: when neither field is set the route
// returns all comments (existing behaviour).
export const listCommentsQuerySchema = z.object({
  deliverableId: z.string().optional(),
});
