import { spawn } from 'child_process';
import { logger } from './logger';

// F4 / closes the deeper concern in the P0-7 instrumentation cluster
// (#541-cls): the previous `spawnSync(..., { timeout: 10_000 })` blocked
// the entire JS thread for up to 10s while the sendmail child ran.
// During a SIGTERM drain that meant our 5s `Promise.race` timeout
// could not fire (timer can't run while spawnSync holds the thread),
// so the drain effectively waited the full sendmail timeout per
// in-flight message — often exceeding the orchestrator grace period
// and ending in SIGKILL with mail lost.
//
// `spawn` (async) lets the timer fire on schedule, lets
// `flushSendMailQueue` see in-flight Promises through the `inFlight`
// set, and gives `getPendingMailTotal()` (P0-7) accurate accounting.
// The 10s child-side budget is preserved via setTimeout + child.kill.

const SENDMAIL = process.env.EMAIL_SENDMAIL ?? '/usr/sbin/sendmail';
const FROM = process.env.EMAIL_FROM ?? 'plansync@amd.com';
const DOMAIN = process.env.EMAIL_DOMAIN ?? 'amd.com';

const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
/**
 * #318 / #352: synchronous backpressure cap. Without this the in-process
 * queue is unbounded — a sendmail outage during a high-traffic event
 * (drift storm, plan re-activate fanout) grows the queue without limit
 * until the API process OOMs. 1000 is a generous ceiling for a single
 * Node process; deployments that legitimately exceed it should switch to
 * the durable webhook_jobs / outbox table tracked by R-164 / R-165.
 *
 * #543 / #563 / #577 / #584 / #594 / #600: an invalid env value
 * (PLANSYNC_EMAIL_QUEUE_LIMIT='abc' or '') was previously coerced to NaN,
 * and `queue.length >= NaN` is always false — silently lifting the cap.
 * `parseQueueLimit` rejects NaN / non-positive integers with a single
 * one-time logger.warn and falls back to the documented default.
 */
function parseQueueLimit(rawEnv: string | undefined): number {
  const DEFAULT = 1000;
  if (rawEnv === undefined || rawEnv === '') return DEFAULT;
  const parsed = Number(rawEnv);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    // Defer the warn until the logger has had a chance to initialise; the
    // env is read at module load and the logger is still being wired up.
    setImmediate(() => {
      logger.warn(
        { rawEnv, fallback: DEFAULT },
        '[email] PLANSYNC_EMAIL_QUEUE_LIMIT is not a positive integer; using default',
      );
    });
    return DEFAULT;
  }
  return parsed;
}
const QUEUE_LIMIT = parseQueueLimit(process.env.PLANSYNC_EMAIL_QUEUE_LIMIT);

export function userEmail(userName: string): string {
  return `${userName}@${DOMAIN}`;
}

// Demo/test accounts are auto-generated with a long numeric suffix (e.g.
// bob-demo-1776932148306). Real AMD usernames follow firstname+short-digits
// (nanyang2, tzhang5). Sending to generated addresses causes Exchange
// bounces, so we drop them silently.
function isDeliverable(email: string): boolean {
  const local = email.split('@')[0] ?? '';
  return !/\d{10,}$/.test(local);
}

interface QueuedMessage {
  to: string[];
  subject: string;
  message: string;
  attempts: number;
}

const queue: QueuedMessage[] = [];
let processing = false;
const inFlight = new Set<Promise<void>>();

function buildMessage(to: string[], subject: string, body: string): string {
  // Strip newlines from headers to prevent header injection.
  const safeSubject = subject.replace(/[\r\n]+/g, ' ');
  const safeTo = to.map((addr) => addr.replace(/[\r\n]+/g, '')).filter(Boolean);
  return [
    `To: ${safeTo.join(', ')}`,
    `From: ${FROM}`,
    `Subject: ${safeSubject}`,
    `Content-Type: text/plain; charset=utf-8`,
    '',
    body,
  ].join('\n');
}

function deliverOnce(message: string): Promise<{ ok: boolean; err?: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // stdout is 'ignore' (not 'pipe') because sendmail writes nothing
      // useful to stdout. Using 'pipe' without consuming the stream risks
      // deadlock if the pipe buffer fills — 'ignore' routes to /dev/null
      // and eliminates the backpressure entirely (#1044).
      child = spawn(SENDMAIL, ['-t'], { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, err: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stderrBuf = '';
    let settled = false;
    const settle = (result: { ok: boolean; err?: string }): void => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // child already exited; nothing to do.
      }
      resolve(result);
    };
    const timer = setTimeout(() => settle({ ok: false, err: 'timeout' }), 10_000);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.length > 200) stderrBuf = stderrBuf.slice(0, 200);
    });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      settle({ ok: false, err: err.message });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) settle({ ok: true });
      else settle({ ok: false, err: stderrBuf || `exit=${code ?? 'null'}` });
    });
    // R8 / closes #920 — child.stdin EPIPE/ECONNRESET is emitted
    // asynchronously when sendmail closes its read side before we
    // finish writing (typical when sendmail rejects fast — bad
    // recipient, queue full, etc.). Without an 'error' listener on
    // stdin, Node lifts the EPIPE to a process-level uncaughtException
    // and the API process crashes. Wire a settle-with-error so the
    // delivery is reported as failed and processQueue continues with
    // the next message.
    child.stdin?.on('error', (err: Error) => {
      clearTimeout(timer);
      settle({ ok: false, err: err.message });
    });
    try {
      child.stdin?.write(message);
      child.stdin?.end();
    } catch (err) {
      clearTimeout(timer);
      settle({ ok: false, err: err instanceof Error ? err.message : String(err) });
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      // Peek without removing so the item stays counted in queue.length
      // during the retry backoff sleep — preventing sendMail() from
      // treating the cap as temporarily lifted (#593 race).
      const item = queue[0];
      const result = await deliverOnce(item.message);
      if (result.ok) {
        queue.shift();
        continue;
      }

      item.attempts += 1;
      if (item.attempts < MAX_ATTEMPTS) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, item.attempts - 1);
        await sleep(delay);
        continue;
      }
      queue.shift();

      // #316 / #350: structured logger.error so downstream observability
      // (correlated logs, monitoring sinks subscribed to error-level
      // events, dashboards) sees this. console.warn was bypassing the
      // pino logger and made it impossible for drift-engine et al. to
      // surface persistent delivery failures via their normal error
      // budget.
      logger.error(
        {
          to: item.to,
          subject: item.subject,
          attempts: item.attempts,
          err: result.err ?? 'unknown',
        },
        '[email] sendmail giving up after retries',
      );
    }
  } finally {
    processing = false;
  }
}

function scheduleProcess(): void {
  // Use setImmediate so the caller's request handler is not blocked by
  // sendmail. Tests can await flushSendMailQueueForTests() to drain.
  const p = (async () => {
    // Yield once before draining so multiple sendMail() calls in a
    // request handler get coalesced into the same processQueue cycle.
    await new Promise<void>((r) => setImmediate(r));
    await processQueue();
  })();
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
}

/**
 * Enqueue an email for asynchronous delivery.
 *
 * Returns:
 *   - `true`  — message accepted into the in-process queue. Delivery is
 *               attempted asynchronously; final failures (after MAX_ATTEMPTS
 *               retries) are surfaced via `logger.error` (#316 / #350).
 *               Callers that need to know about eventual success must
 *               subscribe to the logger or migrate to the future
 *               webhook_jobs / outbox infrastructure (R-164 / R-165).
 *   - `false` — synchronously rejected. Two reasons collapse into a
 *               single boolean for backwards compatibility:
 *                 1. all recipients were filtered as undeliverable (e.g.
 *                    auto-generated demo addresses).
 *                 2. the in-process queue is at or above
 *                    `PLANSYNC_EMAIL_QUEUE_LIMIT` (#318 / #352).
 *               The two cases can be distinguished from the logs:
 *               case 2 emits `logger.warn('[email] sendmail queue full ...')`.
 */
export function sendMail(to: string[], subject: string, body: string): boolean {
  const deliverable = to.filter(isDeliverable);
  if (deliverable.length === 0) return false;
  if (queue.length >= QUEUE_LIMIT) {
    logger.warn(
      { to: deliverable, subject, queueLength: queue.length, limit: QUEUE_LIMIT },
      '[email] sendmail queue full; dropping message',
    );
    return false;
  }
  const message = buildMessage(deliverable, subject, body);
  queue.push({ to: deliverable, subject, message, attempts: 0 });
  scheduleProcess();
  return true;
}

/**
 * Drain the in-memory queue. Returns a promise that resolves when every
 * queued + in-flight delivery has settled (success or final failure).
 * Used by:
 *   - the SIGTERM / SIGINT shutdown path in instrumentation.ts so a
 *     redeploy does not silently lose pending notification emails (#317
 *     / #351), and
 *   - the test helper below.
 */
export async function flushSendMailQueue(): Promise<void> {
  while (inFlight.size > 0 || queue.length > 0 || processing) {
    if (inFlight.size > 0) {
      await Promise.allSettled(Array.from(inFlight));
    } else {
      await new Promise<void>((r) => setImmediate(r));
    }
  }
}

/**
 * Test-only alias for {@link flushSendMailQueue}, kept under the historic
 * name so existing test files do not have to change. New code should call
 * `flushSendMailQueue()` directly.
 */
export const flushSendMailQueueForTests = flushSendMailQueue;

/**
 * Test-only: read the current pending queue length.
 */
export function _sendMailQueueLengthForTests(): number {
  return queue.length;
}

/**
 * R8 / closes #919: aggregate pending mail count for the SIGTERM drain
 * path. The drain in instrumentation.ts decides "are we done?" by
 * reading this. Pre-fix, drain code only saw `queue.length`, so a
 * sendmail child that was mid-spawn (in-flight Promise but no queue
 * entry) made the drain misreport "done" and process.exit terminated
 * the in-flight delivery mid-write.
 *
 * (Mirrors the helper that lands in P0-7 #859 — wired here too so F4
 * is independently complete.)
 */
export function getPendingMailTotal(): number {
  return queue.length + inFlight.size + (processing ? 1 : 0);
}
