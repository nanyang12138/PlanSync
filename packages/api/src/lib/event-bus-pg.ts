import { Client } from 'pg';
import { createHash, randomUUID } from 'crypto';
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

  private listenClient: Client | null = null;
  private notifyClient: Client | null = null;
  private connectPromise: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: { connectionString?: string } = {}) {
    this.connectionString = opts.connectionString ?? process.env.DATABASE_URL;
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
    const before = this.mem.getClientCount();
    const unsubLocal = this.mem.subscribeUser(userName, listener);
    // Only LISTEN once per channel — if there were no user listeners for this
    // userName before, we need to start LISTEN-ing.
    const after = this.mem.getClientCount();
    if (after > before && !this.subscribedChannels.has(channel)) {
      void this.listenChannel(channel);
    }
    return () => {
      unsubLocal();
      // We don't try to UNLISTEN user channels eagerly — userListeners come
      // and go frequently and the cleanup cost outweighs the per-channel RAM
      // savings. Channel set is cleaned up on connection drop.
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

        // Re-subscribe to any channels that were active before a reconnect.
        for (const channel of this.subscribedChannels) {
          await listenClient.query(`LISTEN ${quoteIdent(channel)}`);
        }

        logger.info({ instanceId: this.instanceId }, 'EventBusPG connected');
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

  private async listenChannel(channel: string): Promise<void> {
    if (this.subscribedChannels.has(channel)) return;
    this.subscribedChannels.add(channel);
    try {
      await this.ensureConnected();
      if (!this.listenClient) return;
      await this.listenClient.query(`LISTEN ${quoteIdent(channel)}`);
    } catch (err) {
      logger.warn({ err, channel }, 'EventBusPG LISTEN failed; will retry on reconnect');
    }
  }

  private async unlistenChannel(channel: string): Promise<void> {
    if (!this.subscribedChannels.has(channel)) return;
    this.subscribedChannels.delete(channel);
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
          data: {},
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
    if (channel.startsWith(PROJECT_PREFIX)) {
      this.mem.dispatchProjectEvent(envelope.e);
    } else if (channel.startsWith(USER_PREFIX) && typeof envelope.u === 'string') {
      this.mem.dispatchUserEvent(envelope.u, envelope.e);
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
