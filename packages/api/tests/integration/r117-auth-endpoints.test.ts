// R-117 [HIGH]: integration tests for the /api/auth/{login,password,verify,logout}
// endpoints running **without** AUTH_DISABLED=true.
//
// The shared test setup (tests/setup.ts) pins `AUTH_DISABLED=true` so the
// bulk of the integration suite can skip authentication. That flag short-
// circuits the password-Bearer + master-secret paths, which means the
// rest of the suite never exercises the real login / password / verify /
// logout flows the production deployment runs on.
//
// This file flips AUTH_DISABLED off for its lifetime and asserts the four
// endpoints behave correctly when authentication is enforced:
//
//   POST /api/auth/login
//     - 400 when userName or password is missing/blank
//     - 401 when the account exists and the supplied password is wrong
//     - 401 when the account does NOT exist and PLANSYNC_OPEN_REGISTRATION
//       is not 'true' (R-013: open registration is off by default)
//     - 200 + sets `plansync-apikey` and `plansync-user` cookies + returns
//       a fresh `ps_key_*` API key when credentials match
//     - 200 a second time deletes the prior `web-session` API key (only
//       one active browser session per user)
//     - 200 with PLANSYNC_OPEN_REGISTRATION='true' on a brand-new account
//       creates the userAccount row and returns isFirstLogin: true
//
//   PUT /api/auth/password
//     - 401 when no authentication is presented at all
//     - 400 when currentPassword / newPassword are missing
//     - 400 when newPassword is shorter than 8 chars
//     - 401 when currentPassword does not match the stored hash
//     - 200 + the stored hash is updated + the password cache is evicted
//       (a subsequent `authenticate` with the old token must fail; the new
//       token must succeed)
//
//   POST /api/auth/verify
//     - 400 when userName or password is missing
//     - 200 + isNewUser: true when the account does not yet exist (CLI
//       first-login bootstrap path — verify deliberately does NOT honour
//       PLANSYNC_OPEN_REGISTRATION because it doesn't mint a session key)
//     - 401 when the account exists and the password is wrong
//     - 200 (no isNewUser flag) when the password matches
//
//   POST /api/auth/logout
//     - 200 + clears both cookies (`plansync-apikey` and `plansync-user`)
//       with maxAge=0 so the browser drops them
//
// All assertions are made directly against the route handlers via
// `makeReq` so we exercise the Next.js NextRequest/NextResponse path
// without needing a running server.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { POST as loginPost } from '@/app/api/auth/login/route';
import { PUT as passwordPut } from '@/app/api/auth/password/route';
import { POST as verifyPost } from '@/app/api/auth/verify/route';
import { POST as logoutPost } from '@/app/api/auth/logout/route';
import { authenticate, invalidatePasswordCache, _resetAuthCacheForTests } from '@/lib/auth';
import { testPrisma, makeReq } from '../helpers/request';

const RUN_TAG = `r117-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const existingUser = `${RUN_TAG}-existing`;
const passwordChangeUser = `${RUN_TAG}-pwchg`;
const verifyUser = `${RUN_TAG}-verify`;
const verifyNewUser = `${RUN_TAG}-verify-new`;
const openRegUser = `${RUN_TAG}-openreg`;
const noAccountUser = `${RUN_TAG}-noaccount`;
const initialPassword = 'r117-correct-horse-battery';
const rotatedPassword = 'r117-staple-rotated-2026';

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Pull a Set-Cookie value out of a NextResponse. Next.js exposes them via
 * `response.cookies.get(...)` which is a `ResponseCookie` object containing
 * `value`, `maxAge`, `httpOnly`, `sameSite`, `secure`. We use that here so
 * the assertions don't rely on header string parsing.
 */
function getCookie(res: Response, name: string) {
  // ResponseCookies.getAll() ships as part of next/server's NextResponse, so
  // we cast through unknown to avoid the wider Response type.
  const cookies = (res as unknown as { cookies: { get(n: string): unknown } }).cookies;
  return cookies.get(name) as
    | { value: string; maxAge?: number; httpOnly?: boolean; sameSite?: string }
    | undefined;
}

async function hashPasswordForFixture(password: string): Promise<string> {
  const crypto = await import('crypto');
  const salt = crypto.randomBytes(16);
  return new Promise<string>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, dk) => {
      if (err) reject(err);
      else resolve(`${salt.toString('hex')}:${dk.toString('hex')}`);
    });
  });
}

describe('R-117: auth login/password/verify/logout (AUTH_DISABLED=false)', () => {
  let originalAuthDisabled: string | undefined;
  let originalOpenReg: string | undefined;

  beforeAll(async () => {
    // Flip AUTH_DISABLED off for the duration of this file; authenticate()
    // reads process.env on every call so the change takes effect immediately.
    originalAuthDisabled = process.env.AUTH_DISABLED;
    process.env.AUTH_DISABLED = 'false';
    // Default the open-registration knob to OFF (R-013). Individual tests
    // that need the legacy "first password claims the username" behaviour
    // toggle it inline.
    originalOpenReg = process.env.PLANSYNC_OPEN_REGISTRATION;
    delete process.env.PLANSYNC_OPEN_REGISTRATION;

    // Seed the accounts we expect to already exist. login + password +
    // verify all branch on `userAccount.findUnique`, so we control the
    // pre-state explicitly here instead of relying on test execution order.
    await testPrisma.userAccount.create({
      data: { userName: existingUser, passwordHash: await hashPasswordForFixture(initialPassword) },
    });
    await testPrisma.userAccount.create({
      data: {
        userName: passwordChangeUser,
        passwordHash: await hashPasswordForFixture(initialPassword),
      },
    });
    await testPrisma.userAccount.create({
      data: { userName: verifyUser, passwordHash: await hashPasswordForFixture(initialPassword) },
    });
  });

  afterAll(async () => {
    // Restore env first so any post-suite tests see the original
    // AUTH_DISABLED / open-registration setting.
    if (originalAuthDisabled === undefined) {
      delete process.env.AUTH_DISABLED;
    } else {
      process.env.AUTH_DISABLED = originalAuthDisabled;
    }
    if (originalOpenReg === undefined) {
      delete process.env.PLANSYNC_OPEN_REGISTRATION;
    } else {
      process.env.PLANSYNC_OPEN_REGISTRATION = originalOpenReg;
    }

    // Wipe out every userAccount / apiKey row we may have created. The
    // openRegUser / verifyNewUser rows are created by the routes themselves
    // (not the beforeAll seeding) so we list them explicitly.
    const userNames = [
      existingUser,
      passwordChangeUser,
      verifyUser,
      verifyNewUser,
      openRegUser,
      noAccountUser,
    ];
    await testPrisma.apiKey.deleteMany({ where: { createdBy: { in: userNames } } });
    await testPrisma.userAccount
      .deleteMany({ where: { userName: { in: userNames } } })
      .catch(() => {});
  });

  beforeEach(() => {
    // Each test starts with an empty auth cache so the cache-eviction
    // assertions below cannot be satisfied accidentally by stale state.
    _resetAuthCacheForTests();
  });

  // ---------- POST /api/auth/login ----------

  it('login: 400 when userName or password is missing/blank', async () => {
    const r1 = await loginPost(
      makeReq('/api/auth/login', { method: 'POST', body: { password: 'p' } }),
    );
    expect(r1.status).toBe(400);
    const r2 = await loginPost(
      makeReq('/api/auth/login', { method: 'POST', body: { userName: '   ', password: 'p' } }),
    );
    expect(r2.status).toBe(400);
    const r3 = await loginPost(
      makeReq('/api/auth/login', { method: 'POST', body: { userName: existingUser } }),
    );
    expect(r3.status).toBe(400);
  });

  it('login: 401 when the account exists and the password is wrong', async () => {
    const res = await loginPost(
      makeReq('/api/auth/login', {
        method: 'POST',
        body: { userName: existingUser, password: 'definitely-not-the-password' },
      }),
    );
    expect(res.status).toBe(401);
    const body = await readJson(res);
    expect(String(body.error)).toMatch(/invalid username or password/i);
  });

  it('login: 401 when the account does not exist and open-registration is off', async () => {
    expect(process.env.PLANSYNC_OPEN_REGISTRATION).toBeUndefined();
    const res = await loginPost(
      makeReq('/api/auth/login', {
        method: 'POST',
        body: { userName: noAccountUser, password: 'whatever-pw-1' },
      }),
    );
    expect(res.status).toBe(401);
    const body = await readJson(res);
    // R-013 surfaces the admin-onboarding instruction so the caller knows
    // how to recover. Asserting on it pins the contract.
    expect(String(body.error)).toMatch(/admin/i);
    // The userAccount row must NOT have been created as a side effect.
    const row = await testPrisma.userAccount.findUnique({ where: { userName: noAccountUser } });
    expect(row).toBeNull();
  });

  it('login: 200 with correct credentials sets both cookies and returns a fresh ps_key_*', async () => {
    const res = await loginPost(
      makeReq('/api/auth/login', {
        method: 'POST',
        body: { userName: existingUser, password: initialPassword },
      }),
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.success).toBe(true);
    expect(body.userName).toBe(existingUser);
    expect(body.isFirstLogin).toBe(false);
    expect(typeof body.key).toBe('string');
    expect(String(body.key)).toMatch(/^ps_key_/);

    const apiKeyCookie = getCookie(res, 'plansync-apikey');
    const userCookie = getCookie(res, 'plansync-user');
    expect(apiKeyCookie?.value).toBe(String(body.key));
    expect(apiKeyCookie?.httpOnly).toBe(true);
    expect(userCookie?.value).toBe(existingUser);
    // We expect non-zero maxAge (≈1 year). Comparing >= 1 is enough to
    // catch the "logout case used clear semantics" regression.
    expect(apiKeyCookie?.maxAge ?? 0).toBeGreaterThan(0);

    // A `web-session` ApiKey row must now exist for this user.
    const keyRow = await testPrisma.apiKey.findFirst({
      where: { createdBy: existingUser, name: 'web-session' },
    });
    expect(keyRow).not.toBeNull();
  });

  it('login: a second successful login replaces the prior web-session API key', async () => {
    // Two consecutive logins for the same user. After the second call,
    // there must be exactly one `web-session` ApiKey row and it must NOT
    // be the one minted by the first call.
    const r1 = await loginPost(
      makeReq('/api/auth/login', {
        method: 'POST',
        body: { userName: existingUser, password: initialPassword },
      }),
    );
    expect(r1.status).toBe(200);
    const body1 = await readJson(r1);
    const firstKey = String(body1.key);

    const r2 = await loginPost(
      makeReq('/api/auth/login', {
        method: 'POST',
        body: { userName: existingUser, password: initialPassword },
      }),
    );
    expect(r2.status).toBe(200);
    const body2 = await readJson(r2);
    const secondKey = String(body2.key);
    expect(secondKey).not.toBe(firstKey);

    const rows = await testPrisma.apiKey.findMany({
      where: { createdBy: existingUser, name: 'web-session' },
    });
    // R-073/R-117: only one active web-session row at a time.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.keyPrefix).toBe(secondKey.slice(0, 15));
  });

  it('login: PLANSYNC_OPEN_REGISTRATION=true bootstraps a new account on first login', async () => {
    const previous = process.env.PLANSYNC_OPEN_REGISTRATION;
    process.env.PLANSYNC_OPEN_REGISTRATION = 'true';
    try {
      const res = await loginPost(
        makeReq('/api/auth/login', {
          method: 'POST',
          body: { userName: openRegUser, password: initialPassword },
        }),
      );
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.isFirstLogin).toBe(true);
      const account = await testPrisma.userAccount.findUnique({
        where: { userName: openRegUser },
      });
      expect(account).not.toBeNull();
    } finally {
      if (previous === undefined) delete process.env.PLANSYNC_OPEN_REGISTRATION;
      else process.env.PLANSYNC_OPEN_REGISTRATION = previous;
    }
  });

  // ---------- PUT /api/auth/password ----------

  it('password: 401 when no authentication is presented', async () => {
    const res = await passwordPut(
      makeReq('/api/auth/password', {
        method: 'PUT',
        body: { currentPassword: initialPassword, newPassword: rotatedPassword },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('password: 400 when currentPassword or newPassword is missing', async () => {
    const res = await passwordPut(
      makeReq('/api/auth/password', {
        method: 'PUT',
        userName: passwordChangeUser,
        authToken: initialPassword,
        body: { currentPassword: initialPassword },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('password: 400 when newPassword is shorter than 8 characters', async () => {
    const res = await passwordPut(
      makeReq('/api/auth/password', {
        method: 'PUT',
        userName: passwordChangeUser,
        authToken: initialPassword,
        body: { currentPassword: initialPassword, newPassword: 'short' },
      }),
    );
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(String(body.error)).toMatch(/8 characters/);
  });

  it('password: 401 when currentPassword does not match the stored hash', async () => {
    const res = await passwordPut(
      makeReq('/api/auth/password', {
        method: 'PUT',
        userName: passwordChangeUser,
        authToken: initialPassword,
        body: {
          currentPassword: 'definitely-wrong-current',
          newPassword: rotatedPassword,
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('password: 200 rotates the stored hash AND evicts the password cache', async () => {
    // Authenticate once so the password cache has an entry for the old
    // token. Without this we couldn't observe the post-update eviction.
    const primed = await authenticate(
      makeReq('/api/auth/whatever', {
        userName: passwordChangeUser,
        authToken: initialPassword,
      }),
    );
    expect(primed.userName).toBe(passwordChangeUser);

    const res = await passwordPut(
      makeReq('/api/auth/password', {
        method: 'PUT',
        userName: passwordChangeUser,
        authToken: initialPassword,
        body: { currentPassword: initialPassword, newPassword: rotatedPassword },
      }),
    );
    expect(res.status).toBe(200);

    // The DB hash must have changed. Old password must now fail to
    // authenticate; new one must succeed. (The route also calls
    // `invalidatePasswordCache` so the previously-cached entry can't keep
    // the old token alive for 5 minutes.)
    await expect(
      authenticate(
        makeReq('/api/auth/whatever', {
          userName: passwordChangeUser,
          authToken: initialPassword,
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const ctx = await authenticate(
      makeReq('/api/auth/whatever', {
        userName: passwordChangeUser,
        authToken: rotatedPassword,
      }),
    );
    expect(ctx.userName).toBe(passwordChangeUser);

    // Roll back the test fixture so afterAll's cleanup ordering doesn't
    // matter and so the password change doesn't leak into any later test
    // in this file that authenticates as passwordChangeUser.
    invalidatePasswordCache(passwordChangeUser);
    await testPrisma.userAccount.update({
      where: { userName: passwordChangeUser },
      data: { passwordHash: await hashPasswordForFixture(initialPassword) },
    });
  });

  // ---------- POST /api/auth/verify ----------

  it('verify: 400 when userName or password is missing', async () => {
    const r1 = await verifyPost(
      makeReq('/api/auth/verify', { method: 'POST', body: { password: 'p' } }),
    );
    expect(r1.status).toBe(400);
    const r2 = await verifyPost(
      makeReq('/api/auth/verify', { method: 'POST', body: { userName: 'x' } }),
    );
    expect(r2.status).toBe(400);
  });

  it('verify: 200 + isNewUser: true creates a userAccount on first call', async () => {
    const before = await testPrisma.userAccount.findUnique({ where: { userName: verifyNewUser } });
    expect(before).toBeNull();

    const res = await verifyPost(
      makeReq('/api/auth/verify', {
        method: 'POST',
        body: { userName: verifyNewUser, password: initialPassword },
      }),
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.success).toBe(true);
    expect(body.isNewUser).toBe(true);
    expect(body.userName).toBe(verifyNewUser);

    const after = await testPrisma.userAccount.findUnique({ where: { userName: verifyNewUser } });
    expect(after).not.toBeNull();
    // verify must not mint any ApiKey rows (that's login's job).
    const keys = await testPrisma.apiKey.findMany({ where: { createdBy: verifyNewUser } });
    expect(keys).toHaveLength(0);
  });

  it('verify: 401 with wrong password against an existing account', async () => {
    const res = await verifyPost(
      makeReq('/api/auth/verify', {
        method: 'POST',
        body: { userName: verifyUser, password: 'definitely-wrong-pw' },
      }),
    );
    expect(res.status).toBe(401);
    const body = await readJson(res);
    expect(body.success).toBe(false);
  });

  it('verify: 200 with correct password and no isNewUser flag', async () => {
    const res = await verifyPost(
      makeReq('/api/auth/verify', {
        method: 'POST',
        body: { userName: verifyUser, password: initialPassword },
      }),
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.success).toBe(true);
    expect(body.userName).toBe(verifyUser);
    expect(body.isNewUser).toBeUndefined();
  });

  // ---------- POST /api/auth/logout ----------

  it('logout: 200 and clears both auth cookies', async () => {
    const res = await logoutPost();
    expect(res.status).toBe(200);
    const apiKey = getCookie(res, 'plansync-apikey');
    const user = getCookie(res, 'plansync-user');
    expect(apiKey).toBeDefined();
    expect(user).toBeDefined();
    expect(apiKey?.value).toBe('');
    expect(user?.value).toBe('');
    expect(apiKey?.maxAge).toBe(0);
    expect(user?.maxAge).toBe(0);
    expect(apiKey?.httpOnly).toBe(true);
  });
});
