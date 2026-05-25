import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const TS_NODE = resolve(REPO_ROOT, 'node_modules/.bin/ts-node');

/**
 * Closes #543 / #563 / #577 / #584 / #594 / #600.
 *
 * The queue limit is read from the env at module load time. The previous
 * code coerced the value with `Number(env ?? 1000)` which silently
 * produces `NaN` for malformed inputs (`'abc'`, empty string, '12.5',
 * '-5', '0'). `queue.length >= NaN` is always false → cap silently
 * disabled.
 *
 * We assert the contract by spinning up a sub-process with a hostile
 * env value, importing email.ts in that fresh module graph, and reading
 * the post-init QUEUE_LIMIT via a deliberate test-export. (We can't use
 * vi.resetModules() on the parent because the test parser caches the
 * import resolve.)
 */
function probeQueueLimit(envValue: string | undefined): {
  limit: number;
  status: number | null;
  stderr: string;
} {
  // The probe imports email.ts and reads the cap. email.ts does not
  // export QUEUE_LIMIT directly (it's an internal const), so we exercise
  // the public sendMail() with a queue we then synchronously fill until
  // the next call rejects. The "rejection threshold" is the limit.
  const code = `
    process.env.LOG_LEVEL = 'error';
    ${
      envValue !== undefined
        ? `process.env.PLANSYNC_EMAIL_QUEUE_LIMIT = ${JSON.stringify(envValue)};`
        : `delete process.env.PLANSYNC_EMAIL_QUEUE_LIMIT;`
    }
    const child_process = require('child_process');
    // F4: email.ts now uses async spawn(), not spawnSync. Stub both so the
    // queue-limit probe doesn't actually shell out to sendmail.
    child_process.spawnSync = () => ({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') });
    const { EventEmitter } = require('events');
    child_process.spawn = () => {
      const child = new EventEmitter();
      const stdin = new EventEmitter();
      stdin.write = () => true;
      stdin.end = () => {};
      child.stdin = stdin;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      setImmediate(() => child.emit('close', 0, null));
      return child;
    };
    const { sendMail } = require('${resolve(__dirname, '../../src/lib/email.ts').replace(
      /\\/g,
      '\\\\',
    )}');
    let i = 0;
    let lastAccepted = 0;
    while (i < 5000) {
      const ok = sendMail(['u' + i + '@example.com'], 's', 'b');
      if (!ok) break;
      lastAccepted = i + 1;
      i += 1;
    }
    process.stdout.write(JSON.stringify({ limit: lastAccepted }));
  `;
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NODE_PATH: process.env.NODE_PATH ?? '',
    DATABASE_URL: 'postgresql://noop@localhost:1/noop',
  } as unknown as NodeJS.ProcessEnv;
  const r = spawnSync(
    TS_NODE,
    ['--compiler-options', '{"module":"commonjs","esModuleInterop":true}', '-e', code],
    { env, encoding: 'utf-8' },
  );
  const stdout = (r.stdout ?? '').trim();
  const last = stdout.split('\n').pop() ?? '{}';
  let parsed: { limit?: number } = {};
  try {
    parsed = JSON.parse(last);
  } catch {
    // fall through with limit=NaN below
  }
  return {
    limit: typeof parsed.limit === 'number' ? parsed.limit : NaN,
    status: r.status,
    stderr: r.stderr ?? '',
  };
}

describe('email.ts QUEUE_LIMIT env parsing (#543 / #563 / #577 / #584 / #594 / #600)', () => {
  it('default (env unset) → 1000', () => {
    const { limit, status, stderr } = probeQueueLimit(undefined);
    expect(status, `stderr was: ${stderr}`).toBe(0);
    expect(limit).toBe(1000);
  });

  it('explicit positive integer is honoured', () => {
    const { limit } = probeQueueLimit('5');
    expect(limit).toBe(5);
  });

  it('non-numeric (e.g. "abc") falls back to 1000 instead of NaN', () => {
    const { limit } = probeQueueLimit('abc');
    expect(limit).toBe(1000);
  });

  it('empty string falls back to 1000', () => {
    const { limit } = probeQueueLimit('');
    expect(limit).toBe(1000);
  });

  it('zero falls back to 1000 (would otherwise reject everything)', () => {
    const { limit } = probeQueueLimit('0');
    expect(limit).toBe(1000);
  });

  it('negative integer falls back to 1000', () => {
    const { limit } = probeQueueLimit('-7');
    expect(limit).toBe(1000);
  });

  it('non-integer (e.g. "12.5") falls back to 1000', () => {
    const { limit } = probeQueueLimit('12.5');
    expect(limit).toBe(1000);
  });
});
