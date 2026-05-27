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
    // R-155: optional pointer at a specific PlanDeliverable row this
    // suggestion is about. Lets an agent target one row instead of
    // rewriting the whole deliverables[] array. The API verifies the
    // deliverable belongs to the same plan; if omitted the suggestion
    // behaves exactly as before (field-level patch).
    //
    // Issue #1146: when `field='deliverables'` AND `deliverableId` is set,
    // the owner accept path mutates the targeted PlanDeliverable row
    // instead of the legacy array:
    //   - action='remove' → set the row's `status` to 'deprecated'
    //     (preserves row identity, supersede chain, task / commit links).
    //   - action='append' → overwrite the row's `body` with `value`.
    //   - action='set'    → rejected at validation (set only on goal/scope).
    // Richer per-row mutations (title / refType / refUri) still flow
    // through `plansync_deliverable_update`; the suggestion shape only
    // carries one `value` so it cannot encode multi-field patches.
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
  // R-155: optional pointer at the specific PlanDeliverable this
  // suggestion targets. Nullable for legacy/field-level suggestions.
  deliverableId: z.string().nullable().optional(),
  createdAt: z.coerce.date(),
  resolvedAt: z.coerce.date().nullable(),
});
