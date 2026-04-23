import { spawnSync } from 'child_process';

const SENDMAIL = '/usr/sbin/sendmail';
const FROM = process.env.EMAIL_FROM ?? 'plansync@amd.com';
const DOMAIN = process.env.EMAIL_DOMAIN ?? 'amd.com';

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

export function sendMail(to: string[], subject: string, body: string): boolean {
  const deliverable = to.filter(isDeliverable);
  if (deliverable.length === 0) return false;
  to = deliverable;
  // Strip newlines from subject to prevent email header injection
  const safeSubject = subject.replace(/[\r\n]+/g, ' ');
  const message = [
    `To: ${to.join(', ')}`,
    `From: ${FROM}`,
    `Subject: ${safeSubject}`,
    `Content-Type: text/plain; charset=utf-8`,
    '',
    body,
  ].join('\n');

  try {
    const result = spawnSync(SENDMAIL, ['-t'], {
      input: message,
      timeout: 10000,
    });

    if (result.status !== 0) {
      const err = result.stderr?.toString().slice(0, 200) ?? 'unknown error';
      console.warn('[email] sendmail failed (status %d): %s', result.status, err);
      return false;
    }
    return true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[email] sendmail unavailable: %s', msg);
    return false;
  }
}
