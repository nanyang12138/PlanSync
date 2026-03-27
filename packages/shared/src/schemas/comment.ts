import { z } from 'zod';

export const createCommentSchema = z.object({
  content: z.string().min(1).max(10000),
  parentId: z.string().optional(),
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
  isDeleted: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
