import { NextRequest } from 'next/server';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { eventBus, PlanSyncEvent } from '@/lib/event-bus';
import { logger } from '@/lib/logger';

// R-091: SSE client cap is now scoped per-project. The previous global
// 1000-client cap let a single noisy project starve every other project
// of SSE slots; counting per `(projectId)` instead means one runaway
// project can saturate its own quota without affecting peers. The
// default of 100 is intentionally well below the previous global cap —
// real deployments should rarely see more than a handful of subscribers
// per project (one per logged-in browser tab + CLI). Override via
// `PLANSYNC_MAX_SSE_CLIENTS_PER_PROJECT` if needed.
function resolveMaxSseClientsPerProject(): number {
  const raw = process.env.PLANSYNC_MAX_SSE_CLIENTS_PER_PROJECT;
  if (!raw) return 100;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return parsed;
}

/**
 * R-090: per-client backpressure / slow-client handling.
 *
 * Without a bounded queue, a slow consumer would let `controller.enqueue`
 * accumulate unboundedly inside the ReadableStream and block other clients
 * via shared dispatcher latency / memory pressure. We therefore buffer up
 * to `MAX_SSE_BUFFERED_EVENTS` events per client and, when the buffer
 * fills, close that client's stream so the browser / CLI immediately
 * reconnects with a clean state. Other clients are unaffected because
 * each connection owns its own buffer and `dispatchProjectEvent` already
 * iterates listeners independently.
 *
 * The default (1024) is large enough to absorb normal bursts (plan
 * activation can fan out tens of `drift_detected` events synchronously)
 * yet small enough to bound per-connection memory. Operators can override
 * via `PLANSYNC_SSE_BUFFER_PER_CLIENT` for stress tests.
 */
const DEFAULT_BUFFER_PER_CLIENT = 1024;
function resolveBufferLimit(): number {
  const raw = process.env.PLANSYNC_SSE_BUFFER_PER_CLIENT;
  if (!raw) return DEFAULT_BUFFER_PER_CLIENT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BUFFER_PER_CLIENT;
  return n;
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  // R-131 / G3 (Next.js 15): params is async.
  const params = await ctx.params;
  // R-089: SSE no longer accepts `?token=` in the URL. Tokens leaked into
  // browser history, server access logs, and referrer headers. Browser
  // clients must authenticate via the `plansync-apikey` cookie (set by the
  // login flow); CLI / non-browser clients keep using the Authorization
  // header. `?user=` is still allowed because it only selects the user
  // name for master delegation / AUTH_DISABLED mode and never carries a
  // secret.
  if (req.nextUrl.searchParams.has('token')) {
    return new Response('Unauthorized: ?token= is no longer accepted for SSE; use cookie auth', {
      status: 401,
    });
  }

  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
  } catch {
    return new Response('Unauthorized', { status: 401 });
  }

  const maxClientsPerProject = resolveMaxSseClientsPerProject();
  if (eventBus.getClientCount(params.projectId) >= maxClientsPerProject) {
    return new Response('Too many SSE connections for this project', { status: 503 });
  }

  const encoder = new TextEncoder();
  const bufferLimit = resolveBufferLimit();
  let unsubscribe: (() => void) | null = null;
  let closed = false;

  // Per-client pending-write queue. Producers (event listeners) push into
  // this; the stream's `pull` callback drains it. Decoupling the dispatch
  // path from the consumer's read rate is what allows us to *detect* a
  // slow client without blocking peers.
  const pending: Uint8Array[] = [];
  // Pull callback returns this promise when there's nothing to send; it
  // resolves the moment a new event arrives.
  let pullResolver: (() => void) | null = null;
  let eventId = 0;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'));

      const closeStream = (reason: 'overflow' | 'enqueue_error') => {
        if (closed) return;
        closed = true;
        if (reason === 'overflow') {
          // Tell the client why we hung up so the CLI / browser can log it.
          // Some buffer space is reserved for this final frame by design:
          // we only check `>=` against `bufferLimit`, but the close frame
          // is enqueued *after* we trip the limit and clear pending state.
          pending.length = 0;
          try {
            controller.enqueue(
              encoder.encode('event: backpressure_disconnect\ndata: {"reason":"slow_client"}\n\n'),
            );
          } catch {
            // The controller may already be torn down — ignore.
          }
        }
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        const r = pullResolver;
        pullResolver = null;
        if (r) r();
      };

      unsubscribe = eventBus.subscribe(params.projectId, (event: PlanSyncEvent) => {
        if (closed) return;
        if (pending.length >= bufferLimit) {
          logger.warn(
            {
              projectId: params.projectId,
              bufferLimit,
              eventType: event.type,
            },
            'SSE slow client exceeded per-client buffer; closing connection to force reconnect',
          );
          closeStream('overflow');
          return;
        }
        eventId++;
        const payload = [
          `id: ${eventId}`,
          `event: ${event.type}`,
          `data: ${JSON.stringify(event.data)}`,
          '',
          '',
        ].join('\n');
        pending.push(encoder.encode(payload));
        const r = pullResolver;
        pullResolver = null;
        if (r) r();
      });
    },
    // `pull` is invoked by the stream consumer whenever its internal
    // queue has room. We hand it the next pending chunk; if none is
    // available we park until the listener wakes us. This gives us the
    // backpressure signal we need — a slow reader leaves `pending`
    // growing until it trips `bufferLimit` above.
    async pull(controller) {
      if (closed) {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
        return;
      }
      if (pending.length === 0) {
        await new Promise<void>((resolve) => {
          pullResolver = resolve;
        });
        if (closed || pending.length === 0) return;
      }
      const chunk = pending.shift()!;
      try {
        controller.enqueue(chunk);
      } catch {
        logger.debug('SSE client disconnected during write');
        closed = true;
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
      }
    },
    cancel() {
      closed = true;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      pending.length = 0;
      const r = pullResolver;
      pullResolver = null;
      if (r) r();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
