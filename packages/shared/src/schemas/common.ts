import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const actorTypeSchema = z.enum(['human', 'agent', 'system']);

export const activityTypeSchema = z.enum([
  'plan_created',
  'plan_proposed',
  'plan_activated',
  'plan_superseded',
  'plan_reactivated',
  'plan_updated',
  'review_approved',
  'review_rejected',
  'suggestion_created',
  'suggestion_accepted',
  'suggestion_rejected',
  'task_created',
  'task_claimed',
  'task_started',
  'task_completed',
  'task_cancelled',
  'task_rebound',
  'drift_detected',
  'drift_resolved',
  'member_added',
  'member_removed',
  'execution_started',
  'execution_completed',
  'execution_failed',
]);

export const createActivitySchema = z.object({
  projectId: z.string(),
  type: activityTypeSchema,
  actorName: z.string(),
  actorType: actorTypeSchema,
  summary: z.string(),
  metadata: z.record(z.unknown()).optional(),
});

export const activitySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  type: activityTypeSchema,
  actorName: z.string(),
  actorType: actorTypeSchema,
  summary: z.string(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.coerce.date(),
});
