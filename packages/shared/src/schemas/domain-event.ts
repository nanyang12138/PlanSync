import { z } from 'zod';

/**
 * R-160: shared schema for outbox payloads.
 *
 * Every row written to `domain_events.payload` must validate against
 * `domainEventPayloadSchema`. The schema is a discriminated union over
 * `type`, so consumers (R-162 worker, R-163 SSE relay, R-164 webhook
 * dispatcher, R-165 email queue) can `switch (event.type)` exhaustively and
 * the TypeScript compiler will refine `data` for each branch.
 *
 * The set of `type` literals here is intentionally a superset of the legacy
 * `PlanSyncEventType` (event-bus-types.ts) plus a handful of types that
 * today only flow through `createActivity` (project_created, member_added,
 * task_started, ...). Once R-161 replaces every `eventBus.publish` /
 * `createActivity` call site with `outbox.emit`, this is the single source
 * of truth for the event shape.
 *
 * Notes on naming:
 *   - `data` (NOT `payload`) for the per-event body, mirroring the existing
 *     `PlanSyncEvent.data` shape so consumers do not need to rewrite their
 *     destructuring during the R-161 migration.
 *   - All variants share `type` (the discriminator). `projectId` is on the
 *     envelope rather than inside each `data` because the outbox table
 *     stores it in its own indexed column for fan-out routing.
 */

const emptyData = z.record(z.string(), z.unknown()).default({});

/**
 * The union of every event type that may appear in `domain_events`. Keep
 * this list aligned with `PlanSyncEventType` plus the `activityTypeSchema`
 * vocabulary in `common.ts` — the discriminated union below will refuse to
 * compile if a literal is referenced but missing from this list.
 */
export const domainEventTypeSchema = z.enum([
  // Plan lifecycle
  'plan_created',
  'plan_proposed',
  'plan_activated',
  'plan_reactivated',
  'plan_updated',
  'plan_superseded',
  'plan_draft_updated',
  // Drift lifecycle
  'drift_detected',
  'drift_resolved',
  // Task lifecycle
  'task_created',
  'task_assigned',
  'task_unassigned',
  'task_started',
  'task_completed',
  'task_cancelled',
  'task_claimed',
  'task_declined',
  'task_rebound',
  // Execution lifecycle
  'execution_started',
  'execution_stale',
  'execution_failed',
  'execution_superseded',
  // Review / suggestion / comment
  'review_requested',
  'review_approved',
  'review_rejected',
  'suggestion_created',
  'suggestion_resolved',
  'suggestion_accepted',
  'suggestion_rejected',
  'comment_added',
  'comment_updated',
  'comment_deleted',
  // Project / member
  'project_created',
  'project_updated',
  'project_closed',
  'project_reopened',
  'member_added',
  'member_removed',
  'member_updated',
  // Infrastructure / synthetic
  'bus_resync_required',
]);
export type DomainEventType = z.infer<typeof domainEventTypeSchema>;

/**
 * Discriminated union over event type. Today each branch carries a generic
 * `data: Record<string, unknown>` because the producer call sites still emit
 * heterogeneous shapes — but the union form is required up-front so that
 * R-161 can tighten each branch without a second migration of the schema
 * shape.
 */
function eventVariant<T extends DomainEventType>(type: T) {
  return z.object({
    type: z.literal(type),
    projectId: z.string().nullable().optional(),
    userName: z.string().nullable().optional(),
    data: emptyData,
  });
}

export const domainEventPayloadSchema = z.discriminatedUnion('type', [
  eventVariant('plan_created'),
  eventVariant('plan_proposed'),
  eventVariant('plan_activated'),
  eventVariant('plan_reactivated'),
  eventVariant('plan_updated'),
  eventVariant('plan_superseded'),
  eventVariant('plan_draft_updated'),
  eventVariant('drift_detected'),
  eventVariant('drift_resolved'),
  eventVariant('task_created'),
  eventVariant('task_assigned'),
  eventVariant('task_unassigned'),
  eventVariant('task_started'),
  eventVariant('task_completed'),
  eventVariant('task_cancelled'),
  eventVariant('task_claimed'),
  eventVariant('task_declined'),
  eventVariant('task_rebound'),
  eventVariant('execution_started'),
  eventVariant('execution_stale'),
  eventVariant('execution_failed'),
  eventVariant('execution_superseded'),
  eventVariant('review_requested'),
  eventVariant('review_approved'),
  eventVariant('review_rejected'),
  eventVariant('suggestion_created'),
  eventVariant('suggestion_resolved'),
  eventVariant('suggestion_accepted'),
  eventVariant('suggestion_rejected'),
  eventVariant('comment_added'),
  eventVariant('comment_updated'),
  eventVariant('comment_deleted'),
  eventVariant('project_created'),
  eventVariant('project_updated'),
  eventVariant('project_closed'),
  eventVariant('project_reopened'),
  eventVariant('member_added'),
  eventVariant('member_removed'),
  eventVariant('member_updated'),
  eventVariant('bus_resync_required'),
]);
export type DomainEventPayload = z.infer<typeof domainEventPayloadSchema>;
