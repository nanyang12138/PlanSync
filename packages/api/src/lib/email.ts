import { spawnSync } from 'child_process';

const SENDMAIL = '/usr/sbin/sendmail';
const FROM = process.env.EMAIL_FROM ?? 'plansync@amd.com';
const DOMAIN = process.env.EMAIL_DOMAIN ?? 'amd.com';

export function userEmail(userName: string): string {
  return `${userName}@${DOMAIN}`;
}

export function sendMail(to: string[], subject: string, body: string): boolean {
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
