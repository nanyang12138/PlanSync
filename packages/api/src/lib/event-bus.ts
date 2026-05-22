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

/**
 * Resolves whether silent fallback to the in-memory bus is allowed when the
 * Postgres backend fails to initialise.
 *
 * R-088 / review #127: a silent fallback in production re-introduces exactly
 * the cross-instance event-drop bug this remediation closes. We therefore:
 *
 *   - production (NODE_ENV=production) — throw by default; operator must
 *     explicitly set `PLANSYNC_EVENT_BUS_ALLOW_FALLBACK=true` to opt in.
 *   - non-production — fall back silently (preserves dev / test ergonomics
 *     where `pg` may genuinely be unavailable).
 *
 * When the operator explicitly asked for `PLANSYNC_EVENT_BUS=postgres`, the
 * fallback is ALWAYS rejected regardless of environment — the explicit value
 * is treated as a contract.
 */
function allowFallback(explicit: string | undefined): boolean {
  if (explicit === 'postgres') return false;
  if (process.env.PLANSYNC_EVENT_BUS_ALLOW_FALLBACK === 'true') return true;
  return process.env.NODE_ENV !== 'production';
}

function createEventBus(): EventBusInterface {
  const explicit = process.env.PLANSYNC_EVENT_BUS;
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
      if (!allowFallback(explicit)) {
        logger.error(
          { err, env: process.env.NODE_ENV, explicit },
          'EventBusPG failed to initialise and fallback is forbidden in this ' +
            'configuration. Set PLANSYNC_EVENT_BUS_ALLOW_FALLBACK=true to opt ' +
            'into the lossy memory backend (cross-instance SSE will be dropped).',
        );
        throw err;
      }
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
