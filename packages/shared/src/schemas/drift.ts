import { z } from 'zod';

export const driftTypeSchema = z.enum(['version_mismatch']);
export const driftSeveritySchema = z.enum(['high', 'medium', 'low']);
export const driftStatusSchema = z.enum(['open', 'resolved']);
export const driftResolveActionSchema = z.enum(['rebind', 'cancel', 'no_impact']);

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
  resolvedAction: driftResolveActionSchema.nullable(),
  currentPlanVersion: z.number().int(),
  taskBoundVersion: z.number().int(),
  compatibilityScore: z.number().nullable(),
  impactAnalysis: z.string().nullable(),
  suggestedAction: z.string().nullable(),
  createdAt: z.coerce.date(),
  resolvedAt: z.coerce.date().nullable(),
  resolvedBy: z.string().nullable(),
});
