// R-013: First-login registration must be controlled by env flag.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { POST as loginPost } from '@/app/api/auth/login/route';
import { testPrisma } from '../helpers/request';

const ORIGINAL_OPEN_REG = process.env.PLANSYNC_OPEN_REGISTRATION;

function makeLoginReq(userName: string, password: string): Request {
  return new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userName, password }),
  });
}

async function deleteUserIfExists(userName: string) {
  await testPrisma.userAccount.deleteMany({ where: { userName } }).catch(() => {});
  await testPrisma.apiKey
    .deleteMany({ where: { createdBy: userName, name: 'web-session' } })
    .catch(() => {});
}

describe('R-013: first-login registration is gated by PLANSYNC_OPEN_REGISTRATION', () => {
  const usernames = [
    'r013-closed-user',
    'r013-open-user',
    'r013-existing-user',
    'r013-existing-bad',
  ];

  beforeAll(async () => {
    for (const u of usernames) await deleteUserIfExists(u);
  });

  afterEach(() => {
    if (ORIGINAL_OPEN_REG === undefined) {
      delete process.env.PLANSYNC_OPEN_REGISTRATION;
    } else {
      process.env.PLANSYNC_OPEN_REGISTRATION = ORIGINAL_OPEN_REG;
    }
  });

  afterAll(async () => {
    for (const u of usernames) await deleteUserIfExists(u);
  });

  it('rejects first login for unknown user when PLANSYNC_OPEN_REGISTRATION=false (default)', async () => {
    process.env.PLANSYNC_OPEN_REGISTRATION = 'false';
    // Re-import the route module so it re-reads env.PLANSYNC_OPEN_REGISTRATION.
    // The login route reads `env.PLANSYNC_OPEN_REGISTRATION` lazily through the
    // `env` object exported from `@/lib/env`, but `env` is parsed once on
    // module load. We therefore stub the value directly on the env module.
    const envMod = await import('@/lib/env');
    const original = envMod.env.PLANSYNC_OPEN_REGISTRATION;
    (envMod.env as { PLANSYNC_OPEN_REGISTRATION: boolean }).PLANSYNC_OPEN_REGISTRATION = false;

    try {
      const res = await loginPost(makeLoginReq('r013-closed-user', 'pw1234') as never);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(String(body.error)).toMatch(/Account must be created by admin/i);
      expect(String(body.error)).toMatch(/r013-closed-user/);

      // No UserAccount must have been created.
      const account = await testPrisma.userAccount.findUnique({
        where: { userName: 'r013-closed-user' },
      });
      expect(account).toBeNull();
    } finally {
      (envMod.env as { PLANSYNC_OPEN_REGISTRATION: boolean }).PLANSYNC_OPEN_REGISTRATION = original;
    }
  });

  it('creates a UserAccount when PLANSYNC_OPEN_REGISTRATION=true', async () => {
    process.env.PLANSYNC_OPEN_REGISTRATION = 'true';
    const envMod = await import('@/lib/env');
    const original = envMod.env.PLANSYNC_OPEN_REGISTRATION;
    (envMod.env as { PLANSYNC_OPEN_REGISTRATION: boolean }).PLANSYNC_OPEN_REGISTRATION = true;

    try {
      const res = await loginPost(makeLoginReq('r013-open-user', 'pw1234') as never);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.isFirstLogin).toBe(true);

      const account = await testPrisma.userAccount.findUnique({
        where: { userName: 'r013-open-user' },
      });
      expect(account).not.toBeNull();
    } finally {
      (envMod.env as { PLANSYNC_OPEN_REGISTRATION: boolean }).PLANSYNC_OPEN_REGISTRATION = original;
    }
  });

  it('still authenticates a pre-existing account when registration is closed', async () => {
    // Simulate `bin/ps-admin create-user`: hash a password and seed an account.
    const crypto = await import('node:crypto');
    const { promisify } = await import('node:util');
    const scrypt = promisify(crypto.scrypt);
    const salt = crypto.randomBytes(16);
    const dk = (await scrypt('correct-horse', salt, 64)) as Buffer;
    const passwordHash = `${salt.toString('hex')}:${dk.toString('hex')}`;
    await testPrisma.userAccount.create({
      data: { userName: 'r013-existing-user', passwordHash },
    });

    const envMod = await import('@/lib/env');
    const original = envMod.env.PLANSYNC_OPEN_REGISTRATION;
    (envMod.env as { PLANSYNC_OPEN_REGISTRATION: boolean }).PLANSYNC_OPEN_REGISTRATION = false;

    try {
      const res = await loginPost(makeLoginReq('r013-existing-user', 'correct-horse') as never);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.isFirstLogin).toBe(false);
    } finally {
      (envMod.env as { PLANSYNC_OPEN_REGISTRATION: boolean }).PLANSYNC_OPEN_REGISTRATION = original;
    }
  });

  it('rejects pre-existing account login with wrong password regardless of registration policy', async () => {
    const crypto = await import('node:crypto');
    const { promisify } = await import('node:util');
    const scrypt = promisify(crypto.scrypt);
    const salt = crypto.randomBytes(16);
    const dk = (await scrypt('correct-pw', salt, 64)) as Buffer;
    const passwordHash = `${salt.toString('hex')}:${dk.toString('hex')}`;
    await testPrisma.userAccount.create({
      data: { userName: 'r013-existing-bad', passwordHash },
    });

    const envMod = await import('@/lib/env');
    const original = envMod.env.PLANSYNC_OPEN_REGISTRATION;
    (envMod.env as { PLANSYNC_OPEN_REGISTRATION: boolean }).PLANSYNC_OPEN_REGISTRATION = false;

    try {
      const res = await loginPost(makeLoginReq('r013-existing-bad', 'wrong-pw') as never);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(String(body.error)).toMatch(/Invalid username or password/);
    } finally {
      (envMod.env as { PLANSYNC_OPEN_REGISTRATION: boolean }).PLANSYNC_OPEN_REGISTRATION = original;
    }
  });
});
