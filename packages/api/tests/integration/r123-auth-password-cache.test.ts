// R-123: auth.ts password-Bearer cache boundary tests.
//
// `authenticate()` keeps a 5-minute in-memory cache of successful password
// verifications keyed by `${userName}:${token}` so that a CLI hitting the API
// once per second does not pay the scrypt cost on every call. The boundary
// behaviour we want to lock in:
//
//   1. After a successful login, a second login with the same token does
//      NOT re-read `userAccount.passwordHash` from the database. We assert
//      this by mutating the stored hash out-of-band and confirming the old
//      token still authenticates.
//   2. `invalidatePasswordCache(userName)` evicts only that user's entries
//      and forces re-verification on the next call.
//   3. Wrong-password attempts never poison the cache for a subsequent
//      successful login with the correct password.
//   4. Invalidating one user's cache does not knock out a different user's
//      cached entry.
//   5. The cache is keyed by both userName and token, so a user with two
//      different valid tokens (e.g. password + an alternative password
//      after a rotation) gets two independent cache entries — invalidating
//      by user clears them both.
//
// All of these would silently regress (and let a stale password keep working
// for up to 5 minutes after a forced logout / password change) if someone
// refactored the cache without these assertions.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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

const userName = `r123-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const otherUser = `r123-other-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const password = 'r123-cache-password-original';
const replacementPassword = 'r123-cache-password-rotated';
const otherPassword = 'r123-other-password';

describe('R-123: auth password cache boundaries', () => {
  let originalAuthDisabled: string | undefined;

  beforeAll(async () => {
    // The shared test setup pins AUTH_DISABLED=true so most tests can skip
    // login. That setting also short-circuits the password-cache path: if
    // verifyPassword returns false, authenticate falls through to the
    // anonymous AUTH_DISABLED branch and resolves with the x-user-name header
    // instead of throwing. We need the strict path here to observe the cache
    // boundaries, so flip the flag for the lifetime of this file.
    originalAuthDisabled = process.env.AUTH_DISABLED;
    process.env.AUTH_DISABLED = 'false';

    await testPrisma.userAccount.create({
      data: { userName, passwordHash: await hashPassword(password) },
    });
    await testPrisma.userAccount.create({
      data: { userName: otherUser, passwordHash: await hashPassword(otherPassword) },
    });
  });

  afterAll(async () => {
    invalidatePasswordCache(userName);
    invalidatePasswordCache(otherUser);
    await testPrisma.userAccount.delete({ where: { userName } }).catch(() => {});
    await testPrisma.userAccount.delete({ where: { userName: otherUser } }).catch(() => {});
    if (originalAuthDisabled === undefined) {
      delete process.env.AUTH_DISABLED;
    } else {
      process.env.AUTH_DISABLED = originalAuthDisabled;
    }
  });

  beforeEach(() => {
    // Each test starts from a clean cache so the order of `it` blocks is
    // irrelevant; we never want one case's caching to silently satisfy
    // another's first call.
    invalidatePasswordCache(userName);
    invalidatePasswordCache(otherUser);
  });

  it('cache hit short-circuits the DB verifyPassword on the second call', async () => {
    const ctx1 = await authenticate(makeReq('/', { userName, authToken: password }));
    expect(ctx1.userName).toBe(userName);

    // Mutate the stored hash so a fresh verifyPassword would now reject the
    // original `password`. The cache entry must still allow it through.
    const sabotagedHash = await hashPassword('this-hash-rejects-the-original-password');
    await testPrisma.userAccount.update({
      where: { userName },
      data: { passwordHash: sabotagedHash },
    });
    try {
      const ctx2 = await authenticate(makeReq('/', { userName, authToken: password }));
      expect(ctx2.userName).toBe(userName);
    } finally {
      await testPrisma.userAccount.update({
        where: { userName },
        data: { passwordHash: await hashPassword(password) },
      });
    }
  });

  it('invalidatePasswordCache forces re-verification against the DB', async () => {
    // Prime the cache with the correct password.
    await authenticate(makeReq('/', { userName, authToken: password }));

    // Rotate the password in the DB. Without invalidation the old token still
    // works because of the cache, so we first prove that, then invalidate.
    await testPrisma.userAccount.update({
      where: { userName },
      data: { passwordHash: await hashPassword(replacementPassword) },
    });

    const stillCached = await authenticate(makeReq('/', { userName, authToken: password }));
    expect(stillCached.userName).toBe(userName);

    invalidatePasswordCache(userName);

    await expect(
      authenticate(makeReq('/', { userName, authToken: password })),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const fresh = await authenticate(
      makeReq('/', { userName, authToken: replacementPassword }),
    );
    expect(fresh.userName).toBe(userName);

    // Restore the original password so later tests in this file see a known
    // baseline.
    await testPrisma.userAccount.update({
      where: { userName },
      data: { passwordHash: await hashPassword(password) },
    });
  });

  it('wrong-password attempts do not poison the cache for the correct password', async () => {
    await expect(
      authenticate(makeReq('/', { userName, authToken: 'definitely-not-the-password' })),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    // The failed attempt must not have written anything keyed on this user.
    // If it had, the next call with the *correct* password could accidentally
    // be treated as a wrong-password cache hit (or simply skipped). Verify
    // the correct password still authenticates.
    const ctx = await authenticate(makeReq('/', { userName, authToken: password }));
    expect(ctx.userName).toBe(userName);
  });

  it('invalidatePasswordCache(user) leaves other users untouched', async () => {
    await authenticate(makeReq('/', { userName, authToken: password }));
    await authenticate(makeReq('/', { userName: otherUser, authToken: otherPassword }));

    // Sabotage the OTHER user's hash so a fresh verify would fail.
    const sabotagedHash = await hashPassword('rejects-other-password');
    await testPrisma.userAccount.update({
      where: { userName: otherUser },
      data: { passwordHash: sabotagedHash },
    });

    // Invalidate ONLY userName. The other user's cache must survive.
    invalidatePasswordCache(userName);

    try {
      const stillCached = await authenticate(
        makeReq('/', { userName: otherUser, authToken: otherPassword }),
      );
      expect(stillCached.userName).toBe(otherUser);
    } finally {
      await testPrisma.userAccount.update({
        where: { userName: otherUser },
        data: { passwordHash: await hashPassword(otherPassword) },
      });
    }
  });

  it('different valid tokens for the same user are cached independently and invalidated together', async () => {
    // Add a second valid password hash *concurrently* by minting a second
    // userAccount-style cache entry: we approximate this by rotating the
    // hash, priming the cache with the new token, restoring the original
    // hash, and then priming the cache with the original token. After both
    // calls, the cache holds two entries for `userName` (one per token) and
    // both should be evicted by a single invalidatePasswordCache(userName).
    await testPrisma.userAccount.update({
      where: { userName },
      data: { passwordHash: await hashPassword(replacementPassword) },
    });
    await authenticate(makeReq('/', { userName, authToken: replacementPassword }));

    await testPrisma.userAccount.update({
      where: { userName },
      data: { passwordHash: await hashPassword(password) },
    });
    await authenticate(makeReq('/', { userName, authToken: password }));

    // Sanity: at this point both tokens are cached. Sabotage the DB hash so
    // any non-cached path would fail.
    await testPrisma.userAccount.update({
      where: { userName },
      data: { passwordHash: await hashPassword('sabotaged-for-eviction-check') },
    });

    // Each token should still work via its independent cache entry.
    const a = await authenticate(makeReq('/', { userName, authToken: replacementPassword }));
    expect(a.userName).toBe(userName);
    const b = await authenticate(makeReq('/', { userName, authToken: password }));
    expect(b.userName).toBe(userName);

    // Invalidate by user — both entries should now be gone.
    invalidatePasswordCache(userName);

    await expect(
      authenticate(makeReq('/', { userName, authToken: password })),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      authenticate(makeReq('/', { userName, authToken: replacementPassword })),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    // Restore the canonical password for any later tests.
    await testPrisma.userAccount.update({
      where: { userName },
      data: { passwordHash: await hashPassword(password) },
    });
  });
});
