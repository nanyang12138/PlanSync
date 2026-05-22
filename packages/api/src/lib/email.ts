import { spawnSync } from 'child_process';

const SENDMAIL = process.env.EMAIL_SENDMAIL ?? '/usr/sbin/sendmail';
const FROM = process.env.EMAIL_FROM ?? 'plansync@amd.com';
const DOMAIN = process.env.EMAIL_DOMAIN ?? 'amd.com';

const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

export function userEmail(userName: string): string {
  return `${userName}@${DOMAIN}`;
}

// Demo/test accounts are auto-generated with a long numeric suffix (e.g. bob-demo-1776932148306).
// Real AMD usernames follow the pattern firstname+short-digits (nanyang2, tzhang5).
// Sending to generated addresses causes Exchange bounces, so we drop them silently.
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

      console.warn(
        '[email] sendmail giving up after %d attempts: %s',
        item.attempts,
        result.err ?? 'unknown',
      );
    }
  } finally {
    processing = false;
  }
}

function scheduleProcess(): void {
  // Use setImmediate so the caller's request handler is not blocked by sendmail.
  // Tests can await flushSendMailQueueForTests() to drain.
  const p = (async () => {
    // Yield once before draining so multiple sendMail() calls in a request
    // handler get coalesced into the same processQueue cycle.
    await new Promise<void>((r) => setImmediate(r));
    await processQueue();
  })();
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
}

/**
 * Enqueue an email for asynchronous delivery. Returns true if the message was
 * accepted into the queue, or false if it was dropped because no recipients
 * were deliverable.
 *
 * Delivery happens via setImmediate; failures are retried with exponential
 * backoff (default 3 attempts).
 */
export function sendMail(to: string[], subject: string, body: string): boolean {
  const deliverable = to.filter(isDeliverable);
  if (deliverable.length === 0) return false;
  const message = buildMessage(deliverable, subject, body);
  queue.push({ to: deliverable, subject, message, attempts: 0 });
  scheduleProcess();
  return true;
}

/**
 * Test-only helper: wait for all currently in-flight email deliveries to
 * finish so assertions can observe their side effects.
 */
export async function flushSendMailQueueForTests(): Promise<void> {
  while (inFlight.size > 0 || queue.length > 0 || processing) {
    if (inFlight.size > 0) {
      await Promise.allSettled(Array.from(inFlight));
    } else {
      await new Promise<void>((r) => setImmediate(r));
    }
  }
}

/**
 * Test-only helper: read the current pending queue length.
 */
export function _sendMailQueueLengthForTests(): number {
  return queue.length;
}
