import { logger } from './logger';
import { MemoryEventBus } from './event-bus-memory';
import type {
  EventBusInterface,
  PlanSyncEvent,
  PlanSyncEventType,
  Listener,
} from './event-bus-types';

export type { PlanSyncEvent, PlanSyncEventType, EventBusInterface, Listener };

/**
 * Resolves which event-bus implementation to instantiate.
 *
 * - `PLANSYNC_EVENT_BUS=postgres` → multi-process safe LISTEN/NOTIFY backend.
 * - `PLANSYNC_EVENT_BUS=memory` → in-process EventEmitter-style fanout.
 * - When unset: `postgres` in production, `memory` everywhere else (so unit
 *   tests, dev servers, and `vitest run` do not need a live pg connection).
 *
 * R-088: an in-memory bus cannot deliver SSE events across instances. In
 * production deployments with more than one API process the memory backend
 * silently drops cross-instance events, which is exactly the symptom this
 * remediation closes.
 */
function resolveBackend(): 'memory' | 'postgres' {
  const explicit = process.env.PLANSYNC_EVENT_BUS;
  if (explicit === 'memory' || explicit === 'postgres') return explicit;
  if (explicit) {
    logger.warn({ value: explicit }, 'Unknown PLANSYNC_EVENT_BUS value; falling back to default');
  }
  return process.env.NODE_ENV === 'production' ? 'postgres' : 'memory';
}

function createEventBus(): EventBusInterface {
  const backend = resolveBackend();
  if (backend === 'postgres') {
    try {
      // Lazy require keeps the `pg` dependency out of cold paths (e.g. CLI
      // bundles that import shared types but never serve SSE).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { EventBusPG } = require('./event-bus-pg') as typeof import('./event-bus-pg');
      logger.info('EventBus: using Postgres LISTEN/NOTIFY backend');
      return new EventBusPG();
    } catch (err) {
      logger.error(
        { err },
        'Failed to initialise EventBusPG; falling back to in-memory bus. ' +
          'Cross-instance SSE events will be dropped until the issue is resolved.',
      );
      return new MemoryEventBus();
    }
  }
  logger.debug('EventBus: using in-memory backend');
  return new MemoryEventBus();
}

const globalForBus = globalThis as unknown as { eventBus: EventBusInterface | undefined };
export const eventBus: EventBusInterface = globalForBus.eventBus ?? createEventBus();
if (process.env.NODE_ENV !== 'production') globalForBus.eventBus = eventBus;
