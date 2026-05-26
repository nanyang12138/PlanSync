import { z } from 'zod';

export const driftTypeSchema = z.enum(['version_mismatch']);
export const driftSeveritySchema = z.enum(['high', 'medium', 'low']);
export const driftStatusSchema = z.enum(['open', 'resolved']);

// User-facing PATCH action. The four legitimate operator answers are
// rebind / cancel / no_impact. `superseded` is system-only — written
// by the drift engine in `persistDriftAlerts` to retire prior open
// alerts when a new plan version supersedes an older one — and must
// NOT be accepted from the client. Keep this enum tight on purpose
// so the request validator at PATCH /api/projects/:projectId/drifts/:driftId
// continues to reject `{ action: "superseded" }` from the network.
export const driftResolveActionSchema = z.enum(['rebind', 'cancel', 'no_impact']);

// Persisted / read-side value. Mirrors the `resolved_action` column
// (see prisma/schema.prisma comment: `rebind | cancel | no_impact |
// superseded`). Used in `driftAlertSchema.resolvedAction` so a client
// reading a drift row written by the engine doesn't fail validation
// on a legitimately-superseded alert (closes #709).
export const driftResolvedActionSchema = z.enum(['rebind', 'cancel', 'no_impact', 'superseded']);

export const resolveDriftSchema = z.object({
  action: driftResolveActionSchema,
});

export const driftAlertSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  type: driftTypeSchema,
  severity: driftSeveritySchema,
  reason: z.string(),
  status: driftStatusSchema,
  resolvedAction: driftResolvedActionSchema.nullable(),
  currentPlanVersion: z.number().int(),
  taskBoundVersion: z.number().int(),
  compatibilityScore: z.number().nullable(),
  impactAnalysis: z.string().nullable(),
  suggestedAction: z.string().nullable(),
  affectedAreas: z.array(z.string()).default([]),
  planDiffId: z.string().nullable().default(null),
  createdAt: z.coerce.date(),
  resolvedAt: z.coerce.date().nullable(),
  resolvedBy: z.string().nullable(),
});
