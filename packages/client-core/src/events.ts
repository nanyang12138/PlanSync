/**
 * R-200: Client-facing view of domain events.
 *
 * The shared `domainEventPayloadSchema` (in `@plansync/shared`) is a
 * discriminated union over `type` with a generic `data: Record<string,
 * unknown>` body. Stores need slightly different ergonomics than the raw
 * outbox row:
 *
 *   - They need to know which entity the event is about (`taskId`,
 *     `planId`, `driftId`, `runId`) without parsing free-form `data`
 *     fields the way the API does.
 *   - They need an opaque `eventId` + `seq` so duplicate / out-of-order
 *     delivery from the SSE layer can be detected and ignored.
 *
 * This thin wrapper keeps the client decoupled from the server's outbox
 * row shape while still validating the discriminator. Transports turn
 * SSE messages into `DomainEvent` values before calling
 * `storeRegistry.handleEvent(...)`.
 */
import type { DomainEventType } from '@plansync/shared';

export interface DomainEvent<T extends DomainEventType = DomainEventType> {
  /** Opaque per-delivery id. Stores dedupe by this. */
  eventId: string;
  /** Monotonic per-project sequence number; gaps trigger resync. */
  seq?: number;
  type: T;
  projectId?: string | null;
  /**
   * Source user / agent name as recorded by the producer. Optional so
   * that synthetic resync / heartbeat events don't need to fabricate
   * one.
   */
  userName?: string | null;
  /**
   * Free-form per-event body. The stores narrow this further per type;
   * raw `unknown` is preserved so unknown event types are still routable
   * (and ignored) without hard schema errors.
   */
  data: Record<string, unknown>;
  /** Server-stamped occurredAt. Falls back to receive time on the wire. */
  occurredAt?: Date | string;
}

/** Type guard used by stores to narrow `event.type` cheaply. */
export function isEventOfType<T extends DomainEventType>(
  event: DomainEvent,
  ...types: T[]
): event is DomainEvent<T> {
  return (types as DomainEventType[]).includes(event.type);
}
