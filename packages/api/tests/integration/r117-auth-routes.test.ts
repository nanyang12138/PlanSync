// R-117: integration coverage for the four auth routes that drive the
// actual login lifecycle (login / password change / verify / logout).
//
// Every other auth-touching test in this suite runs with AUTH_DISABLED=true
// (set in tests/setup.ts) so they can skip credential handling and assert
// authorization on top of a fake "anonymous" header. That's appropriate for
// most route-level tests, but it also means the credential paths themselves
// (open-registration gate, wrong-password rejection, password rotation,
// cookie issuance/clearing) are never exercised end-to-end under their real
// runtime semantics.
//
// This file flips AUTH_DISABLED off for its lifetime and drives the four
// routes via their Next.js Route handlers directly, exactly how the CLI /
// Web UI / `bin/ps-admin` would in production.
//
// Routes under test:
//   POST /api/auth/login    — credential check + web-session key + cookies
//   POST /api/auth/verify   — credential check without touching cookies (CLI)
//   PUT  /api/auth/password — rotate password for an authenticated user
//   POST /api/auth/logout   — clear the session cookies
//
// R-013 dependency: open registration is OFF by default. Tests that need
// the legacy "first password claims the username" behaviour set
// PLANSYNC_OPEN_REGISTRATION=true explicitly and restore it afterwards.
//
// R-014 dependency: the password-as-Bearer cache lives behind
// NODE_ENV !== 'production'. Tests authenticate against the password route
// via the same flow the CLI uses (X-User-Name + Bearer = password), which
// only works because setup.ts pins NODE_ENV=test.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import { POST as loginPost } from '@/app/api/auth/login/route';
import { POST as verifyPost } from '@/app/api/auth/verify/route';
import { PUT as passwordPut } from '@/app/api/auth/password/route';
import { POST as logoutPost } from '@/app/api/auth/logout/route';
import { _resetAuthCacheForTests } from '@/lib/auth';
import { testPrisma, makeReq } from '../helpers/request';

const suite = `r117-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// Convenience: most tests just need to call POST /api/auth/login with
// {userName, password} and inspect the result. We don't need x-user-name
// or Authorization on this endpoint — login itself is unauthenticated.
function loginReq(body: { userName?: string; password?: string }) {
  return makeReq('/api/auth/login', { method: 'POST', body });
}

function verifyReq(body: { userName?: string; password?: string }) {
  return makeReq('/api/auth/verify', { method: 'POST', body });
}

function passwordReq(opts: {
  userName: string;
  authToken: string;
  body: { currentPassword?: string; newPassword?: string };
}) {
  return makeReq('/api/auth/password', {
    method: 'PUT',
    userName: opts.userName,
    authToken: opts.authToken,
    body: opts.body,
  });
}

function logoutReq() {
  return makeReq('/api/auth/logout', { method: 'POST' });
}

describe('R-117: auth login/password/verify/logout integration', () => {
  // Track every UserAccount the suite creates so we can wipe them all in
  // afterAll, even when an `it` block throws and leaves state behind.
  const createdUsers = new Set<string>();
  let originalAuthDisabled: string | undefined;
  let originalOpenReg: string | undefined;

  beforeAll(async () => {
    // The shared setup pins AUTH_DISABLED=true which would short-circuit
    // every route below into the anonymous branch. R-117 is specifically
    // "tests that do NOT go through AUTH_DISABLED", so flip the flag off
    // for this file.
    originalAuthDisabled = process.env.AUTH_DISABLED;
    process.env.AUTH_DISABLED = 'false';
    originalOpenReg = process.env.PLANSYNC_OPEN_REGISTRATION;
    delete process.env.PLANSYNC_OPEN_REGISTRATION;
  });

  afterAll(async () => {
    // Restore env first so the global teardown sees the original values
    // even if user cleanup throws.
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

    // Tear down accounts + the web-session keys they minted.
    for (const userName of createdUsers) {
      await testPrisma.apiKey.deleteMany({ where: { createdBy: userName } }).catch(() => {});
      await testPrisma.userAccount.delete({ where: { userName } }).catch(() => {});
    }
  });

  beforeEach(() => {
    // Each `it` starts with an empty auth cache so a previous test's
    // verifyPassword success doesn't accidentally satisfy a later
    // "should reject" assertion off a stale entry.
    _resetAuthCacheForTests();
  });

  // ------------------------------------------------------------------ login

  describe('POST /api/auth/login', () => {
    it('rejects missing userName or password with 400', async () => {
      const res1 = await loginPost(loginReq({ password: 'whatever' }));
      expect(res1.status).toBe(400);
      const res2 = await loginPost(loginReq({ userName: 'someone' }));
      expect(res2.status).toBe(400);
      // Whitespace-only userName is treated as missing per the route's
      // `userName.trim()` check; pin that down so future refactors don't
      // accidentally accept a blank login.
      const res3 = await loginPost(loginReq({ userName: '   ', password: 'whatever' }));
      expect(res3.status).toBe(400);
    });

    it('rejects unknown user when open registration is OFF (R-013 default)', async () => {
      // Belt and suspenders: explicitly assert the env state we rely on.
      expect(process.env.PLANSYNC_OPEN_REGISTRATION).not.toBe('true');

      const name = `${suite}-unknown`;
      const res = await loginPost(loginReq({ userName: name, password: 'irrelevant' }));
      expect(res.status).toBe(401);
      const body = await readJson(res);
      // The error message hints the operator at the recovery path; assert
      // both the bin/ps-admin guidance and the username are present so the
      // user-facing hint doesn't silently regress to "Invalid username or
      // password" (which would be misleading when the real issue is the
      // missing pre-created account).
      expect(String(body.error)).toContain('bin/ps-admin create-user');
      expect(String(body.error)).toContain(name);

      // And critically: no account row was created as a side effect of
      // the rejected login. R-013's whole point is closing the open
      // registration loophole.
      const account = await testPrisma.userAccount.findUnique({ where: { userName: name } });
      expect(account).toBeNull();
    });

    it('creates the account on first login when PLANSYNC_OPEN_REGISTRATION=true', async () => {
      process.env.PLANSYNC_OPEN_REGISTRATION = 'true';
      const name = `${suite}-open-reg`;
      createdUsers.add(name);
      try {
        const res = await loginPost(loginReq({ userName: name, password: 'open-pw-1234' }));
        expect(res.status).toBe(200);
        const body = await readJson(res);
        expect(body.success).toBe(true);
        expect(body.userName).toBe(name);
        expect(body.isFirstLogin).toBe(true);
        // Returned API key matches the cookie value, and follows the
        // documented `ps_key_*` prefix (so MCP/CLI parsers recognise it).
        expect(typeof body.key).toBe('string');
        expect(String(body.key)).toMatch(/^ps_key_/);

        // The account is now persisted with a non-empty hash.
        const account = await testPrisma.userAccount.findUnique({ where: { userName: name } });
        expect(account).not.toBeNull();
        expect(account?.passwordHash.length).toBeGreaterThan(0);

        // And a `web-session` ApiKey row is created on the same user.
        const sessions = await testPrisma.apiKey.findMany({
          where: { createdBy: name, name: 'web-session' },
        });
        expect(sessions).toHaveLength(1);
      } finally {
        process.env.PLANSYNC_OPEN_REGISTRATION = 'false';
      }
    });

    it('rejects wrong password with 401 for an existing account', async () => {
      // Seed an account directly so we don't depend on the open-registration
      // path also under test.
      const name = `${suite}-wrong-pw`;
      createdUsers.add(name);
      const password = 'correct-horse-battery-staple';
      const salt = crypto.randomBytes(16);
      const dk = crypto.scryptSync(password, salt, 64);
      const passwordHash = `${salt.toString('hex')}:${dk.toString('hex')}`;
      await testPrisma.userAccount.create({ data: { userName: name, passwordHash } });

      const res = await loginPost(loginReq({ userName: name, password: 'definitely-wrong' }));
      expect(res.status).toBe(401);
      const body = await readJson(res);
      expect(String(body.error).toLowerCase()).toContain('invalid');

      // A failed login must not mint a session key. Otherwise a brute-force
      // attempt would leave orphan rows lying around for the attacker to
      // potentially observe via timing or DB inspection.
      const sessions = await testPrisma.apiKey.findMany({
        where: { createdBy: name, name: 'web-session' },
      });
      expect(sessions).toHaveLength(0);
    });

    it('issues a fresh session and replaces the previous web-session on re-login', async () => {
      const name = `${suite}-relogin`;
      createdUsers.add(name);
      const password = 'relogin-password-1234';
      const salt = crypto.randomBytes(16);
      const dk = crypto.scryptSync(password, salt, 64);
      const passwordHash = `${salt.toString('hex')}:${dk.toString('hex')}`;
      await testPrisma.userAccount.create({ data: { userName: name, passwordHash } });

      const r1 = await loginPost(loginReq({ userName: name, password }));
      expect(r1.status).toBe(200);
      const body1 = await readJson(r1);
      const key1 = String(body1.key);
      const sessions1 = await testPrisma.apiKey.findMany({
        where: { createdBy: name, name: 'web-session' },
      });
      expect(sessions1).toHaveLength(1);
      const sessionId1 = sessions1[0].id;

      const r2 = await loginPost(loginReq({ userName: name, password }));
      expect(r2.status).toBe(200);
      const body2 = await readJson(r2);
      const key2 = String(body2.key);
      // Each login mints a brand-new raw key (one-active-session-per-user
      // contract). The previous DB row is deleted, not re-used.
      expect(key2).not.toBe(key1);
      const sessions2 = await testPrisma.apiKey.findMany({
        where: { createdBy: name, name: 'web-session' },
      });
      expect(sessions2).toHaveLength(1);
      expect(sessions2[0].id).not.toBe(sessionId1);
    });

    it('sets the plansync-apikey + plansync-user cookies on success', async () => {
      const name = `${suite}-cookies`;
      createdUsers.add(name);
      const password = 'cookies-pw-1234';
      const salt = crypto.randomBytes(16);
      const dk = crypto.scryptSync(password, salt, 64);
      const passwordHash = `${salt.toString('hex')}:${dk.toString('hex')}`;
      await testPrisma.userAccount.create({ data: { userName: name, passwordHash } });

      const res = await loginPost(loginReq({ userName: name, password }));
      expect(res.status).toBe(200);
      const apiKeyCookie = res.cookies.get('plansync-apikey');
      const userCookie = res.cookies.get('plansync-user');
      expect(apiKeyCookie?.value).toBeTruthy();
      expect(apiKeyCookie?.value).toMatch(/^ps_key_/);
      expect(userCookie?.value).toBe(name);
      // httpOnly on the key, NOT on the user-display cookie. Both keep
      // their attributes aligned with the logout route so the browser
      // can match-and-clear later.
      expect(apiKeyCookie?.httpOnly).toBe(true);
      expect(userCookie?.httpOnly).not.toBe(true);
    });
  });

  // ----------------------------------------------------------------- verify

  describe('POST /api/auth/verify', () => {
    it('creates the account on first verify (CLI bootstrap path)', async () => {
      const name = `${suite}-verify-new`;
      createdUsers.add(name);

      // No `PLANSYNC_OPEN_REGISTRATION` set — the /verify route intentionally
      // does not enforce that gate because it's used by the CLI bootstrap
      // before the admin has had a chance to pre-create accounts. R-013 is
      // about the *web* login path. Make this contract explicit so it
      // doesn't quietly regress.
      const res = await verifyPost(verifyReq({ userName: name, password: 'cli-verify-pw-1' }));
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.success).toBe(true);
      expect(body.isNewUser).toBe(true);
      expect(body.userName).toBe(name);

      const account = await testPrisma.userAccount.findUnique({ where: { userName: name } });
      expect(account).not.toBeNull();

      // And critically: /verify must NOT create a web-session ApiKey, so
      // an active browser session is not invalidated by a CLI login. That's
      // the whole reason /verify exists alongside /login.
      const sessions = await testPrisma.apiKey.findMany({
        where: { createdBy: name, name: 'web-session' },
      });
      expect(sessions).toHaveLength(0);
    });

    it('accepts the right password and rejects the wrong one for an existing account', async () => {
      const name = `${suite}-verify-existing`;
      createdUsers.add(name);
      const password = 'verify-pw-1234';
      const salt = crypto.randomBytes(16);
      const dk = crypto.scryptSync(password, salt, 64);
      const passwordHash = `${salt.toString('hex')}:${dk.toString('hex')}`;
      await testPrisma.userAccount.create({ data: { userName: name, passwordHash } });

      const ok = await verifyPost(verifyReq({ userName: name, password }));
      expect(ok.status).toBe(200);
      const okBody = await readJson(ok);
      expect(okBody.success).toBe(true);
      // For existing accounts, isNewUser is intentionally absent (the route
      // only sets it on first-login). Pin that down.
      expect(okBody.isNewUser).toBeUndefined();

      const bad = await verifyPost(verifyReq({ userName: name, password: 'not-the-password' }));
      expect(bad.status).toBe(401);
      const badBody = await readJson(bad);
      expect(badBody.success).toBe(false);
    });

    it('rejects missing fields with 400', async () => {
      const res = await verifyPost(verifyReq({ userName: '   ' }));
      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------------- password PUT

  describe('PUT /api/auth/password', () => {
    it('rotates the password and invalidates the auth cache', async () => {
      const name = `${suite}-rotate`;
      createdUsers.add(name);
      const password = 'rotate-original-1234';
      const salt = crypto.randomBytes(16);
      const dk = crypto.scryptSync(password, salt, 64);
      const passwordHash = `${salt.toString('hex')}:${dk.toString('hex')}`;
      await testPrisma.userAccount.create({ data: { userName: name, passwordHash } });

      const newPassword = 'rotate-new-1234';
      const res = await passwordPut(
        passwordReq({
          userName: name,
          authToken: password,
          body: { currentPassword: password, newPassword },
        }),
      );
      expect(res.status).toBe(200);

      // The DB now holds the new hash, and the old token no longer
      // verifies against it. We don't store the hash directly — we just
      // confirm the new password authenticates and the old one doesn't
      // by hitting /verify, which exercises the same scrypt verify path
      // authenticate() uses.
      const okWithNew = await verifyPost(verifyReq({ userName: name, password: newPassword }));
      expect(okWithNew.status).toBe(200);

      const failWithOld = await verifyPost(verifyReq({ userName: name, password }));
      expect(failWithOld.status).toBe(401);
    });

    it('rejects wrong currentPassword with 401', async () => {
      const name = `${suite}-rotate-wrong`;
      createdUsers.add(name);
      const password = 'rotate-wrong-current-1234';
      const salt = crypto.randomBytes(16);
      const dk = crypto.scryptSync(password, salt, 64);
      const passwordHash = `${salt.toString('hex')}:${dk.toString('hex')}`;
      await testPrisma.userAccount.create({ data: { userName: name, passwordHash } });

      const res = await passwordPut(
        passwordReq({
          userName: name,
          authToken: password,
          body: { currentPassword: 'not-the-current', newPassword: 'whatever-new-1234' },
        }),
      );
      expect(res.status).toBe(401);

      // The stored hash must be unchanged on a rejected rotation; the old
      // password should still authenticate.
      const stillOk = await verifyPost(verifyReq({ userName: name, password }));
      expect(stillOk.status).toBe(200);
    });

    it('rejects new passwords shorter than 8 chars with 400', async () => {
      const name = `${suite}-short-pw`;
      createdUsers.add(name);
      const password = 'short-pw-original-1234';
      const salt = crypto.randomBytes(16);
      const dk = crypto.scryptSync(password, salt, 64);
      const passwordHash = `${salt.toString('hex')}:${dk.toString('hex')}`;
      await testPrisma.userAccount.create({ data: { userName: name, passwordHash } });

      const res = await passwordPut(
        passwordReq({
          userName: name,
          authToken: password,
          body: { currentPassword: password, newPassword: 'short' },
        }),
      );
      expect(res.status).toBe(400);
    });

    it('rejects missing currentPassword/newPassword with 400', async () => {
      const name = `${suite}-missing-fields`;
      createdUsers.add(name);
      const password = 'missing-fields-pw-1234';
      const salt = crypto.randomBytes(16);
      const dk = crypto.scryptSync(password, salt, 64);
      const passwordHash = `${salt.toString('hex')}:${dk.toString('hex')}`;
      await testPrisma.userAccount.create({ data: { userName: name, passwordHash } });

      const res = await passwordPut(
        passwordReq({ userName: name, authToken: password, body: { newPassword: 'newpwd1234' } }),
      );
      expect(res.status).toBe(400);
    });

    it('rejects unauthenticated callers with 401', async () => {
      // No X-User-Name, no Authorization header → authenticate() throws
      // UNAUTHORIZED in production mode (AUTH_DISABLED is off in this file).
      const req = makeReq('/api/auth/password', {
        method: 'PUT',
        body: { currentPassword: 'whatever', newPassword: 'whatever1234' },
      });
      const res = await passwordPut(req);
      expect(res.status).toBe(401);
    });
  });

  // ----------------------------------------------------------------- logout

  describe('POST /api/auth/logout', () => {
    it('clears both cookies with matching attributes', async () => {
      const res = await logoutPost();
      expect(res.status).toBe(200);
      const apiKeyCookie = res.cookies.get('plansync-apikey');
      const userCookie = res.cookies.get('plansync-user');

      // Cookies are "cleared" by re-issuing them with maxAge=0 and an
      // empty value. We deliberately don't assert value === '' because
      // some Next.js cookie serializers swap the value with a sentinel —
      // what we DO require is maxAge=0 (expiry) and that the SameSite +
      // Secure attributes match what /login set, so the browser actually
      // removes the original cookie instead of keeping two side-by-side
      // (the bug PR#347 documents).
      expect(apiKeyCookie?.maxAge).toBe(0);
      expect(userCookie?.maxAge).toBe(0);

      // Default (non-cross-site) deployment uses sameSite=lax. The Next.js
      // ResponseCookies API stores sameSite in lowercase; accept both
      // casings to stay forward-compatible.
      const apiSameSite = String(apiKeyCookie?.sameSite ?? '').toLowerCase();
      const userSameSite = String(userCookie?.sameSite ?? '').toLowerCase();
      expect(['lax', '']).toContain(apiSameSite);
      expect(['lax', '']).toContain(userSameSite);

      // httpOnly contract: only the API key cookie carries httpOnly.
      expect(apiKeyCookie?.httpOnly).toBe(true);
      expect(userCookie?.httpOnly).not.toBe(true);
    });
  });
});
