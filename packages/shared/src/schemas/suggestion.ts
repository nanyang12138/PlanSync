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

const stringFields = ['goal', 'scope'] as const;
const arrayFields = ['constraints', 'standards', 'deliverables', 'openQuestions'] as const;

export const createSuggestionSchema = z
  .object({
    field: suggestionFieldSchema,
    action: suggestionActionSchema,
    value: z.string().min(1),
    reason: z.string().min(1),
  })
  .refine(
    (data) => {
      if (data.action === 'set')
        return stringFields.includes(data.field as (typeof stringFields)[number]);
      return arrayFields.includes(data.field as (typeof arrayFields)[number]);
    },
    {
      message:
        'Invalid field/action combination: "set" only for goal/scope, "append"/"remove" only for array fields',
    },
  );

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
