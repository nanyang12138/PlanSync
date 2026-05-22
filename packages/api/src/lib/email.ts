import { spawn, SpawnOptions } from 'child_process';

const SENDMAIL = process.env.EMAIL_SENDMAIL ?? '/usr/sbin/sendmail';
const FROM = process.env.EMAIL_FROM ?? 'plansync@amd.com';
const DOMAIN = process.env.EMAIL_DOMAIN ?? 'amd.com';

// R-113: sendMail is asynchronous and queued. Callers enqueue work and return
// immediately; a background worker drains the queue serially and retries
// transient sendmail failures with exponential backoff.

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;
const SENDMAIL_TIMEOUT_MS = 10_000;
const QUEUE_LIMIT = 1000;

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
  body: string;
  attempts: number;
}

const queue: QueuedMessage[] = [];
let pendingCount = 0;
let processing = false;
const drainWaiters: Array<() => void> = [];

// Driver indirection so tests can inject a deterministic transport without
// spawning real sendmail.
type SendmailDriver = (message: string) => Promise<{ ok: boolean; detail?: string }>;

const defaultDriver: SendmailDriver = (message) =>
  new Promise((resolve) => {
    let settled = false;
    let proc: ReturnType<typeof spawn>;
    const options: SpawnOptions = { stdio: ['pipe', 'pipe', 'pipe'] };

    try {
      proc = spawn(SENDMAIL, ['-t'], options);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      resolve({ ok: false, detail: `spawn failed: ${msg}` });
      return;
    }

    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      resolve({ ok: false, detail: 'sendmail timeout' });
    }, SENDMAIL_TIMEOUT_MS);

    proc.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk).slice(0, 200);
    });

    proc.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, detail: e.message });
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, detail: `status ${code}: ${stderr || 'unknown error'}` });
      }
    });

    proc.stdin?.end(message);
  });

let driver: SendmailDriver = defaultDriver;

/**
 * For tests only — replace the sendmail driver with a stub. Returns the
 * previous driver so tests can restore it after running.
 */
export function __setSendmailDriverForTest(next: SendmailDriver): SendmailDriver {
  const prev = driver;
  driver = next;
  return prev;
}

/**
 * For tests only — reset queue + driver to a clean state.
 */
export function __resetMailQueueForTest(): void {
  queue.length = 0;
  pendingCount = 0;
  processing = false;
  drainWaiters.length = 0;
  driver = defaultDriver;
}

function buildMessage(to: string[], subject: string, body: string): string {
  // Strip newlines from all headers to prevent email header injection.
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

function notifyDrainWaiters(): void {
  if (pendingCount > 0) return;
  const waiters = drainWaiters.splice(0);
  for (const w of waiters) {
    try {
      w();
    } catch {
      // ignore
    }
  }
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const msg = queue.shift()!;
      msg.attempts++;
      const message = buildMessage(msg.to, msg.subject, msg.body);
      let result: { ok: boolean; detail?: string };
      try {
        result = await driver(message);
      } catch (e: unknown) {
        result = {
          ok: false,
          detail: e instanceof Error ? e.message : String(e),
        };
      }
      if (result.ok) {
        pendingCount--;
        notifyDrainWaiters();
        continue;
      }
      if (msg.attempts < MAX_ATTEMPTS) {
        const delay = RETRY_BASE_MS * Math.pow(2, msg.attempts - 1);
        console.warn(
          '[email] sendmail attempt %d failed (%s); retrying in %dms',
          msg.attempts,
          result.detail ?? 'unknown',
          delay,
        );
        const timer = setTimeout(() => {
          queue.push(msg);
          scheduleWorker();
        }, delay);
        timer.unref?.();
      } else {
        console.warn(
          '[email] giving up after %d attempts: %s',
          msg.attempts,
          result.detail ?? 'unknown',
        );
        pendingCount--;
        notifyDrainWaiters();
      }
    }
  } finally {
    processing = false;
  }
}

function scheduleWorker(): void {
  if (processing) return;
  setImmediate(() => {
    void processQueue();
  });
}

/**
 * Enqueue an outgoing email and return immediately. Returns `false` only when
 * the message has no deliverable recipients or the queue is full; otherwise
 * returns `true` indicating the message was accepted for asynchronous delivery.
 *
 * The actual send is performed by a background worker that retries transient
 * sendmail failures up to MAX_ATTEMPTS times with exponential backoff.
 */
export function sendMail(to: string[], subject: string, body: string): boolean {
  const deliverable = to.filter(isDeliverable);
  if (deliverable.length === 0) return false;
  if (pendingCount >= QUEUE_LIMIT) {
    console.warn('[email] queue limit reached (%d), dropping message', QUEUE_LIMIT);
    return false;
  }
  queue.push({
    to: deliverable,
    subject,
    body,
    attempts: 0,
  });
  pendingCount++;
  scheduleWorker();
  return true;
}

/**
 * Resolves once the in-memory mail queue is fully drained (including any
 * scheduled retries). Useful for tests and graceful shutdown.
 */
export function flushMailQueue(): Promise<void> {
  if (pendingCount === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    drainWaiters.push(resolve);
  });
}
