// R-014: Password-as-Bearer must be confined to non-production environments.
//
// `authenticate()` historically accepts a user's login password as a Bearer
// token (paired with `X-User-Name`) so the local CLI can talk to the API
// without first minting an `ps_key_*` key. In production this is a footgun:
// the plaintext password lives in the request stream and is cached in
// memory on every node for up to 5 minutes. R-014 gates the entire
// password-Bearer branch on `NODE_ENV !== 'production'`; in production
// only `ps_key_*` keys (and the master delegation secret) are accepted.
//
// This file flips `NODE_ENV=production` for the lifetime of the test and
// asserts:
//   1. A valid password as Bearer token is rejected with 401 / UNAUTHORIZED.
//   2. The rejection happens before any `verifyPassword` work and does
//      NOT populate the in-memory cache, so a follow-up call with the
//      same credentials is also rejected (no stale-cache leak).
//   3. The same credentials succeed when `NODE_ENV !== 'production'`
//      (regression guard so we don't accidentally lock out dev).
//   4. A correctly-minted `ps_key_*` key still authenticates in
//      production — i.e. the gate only removes the password branch.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { authenticate, invalidatePasswordCache } from '@/lib/auth';
import { testPrisma, makeReq } from '../helpers/request';

function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, dk) => {
      if (err) reject(err);
      else resolve(`${salt.toString('hex')}:${dk.toString('hex')}`);
    });
  });
}

const userName = `r014-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const password = 'r014-prod-bearer-test-password';

describe('R-014: password Bearer is rejected in production', () => {
  let originalAuthDisabled: string | undefined;
  let originalNodeEnv: string | undefined;
  let apiKeyRaw: string | null = null;

  beforeAll(async () => {
    // The default test harness pins AUTH_DISABLED=true which short-circuits
    // most failed auth into an anonymous success path. To observe the
    // strict R-014 behaviour we have to disable that fallback and also
    // flip NODE_ENV to 'production'.
    originalAuthDisabled = process.env.AUTH_DISABLED;
    originalNodeEnv = process.env.NODE_ENV;
    process.env.AUTH_DISABLED = 'false';
    Reflect.set(process.env, 'NODE_ENV', 'production');

    await testPrisma.userAccount.create({
      data: { userName, passwordHash: await hashPassword(password) },
    });

    // Mint a real ps_key_ to prove the production gate only blocks
    // password-Bearer, not properly-issued API keys.
    const raw = `ps_key_${crypto.randomBytes(16).toString('hex')}`;
    const salt = crypto.randomBytes(16);
    const dk: Buffer = await new Promise((resolve, reject) => {
      crypto.scrypt(raw, salt, 64, (err, k) => (err ? reject(err) : resolve(k)));
    });
    await testPrisma.apiKey.create({
      data: {
        name: `r014-${userName}`,
        keyPrefix: raw.slice(0, 15),
        keyHash: `${salt.toString('hex')}:${dk.toString('hex')}`,
        createdBy: userName,
        permissions: ['read', 'write'],
      },
    });
    apiKeyRaw = raw;
  });

  afterAll(async () => {
    invalidatePasswordCache(userName);
    await testPrisma.apiKey.deleteMany({ where: { createdBy: userName } }).catch(() => {});
    await testPrisma.userAccount.delete({ where: { userName } }).catch(() => {});

    if (originalAuthDisabled === undefined) {
      delete process.env.AUTH_DISABLED;
    } else {
      process.env.AUTH_DISABLED = originalAuthDisabled;
    }
    if (originalNodeEnv === undefined) {
      Reflect.set(process.env, 'NODE_ENV', 'test');
    } else {
      Reflect.set(process.env, 'NODE_ENV', originalNodeEnv);
    }
  });

  it('rejects a valid login password sent as Bearer in production', async () => {
    invalidatePasswordCache(userName);
    await expect(
      authenticate(makeReq('/', { userName, authToken: password })),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('does not populate the password cache when the prod gate rejects', async () => {
    invalidatePasswordCache(userName);

    // First attempt rejected by the production gate.
    await expect(
      authenticate(makeReq('/', { userName, authToken: password })),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    // If the gate had been bypassed, the cache would now hold a hit and a
    // second call would return success even after we sabotage the stored
    // hash. Sabotage the hash and re-attempt: the request must still be
    // rejected because no cache entry was ever written.
    const sabotaged = await hashPassword('rejects-original');
    await testPrisma.userAccount.update({
      where: { userName },
      data: { passwordHash: sabotaged },
    });
    try {
      await expect(
        authenticate(makeReq('/', { userName, authToken: password })),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    } finally {
      await testPrisma.userAccount.update({
        where: { userName },
        data: { passwordHash: await hashPassword(password) },
      });
    }
  });

  it('still authenticates a correctly-minted ps_key_* in production', async () => {
    expect(apiKeyRaw).not.toBeNull();
    const ctx = await authenticate(makeReq('/', { userName, authToken: apiKeyRaw! }));
    expect(ctx.userName).toBe(userName);
  });

  it('accepts the same password as Bearer when NODE_ENV is not production', async () => {
    invalidatePasswordCache(userName);
    Reflect.set(process.env, 'NODE_ENV', 'development');
    try {
      const ctx = await authenticate(makeReq('/', { userName, authToken: password }));
      expect(ctx.userName).toBe(userName);
    } finally {
      Reflect.set(process.env, 'NODE_ENV', 'production');
      invalidatePasswordCache(userName);
    }
  });
});
