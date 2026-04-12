import { spawnSync } from 'child_process';

const SENDMAIL = '/usr/sbin/sendmail';
const FROM = process.env.EMAIL_FROM ?? 'plansync@amd.com';
const DOMAIN = process.env.EMAIL_DOMAIN ?? 'amd.com';

export function userEmail(userName: string): string {
  return `${userName}@${DOMAIN}`;
}

export function sendMail(to: string[], subject: string, body: string): void {
  const message = [
    `To: ${to.join(', ')}`,
    `From: ${FROM}`,
    `Subject: ${subject}`,
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
      // Do not throw — email failure must not block drift scans or plan proposals
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[email] sendmail unavailable: %s', msg);
  }
}
