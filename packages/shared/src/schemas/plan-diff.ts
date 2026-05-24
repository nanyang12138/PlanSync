// R-145: shared zod schema for the `PlanDiff.changes` JSON column.
//
// The API stores the AI-generated semantic plan diff in
// `plan_diffs.changes` as Postgres JSON. Without a schema, every reader
// (drift engine, plans page, AI impact analysis) does its own narrow
// projection of the shape, and any model-side drift or stale row goes
// undetected — the columns just silently misbehave downstream.
//
// `planDiffChangesSchema` is the canonical shape. The API:
//   • parses() the AI output before writing the row (hard reject), and
//   • safeParse()s on the read hot path; if a cached row no longer
//     matches the schema it is treated as stale and re-computed.
//
// Shape mirrors `planDiffResultZ` in
// `packages/api/src/lib/ai/schemas/index.ts`; a contract test under
// `packages/api/tests/unit/r145-plan-diff-schema-drift.test.ts` asserts
// the two stay equivalent, so this file is the single source of truth
// for what an on-disk `PlanDiff.changes` row is allowed to contain.
import { z } from 'zod';

export const planDiffAspectSchema = z.enum([
  'goal',
  'scope',
  'constraints',
  'standards',
  'deliverables',
  'openQuestions',
]);

export const planDiffChangeTypeSchema = z.enum(['added', 'removed', 'modified']);

export const planDiffImpactSchema = z.enum(['high', 'medium', 'low']);

export const planDiffChangeSchema = z.object({
  aspect: planDiffAspectSchema,
  type: planDiffChangeTypeSchema,
  from: z.string().nullable(),
  to: z.string().nullable(),
  impact: planDiffImpactSchema,
  description: z.string(),
  affectedAreas: z.array(z.string()),
});

// The top-level row payload. `passthrough()` here is intentional: the
// downgrade path in `getOrCreatePlanDiff` attaches an opaque `_meta`
// object (R-187 verifier audit trail) which is not part of the typed
// contract but must round-trip through the DB unmodified. Keeping the
// schema strict on the listed keys + lenient on the optional `_meta`
// envelope gives us the validation we want without losing audit data.
export const planDiffChangesSchema = z
  .object({
    changes: z.array(planDiffChangeSchema),
    summary: z.string(),
    breakingChanges: z.boolean(),
  })
  .passthrough();

export type PlanDiffChange = z.infer<typeof planDiffChangeSchema>;
export type PlanDiffChanges = z.infer<typeof planDiffChangesSchema>;
