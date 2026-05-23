import { spawnSync } from 'child_process';
import { logger } from './logger';

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

function deliverOnce(message: string): { ok: boolean; err?: string } {
  try {
    const result = spawnSync(SENDMAIL, ['-t'], {
      input: message,
      timeout: 10000,
    });
    if (result.status !== 0) {
      const err = result.stderr?.toString().slice(0, 200) ?? `exit=${result.status}`;
      return { ok: false, err };
    }
    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, err: msg };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift()!;
      const result = deliverOnce(item.message);
      if (result.ok) continue;

      item.attempts += 1;
      if (item.attempts < MAX_ATTEMPTS) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, item.attempts - 1);
        await sleep(delay);
        queue.unshift(item);
        continue;
      }

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
