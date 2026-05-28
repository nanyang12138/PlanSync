// G3 / R-131 (Next.js 15) — same bug class P0-2 (#845, root cause of
// nightly e2e #143) fixed for Next 14:
// `import { Client } from 'pg'` lets webpack treat the entire dependent
// module chain as an async ESM module (because pg ships dual ESM+CJS
// exports), and route handlers that synchronously call `new EventBusPG()`
// see the unresolved async-module symbol. Result at runtime is
// `TypeError: a is not a constructor` (variable name varies by Next minor;
// pre-15 it was `e`). Loading pg via `createRequire` keeps the resolution
// synchronous + outside webpack bundling, restoring the constructor.
import { createRequire } from 'node:module';
import type { Client as PgClient } from 'pg';
import { createHash, randomUUID } from 'crypto';

// Type and value share the same name on purpose: `Client` is the runtime
// constructor and the type that callers expect. TypeScript allows
// type-and-value declarations under the same identifier; the only complaint
// came from eslint's `no-redeclare`, which we disable on the value line.
type Client = PgClient;
const requireFromHere = createRequire(__filename);
// eslint-disable-next-line no-redeclare
const Client = requireFromHere('pg').Client as typeof PgClient;
import { logger } from './logger';
import { MemoryEventBus } from './event-bus-memory';
import type {
  EventBusInterface,
  PlanSyncEvent,
  PlanSyncEventType,
  Listener,
} from './event-bus-types';

const PROJECT_PREFIX = 'plansync_project_';
const USER_PREFIX = 'plansync_user_';
// Postgres NOTIFY payload max size is 8000 bytes; leave a safety margin for
// the JSON wrapper added below.
const PAYLOAD_MAX_BYTES = 7800;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;

interface NotifyEnvelope {
  /** Origin instance id — used to suppress NOTIFY echoes back to the publisher. */
  i: string;
  /** Optional userName, only present on user-channel envelopes. */
  u?: string;
  /** The actual event payload. */
  e: PlanSyncEvent;
  /** Marks the payload as a truncation notice (data dropped due to size). */
  t?: boolean;
}

/**
 * Returns a Postgres-identifier-safe channel name (lowercase hex, ≤ 63 chars).
 * We hash arbitrary user-supplied keys (project ids, usernames) so the channel
 * name is always a stable, well-formed identifier no matter what the upstream
 * key looks like.
 */
function channelFor(prefix: string, key: string): string {
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 40);
  return `${prefix}${hash}`;
}

/**
 * Postgres LISTEN/NOTIFY-backed event bus (R-088).
 *
 * In a multi-instance deployment, an in-memory bus cannot deliver SSE events
 * across processes — a publisher in instance A and a subscriber in instance B
 * never see each other. This class fixes that by piggy-backing on the existing
 * Postgres connection: each `publish` is mirrored as a `NOTIFY`, and each
 * subscriber's first listener for a key triggers a `LISTEN`. Local listeners
 * are still called synchronously by `publish` so the publisher does not have
 * to wait for a Postgres round-trip; remote listeners receive the event via
 * the `notification` event on the LISTEN client.
 *
 * To prevent the publisher's local listeners from firing twice (once
 * synchronously and once again when Postgres echoes the NOTIFY back), each
 * envelope includes the publisher's instance id and the listener-side
 * dispatcher drops envelopes whose `i` matches its own instance id.
 */
export class EventBusPG implements EventBusInterface {
  private readonly mem = new MemoryEventBus();
  private readonly instanceId = randomUUID();
  private readonly connectionString: string | undefined;
  /** Map: project id → channel name (so we know what to LISTEN/UNLISTEN). */
  private readonly projectChannels = new Map<string, string>();
  private readonly userChannels = new Map<string, string>();
  /** Channels that are currently LISTEN-ing on the live client. */
  private readonly subscribedChannels = new Set<string>();
  /**
   * Per-channel listener reference count for USER channels. We need this
   * because (unlike project channels) the MemoryEventBus does not expose a
   * per-user count, so we cannot ask it whether anyone is still listening.
   * #131: without this, every subscribeUser permanently bumps
   * subscribedChannels and on every reconnect we re-LISTEN every user
   * channel that ever had a subscriber — RAM grows without bound and the
   * Postgres LISTEN table fills with dead channels.
   */
  private readonly userChannelRefCount = new Map<string, number>();

  private listenClient: Client | null = null;
  private notifyClient: Client | null = null;
  private connectPromise: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether we have ever successfully connected at least once. */
  private everConnected = false;
  /**
   * In-flight listenChannel operations keyed by channel name.
   * unlistenChannel awaits these to prevent UNLISTEN from racing ahead of
   * the matching LISTEN when a subscriber is added then immediately removed.
   */
  private readonly pendingListens = new Map<string, Promise<void>>();

  constructor(opts: { connectionString?: string } = {}) {
    this.connectionString = opts.connectionString ?? process.env.DATABASE_URL;
    // #129: fail SYNCHRONOUSLY on construction when there is no connection
    // string. The previous behaviour relied on `ensureConnected` rejecting
    // an internal promise, which the `void this.ensureConnected()` call
    // below swallowed — and every subsequent publish swallowed it again,
    // so the operator never saw the failure and the bus appeared to "work"
    // (events were locally dispatched but never crossed instances). A
    // synchronous throw here makes the misconfiguration land in the
    // `createEventBus()` try/catch in event-bus.ts, which then either
    // re-throws (production) or falls back to MemoryEventBus (dev/test).
    if (!this.connectionString) {
      throw new Error(
        'EventBusPG requires DATABASE_URL or an explicit connectionString. ' +
          'Refusing to construct a bus that would silently no-op cross-instance NOTIFY.',
      );
    }
    // Eagerly connect so the first publish/subscribe doesn't pay the latency.
    void this.ensureConnected();
  }

  /**
   * Resolves once the underlying pg clients are connected (or rejects on
   * the first failed attempt). Mostly used by tests so they can wait for the
   * connection before publishing.
   */
  ready(): Promise<void> {
    return this.ensureConnected();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const tasks: Promise<void>[] = [];
    if (this.listenClient) tasks.push(this.listenClient.end().catch(() => {}));
    if (this.notifyClient) tasks.push(this.notifyClient.end().catch(() => {}));
    this.listenClient = null;
    this.notifyClient = null;
    this.connectPromise = null;
    this.subscribedChannels.clear();
    await Promise.all(tasks);
  }

  subscribe(projectId: string, listener: Listener): () => void {
    const channel = this.getProjectChannel(projectId);
    const wasEmpty = this.mem.getClientCount(projectId) === 0;
    const unsubLocal = this.mem.subscribe(projectId, listener);
    if (wasEmpty) {
      void this.listenChannel(channel);
    }
    return () => {
      unsubLocal();
      if (this.mem.getClientCount(projectId) === 0) {
        void this.unlistenChannel(channel);
      }
    };
  }

  subscribeUser(userName: string, listener: Listener): () => void {
    const channel = this.getUserChannel(userName);
    const unsubLocal = this.mem.subscribeUser(userName, listener);
    // Track per-channel listener count and LISTEN only on the first
    // subscriber. (#131: previously we never UNLISTEN-ed, which leaked
    // channels into subscribedChannels and re-LISTEN-ed all of them on
    // every reconnect.)
    const newCount = (this.userChannelRefCount.get(channel) ?? 0) + 1;
    this.userChannelRefCount.set(channel, newCount);
    if (newCount === 1) {
      void this.listenChannel(channel);
    }
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return; // make double-unsubscribe a no-op
      unsubscribed = true;
      unsubLocal();
      const remaining = (this.userChannelRefCount.get(channel) ?? 1) - 1;
      if (remaining <= 0) {
        this.userChannelRefCount.delete(channel);
        // Best effort UNLISTEN; if the listen client is currently
        // disconnected the channel will simply drop out of
        // subscribedChannels and not be re-LISTEN-ed on reconnect.
        void this.unlistenChannel(channel);
      } else {
        this.userChannelRefCount.set(channel, remaining);
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
    this.mem.dispatchProjectEvent(event);
    void this.notifyChannel(this.getProjectChannel(projectId), { i: this.instanceId, e: event });
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
    this.mem.dispatchUserEvent(userName, event);
    void this.notifyChannel(this.getUserChannel(userName), {
      i: this.instanceId,
      u: userName,
      e: event,
    });
  }

  getClientCount(projectId?: string): number {
    return this.mem.getClientCount(projectId);
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private getProjectChannel(projectId: string): string {
    let channel = this.projectChannels.get(projectId);
    if (!channel) {
      channel = channelFor(PROJECT_PREFIX, projectId);
      this.projectChannels.set(projectId, channel);
    }
    return channel;
  }

  private getUserChannel(userName: string): string {
    let channel = this.userChannels.get(userName);
    if (!channel) {
      channel = channelFor(USER_PREFIX, userName);
      this.userChannels.set(userName, channel);
    }
    return channel;
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) return;
    if (this.listenClient && this.notifyClient) return;
    if (this.connectPromise) return this.connectPromise;

    const cs = this.connectionString;
    if (!cs) {
      throw new Error('EventBusPG requires DATABASE_URL or an explicit connectionString');
    }

    const isReconnect = this.reconnectAttempts > 0 || this.everConnected;
    this.connectPromise = (async () => {
      try {
        const listenClient = new Client({ connectionString: cs });
        await listenClient.connect();
        listenClient.on('notification', (msg) =>
          this.onNotification(msg.channel, msg.payload ?? ''),
        );
        listenClient.on('error', (err) => {
          logger.error({ err }, 'EventBusPG listen client error; will reconnect');
          this.handleDisconnect();
        });

        const notifyClient = new Client({ connectionString: cs });
        await notifyClient.connect();
        notifyClient.on('error', (err) => {
          logger.error({ err }, 'EventBusPG notify client error');
        });

        this.listenClient = listenClient;
        this.notifyClient = notifyClient;
        this.reconnectAttempts = 0;
        this.everConnected = true;

        // Re-subscribe to any channels that were active before a reconnect.
        for (const channel of this.subscribedChannels) {
          await listenClient.query(`LISTEN ${quoteIdent(channel)}`);
        }

        logger.info({ instanceId: this.instanceId }, 'EventBusPG connected');

        // #130: NOTIFY events emitted while the listenClient was offline
        // are dropped by Postgres (the protocol buffers per-connection,
        // not per-channel). Best-effort gap mitigation: after a reconnect,
        // dispatch a synthetic resync event to every subscribed local
        // listener so SSE consumers know to refetch the canonical state.
        // This is intentionally a no-op on the very first connect —
        // there is no gap to recover from yet. A durable replay is
        // tracked separately in REMEDIATION_PLAN.md as R-160 / R-163
        // (B14 outbox); this event is the bridge until that lands.
        if (isReconnect) {
          this.dispatchResync();
        }
      } catch (err) {
        this.connectPromise = null;
        logger.error({ err }, 'EventBusPG connect failed; scheduling retry');
        this.scheduleReconnect();
        throw err;
      } finally {
        // Only clear the promise once the clients are set; otherwise we keep
        // the rejected promise so callers can observe the failure.
        if (this.listenClient && this.notifyClient) this.connectPromise = null;
      }
    })();

    return this.connectPromise;
  }

  private handleDisconnect(): void {
    if (this.closed) return;
    if (this.listenClient) {
      this.listenClient.removeAllListeners();
      void this.listenClient.end().catch(() => {});
    }
    if (this.notifyClient) {
      this.notifyClient.removeAllListeners();
      void this.notifyClient.end().catch(() => {});
    }
    this.listenClient = null;
    this.notifyClient = null;
    this.connectPromise = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected().catch(() => {
        /* error already logged; further retries scheduled inside */
      });
    }, delay);
  }

  /**
   * #130: dispatch a synthetic `bus_resync_required` event to every local
   * subscriber after the listen client reconnects. The MemoryEventBus has
   * no first-class iterator over its registrations, so we walk the
   * channel maps we already maintain — every subscribed project channel
   * gets an event addressed to its projectId, and every user channel ref
   * count >= 1 gets a user-scoped event. Local-only dispatch on purpose:
   * other instances saw the same Postgres outage and will dispatch their
   * own resync.
   */
  private dispatchResync(): void {
    const ts = new Date().toISOString();
    for (const [projectId] of this.projectChannels) {
      // Only dispatch if there are still local listeners for this project
      // (the channel map can outlive its subscribers if subscribe/unsub
      // raced with a reconnect; do not emit phantom resyncs).
      if (this.mem.getClientCount(projectId) === 0) continue;
      this.mem.dispatchProjectEvent({
        type: 'bus_resync_required',
        projectId,
        data: { _resyncRequired: true, reason: 'eventbus_reconnect' },
        timestamp: ts,
      });
    }
    for (const [, channel] of this.userChannels) {
      if ((this.userChannelRefCount.get(channel) ?? 0) === 0) continue;
      // Find the userName whose hashed channel matches; emit per user.
      for (const [userName, userChannel] of this.userChannels) {
        if (userChannel === channel) {
          this.mem.dispatchUserEvent(userName, {
            type: 'bus_resync_required',
            projectId: '',
            data: { _resyncRequired: true, reason: 'eventbus_reconnect' },
            timestamp: ts,
          });
        }
      }
    }
  }

  private async listenChannel(channel: string): Promise<void> {
    if (this.subscribedChannels.has(channel) || this.pendingListens.has(channel)) return;
    this.subscribedChannels.add(channel);
    const listenOp = (async () => {
      try {
        await this.ensureConnected();
        if (!this.listenClient) return;
        await this.listenClient.query(`LISTEN ${quoteIdent(channel)}`);
      } catch (err) {
        logger.warn({ err, channel }, 'EventBusPG LISTEN failed; will retry on reconnect');
      } finally {
        this.pendingListens.delete(channel);
      }
    })();
    this.pendingListens.set(channel, listenOp);
    await listenOp;
  }

  private async unlistenChannel(channel: string): Promise<void> {
    // Remove from subscribedChannels synchronously first so callers that
    // inspect subscribedChannels immediately after the fire-and-forget
    // void this.unlistenChannel() call see a consistent state.
    if (!this.subscribedChannels.has(channel)) return;
    this.subscribedChannels.delete(channel);
    // Then wait for any in-flight LISTEN to settle before sending UNLISTEN so
    // we never send UNLISTEN before the matching LISTEN has been sent to Postgres.
    const pending = this.pendingListens.get(channel);
    if (pending) await pending;
    if (!this.listenClient) return;
    try {
      await this.listenClient.query(`UNLISTEN ${quoteIdent(channel)}`);
    } catch (err) {
      logger.warn({ err, channel }, 'EventBusPG UNLISTEN failed');
    }
  }

  private async notifyChannel(channel: string, envelope: NotifyEnvelope): Promise<void> {
    let payload = JSON.stringify(envelope);
    if (Buffer.byteLength(payload, 'utf8') > PAYLOAD_MAX_BYTES) {
      // Postgres rejects NOTIFY payloads above 8KB; rather than dropping the
      // event entirely, send a slim version so subscribers can refetch.
      logger.warn(
        { channel, type: envelope.e.type, size: payload.length },
        'EventBusPG NOTIFY payload too large; truncating data',
      );
      const slim: NotifyEnvelope = {
        i: envelope.i,
        u: envelope.u,
        t: true,
        e: {
          type: envelope.e.type,
          projectId: envelope.e.projectId,
          // R-088 review #128: the envelope-level `t` flag is dropped by the
          // dispatch path (it only forwards `envelope.e` to listeners), so we
          // ALSO surface the truncation inside `data` itself. SSE consumers
          // check `data._truncated === true` and trigger a refetch instead
          // of trying to process an empty payload.
          data: { _truncated: true },
          timestamp: envelope.e.timestamp,
        },
      };
      payload = JSON.stringify(slim);
    }

    try {
      await this.ensureConnected();
      if (!this.notifyClient) return;
      // pg_notify() is parameterizable, unlike NOTIFY which only accepts an
      // identifier literal. Using pg_notify avoids any escaping foot-gun.
      await this.notifyClient.query('SELECT pg_notify($1, $2)', [channel, payload]);
    } catch (err) {
      logger.warn({ err, channel }, 'EventBusPG NOTIFY failed; local dispatch already happened');
      this.handleDisconnect();
    }
  }

  private onNotification(channel: string, payload: string): void {
    let envelope: NotifyEnvelope;
    try {
      envelope = JSON.parse(payload) as NotifyEnvelope;
    } catch (err) {
      logger.warn({ err, channel }, 'EventBusPG: ignoring malformed NOTIFY payload');
      return;
    }
    // Drop our own echoes — local listeners already saw this event when
    // publish() ran in this process.
    if (envelope.i === this.instanceId) return;
    // R-088 review #128: forward the envelope-level truncated flag into the
    // PlanSyncEvent so consumers always see _truncated regardless of which
    // peer sent the slim payload (older nodes may not have set it inside
    // data).
    const event =
      envelope.t === true
        ? { ...envelope.e, data: { ...envelope.e.data, _truncated: true } }
        : envelope.e;
    if (channel.startsWith(PROJECT_PREFIX)) {
      this.mem.dispatchProjectEvent(event);
    } else if (channel.startsWith(USER_PREFIX) && typeof envelope.u === 'string') {
      this.mem.dispatchUserEvent(envelope.u, event);
    }
  }
}

/**
 * Postgres identifier quoting. Channel names are SHA-1 hashes (hex), so they
 * already contain only [a-f0-9_] — but we still go through the safe path.
 */
function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}
