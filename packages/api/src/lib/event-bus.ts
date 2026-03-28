import { logger } from './logger';

export type PlanSyncEventType =
  | 'plan_created'
  | 'plan_proposed'
  | 'plan_activated'
  | 'plan_draft_updated'
  | 'drift_detected'
  | 'drift_resolved'
  | 'task_created'
  | 'task_assigned'
  | 'task_started'
  | 'task_completed'
  | 'execution_stale'
  | 'suggestion_created'
  | 'suggestion_resolved'
  | 'comment_added'
  | 'member_added'
  | 'member_removed';

export interface PlanSyncEvent {
  type: PlanSyncEventType;
  projectId: string;
  data: Record<string, unknown>;
  timestamp: string;
}

type Listener = (event: PlanSyncEvent) => void;

class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(projectId: string, listener: Listener): () => void {
    if (!this.listeners.has(projectId)) {
      this.listeners.set(projectId, new Set());
    }
    this.listeners.get(projectId)!.add(listener);
    logger.debug(
      { projectId, count: this.listeners.get(projectId)!.size },
      'SSE client subscribed',
    );

    return () => {
      const set = this.listeners.get(projectId);
      if (set) {
        set.delete(listener);
        if (set.size === 0) this.listeners.delete(projectId);
      }
      logger.debug({ projectId, count: set?.size ?? 0 }, 'SSE client unsubscribed');
    };
  }

  publish(projectId: string, type: PlanSyncEventType, data: Record<string, unknown>): void {
    const event: PlanSyncEvent = {
      type,
      projectId,
      data,
      timestamp: new Date().toISOString(),
    };

    const set = this.listeners.get(projectId);
    if (!set || set.size === 0) return;

    logger.debug({ projectId, type, clientCount: set.size }, 'Publishing event');
    for (const listener of set) {
      try {
        listener(event);
      } catch (err) {
        logger.error({ err, projectId, type }, 'Event listener error');
      }
    }
  }

  getClientCount(projectId?: string): number {
    if (projectId) return this.listeners.get(projectId)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

const globalForBus = globalThis as unknown as { eventBus: EventBus | undefined };
export const eventBus = globalForBus.eventBus ?? new EventBus();
if (process.env.NODE_ENV !== 'production') globalForBus.eventBus = eventBus;
