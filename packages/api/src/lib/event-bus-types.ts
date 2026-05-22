/**
 * Event bus type definitions shared by the in-memory and Postgres
 * LISTEN/NOTIFY backends (R-088).
 */

export type PlanSyncEventType =
  | 'plan_created'
  | 'plan_proposed'
  | 'plan_activated'
  | 'plan_draft_updated'
  | 'drift_detected'
  | 'drift_resolved'
  | 'task_created'
  | 'task_assigned'
  | 'task_unassigned'
  | 'task_started'
  | 'task_completed'
  | 'execution_stale'
  // Drift v2: emitted when a run transitions to `superseded` outside the
  // normal complete/fail/cancel paths — today only from the pause-ack
  // timeout scanner; future ack_pause endpoint will reuse this type.
  | 'execution_superseded'
  | 'suggestion_created'
  | 'suggestion_resolved'
  | 'comment_added'
  | 'member_added'
  | 'member_removed'
  | 'review_requested'
  | 'review_approved'
  | 'review_rejected'
  | 'member_updated'
  | 'comment_updated'
  | 'comment_deleted'
  // #130: synthetic event the Postgres LISTEN client emits to local
  // subscribers after a reconnect so SSE consumers know to refetch the
  // canonical state (NOTIFY messages emitted during the disconnect window
  // are dropped by Postgres). The `data` payload always carries
  // `_resyncRequired: true` and is otherwise empty. Once R-160/R-163
  // (B14 outbox + lastEventId replay) lands this becomes redundant.
  | 'bus_resync_required';

export interface PlanSyncEvent {
  type: PlanSyncEventType;
  projectId: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export type Listener = (event: PlanSyncEvent) => void;

export interface EventBusInterface {
  subscribe(projectId: string, listener: Listener): () => void;
  subscribeUser(userName: string, listener: Listener): () => void;
  publish(projectId: string, type: PlanSyncEventType, data: Record<string, unknown>): void;
  publishToUser(
    userName: string,
    type: PlanSyncEventType,
    projectId: string,
    data: Record<string, unknown>,
  ): void;
  getClientCount(projectId?: string): number;
}
