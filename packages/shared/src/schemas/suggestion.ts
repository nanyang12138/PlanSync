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
    // R-155: optional pointer to a specific PlanDeliverable. When set,
    // the suggestion is recorded against that deliverable so the owner
    // can route per-item proposals (e.g. "rename the OIDC deliverable",
    // "deprecate the legacy callback ref") without rewriting the whole
    // `deliverables` array. The deliverable must belong to the plan
    // being commented on; the API rejects cross-plan references.
    // Only meaningful when `field === 'deliverables'` — present-with-
    // any-other-field is allowed at the schema level (for forward
    // compatibility with future per-item fields) but the API records
    // it as advisory metadata only.
    deliverableId: z.string().min(1).optional(),
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
  // R-155: optional FK to PlanDeliverable; nullable in DB to preserve
  // pre-R-155 suggestion rows and to keep the audit trail when a
  // deliverable is deleted (ON DELETE SET NULL on the FK).
  deliverableId: z.string().nullable().optional(),
});
