import { logger } from './logger';
import type { EventBusInterface, PlanSyncEvent, PlanSyncEventType, Listener } from './event-bus-types';

/**
 * In-process pub/sub for SSE clients. This is the original implementation and
 * remains the default when running a single API process (or any non-production
 * environment). For multi-instance production deployments use {@link EventBusPG}
 * so cross-process events are dispatched via Postgres LISTEN/NOTIFY (R-088).
 */
export class MemoryEventBus implements EventBusInterface {
  private listeners = new Map<string, Set<Listener>>();
  // Per-user channels carry events the user must hear about even when they
  // are not (yet) subscribed to the originating project — primarily
  // membership changes that grant or revoke access to a project.
  private userListeners = new Map<string, Set<Listener>>();

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

  subscribeUser(userName: string, listener: Listener): () => void {
    if (!this.userListeners.has(userName)) {
      this.userListeners.set(userName, new Set());
    }
    this.userListeners.get(userName)!.add(listener);

    return () => {
      const set = this.userListeners.get(userName);
      if (set) {
        set.delete(listener);
        if (set.size === 0) this.userListeners.delete(userName);
      }
    };
  }

  publish(projectId: string, type: PlanSyncEventType, data: Record<string, unknown>): void {
    const event: PlanSyncEvent = {
      type,
      projectId,
      data,
      timestamp: new Date().toISOString(),
    };
    this.dispatchProjectEvent(event);
  }

  publishToUser(
    userName: string,
    type: PlanSyncEventType,
    projectId: string,
    data: Record<string, unknown>,
  ): void {
    const event: PlanSyncEvent = {
      type,
      projectId,
      data,
      timestamp: new Date().toISOString(),
    };
    this.dispatchUserEvent(userName, event);
  }

  getClientCount(projectId?: string): number {
    if (projectId) return this.listeners.get(projectId)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    for (const set of this.userListeners.values()) total += set.size;
    return total;
  }

  /**
   * Dispatches a fully-formed event to local project subscribers without
   * re-creating the event envelope. Used by {@link EventBusPG} when receiving
   * a NOTIFY from a peer instance.
   *
   * @internal
   */
  dispatchProjectEvent(event: PlanSyncEvent): void {
    const set = this.listeners.get(event.projectId);
    if (!set || set.size === 0) return;

    logger.debug(
      { projectId: event.projectId, type: event.type, clientCount: set.size },
      'Publishing event',
    );
    for (const listener of set) {
      try {
        listener(event);
      } catch (err) {
        logger.error(
          { err, projectId: event.projectId, type: event.type },
          'Event listener error',
        );
      }
    }
  }

  /**
   * @internal — counterpart of {@link dispatchProjectEvent} for user channels.
   */
  dispatchUserEvent(userName: string, event: PlanSyncEvent): void {
    const set = this.userListeners.get(userName);
    if (!set || set.size === 0) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch (err) {
        logger.error({ err, userName, type: event.type }, 'User event listener error');
      }
    }
  }
}
