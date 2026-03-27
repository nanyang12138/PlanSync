import { z } from 'zod';

export const suggestionFieldSchema = z.enum([
  'goal',
  'scope',
  'constraints',
  'standards',
  'deliverables',
  'openQuestions',
]);

export const suggestionActionSchema = z.enum(['set', 'append', 'remove']);
export const suggestionStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'conflict']);

export const createSuggestionSchema = z.object({
  field: suggestionFieldSchema,
  action: suggestionActionSchema,
  value: z.string().min(1),
  reason: z.string().min(1),
});

export const resolveSuggestionSchema = z.object({
  comment: z.string().optional(),
});

export const suggestionSchema = z.object({
  id: z.string(),
  planId: z.string(),
  suggestedBy: z.string(),
  suggestedByType: z.enum(['human', 'agent']),
  field: suggestionFieldSchema,
  action: suggestionActionSchema,
  value: z.string(),
  reason: z.string(),
  status: suggestionStatusSchema,
  resolvedBy: z.string().nullable(),
  resolvedComment: z.string().nullable(),
  createdAt: z.coerce.date(),
  resolvedAt: z.coerce.date().nullable(),
});
