// R-117: Integration tests for the four auth surfaces — login, verify, password,
// logout — that exercise the real authentication pipeline (i.e. AUTH_DISABLED
// is forced OFF for the lifetime of this file).
//
// Why "without AUTH_DISABLED": the global tests/setup.ts pins
// `AUTH_DISABLED=true` so most integration tests can short-circuit auth and
// focus on business logic. That means the password-change route (the only
// auth route guarded by `authenticate()`) is never actually exercised
// against a real user/credential pair in the rest of the suite. This file
// flips `AUTH_DISABLED=false` to close that gap.
//
// Coverage matrix:
//   POST /api/auth/login     happy path · web-session replacement · wrong pw · missing fields
//   POST /api/auth/verify    existing happy path (no key churn) · wrong pw · CLI auto-create · missing fields
//   PUT  /api/auth/password  401 without auth · happy path + cache invalidation · wrong currentPw · short newPw · missing fields
//   POST /api/auth/logout    issues clearing cookies regardless of auth state
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { POST as loginPost } from '@/app/api/auth/login/route';
import { POST as verifyPost } from '@/app/api/auth/verify/route';
import { PUT as passwordPut } from '@/app/api/auth/password/route';
import { POST as logoutPost } from '@/app/api/auth/logout/route';
import { NextRequest } from 'next/server';
import { invalidatePasswordCache } from '@/lib/auth';
import { makeReq, testPrisma } from '../helpers/request';

const scrypt = promisify(crypto.scrypt);

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const dk = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt.toString('hex')}:${dk.toString('hex')}`;
}

async function seedAccount(userName: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  await testPrisma.userAccount.upsert({
    where: { userName },
    create: { userName, passwordHash },
    update: { passwordHash },
  });
}

async function deleteAccount(userName: string): Promise<void> {
  await testPrisma.apiKey.deleteMany({ where: { createdBy: userName } }).catch(() => {});
  await testPrisma.userAccount.deleteMany({ where: { userName } }).catch(() => {});
  invalidatePasswordCache(userName);
}

function makeJsonReq(url: string, body: unknown, method = 'POST'): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function readSetCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = headers.get('set-cookie') ?? '';
  return raw
    .split(/,(?=\s*[A-Za-z_][A-Za-z0-9_-]*=)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const ORIGINAL_AUTH_DISABLED = process.env.AUTH_DISABLED;
const ORIGINAL_OPEN_REG = process.env.PLANSYNC_OPEN_REGISTRATION;

describe('R-117: auth login/password/verify/logout — real pipeline (AUTH_DISABLED=off)', () => {
  beforeAll(() => {
    // Strict mode: drive every authenticate() call through the actual
    // password / API-key branches. Closed registration so first-time login
    // can be tested as a 401, decoupled from the seeded accounts below.
    process.env.AUTH_DISABLED = 'false';
    process.env.PLANSYNC_OPEN_REGISTRATION = 'false';
  });

  afterAll(() => {
    if (ORIGINAL_AUTH_DISABLED === undefined) {
      // Default in setup.ts is 'true'; preserve that so neighbouring
      // tests that assume AUTH_DISABLED keep passing.
      process.env.AUTH_DISABLED = 'true';
    } else {
      process.env.AUTH_DISABLED = ORIGINAL_AUTH_DISABLED;
    }
    if (ORIGINAL_OPEN_REG === undefined) {
      delete process.env.PLANSYNC_OPEN_REGISTRATION;
    } else {
      process.env.PLANSYNC_OPEN_REGISTRATION = ORIGINAL_OPEN_REG;
    }
  });

  describe('POST /api/auth/login', () => {
    const userName = 'r117-login';
    const password = 'r117-login-pw-01';

    beforeAll(async () => {
      await deleteAccount(userName);
      await seedAccount(userName, password);
    });

    afterAll(async () => {
      await deleteAccount(userName);
    });

    it('happy path: returns key, sets cookies, replaces existing web-session keys', async () => {
      // Pre-create a stale web-session key. The login route must delete it
      // (one active web-session per user) and mint exactly one fresh key.
      const stale = await testPrisma.apiKey.create({
        data: {
          name: 'web-session',
          keyHash: 'stale:hash',
          keyPrefix: 'ps_key_stale12',
          permissions: ['read'],
          createdBy: userName,
        },
      });

      const res = await loginPost(
        makeJsonReq('http://localhost/api/auth/login', { userName, password }) as never,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.userName).toBe(userName);
      expect(body.isFirstLogin).toBe(false);
      expect(typeof body.key).toBe('string');
      expect(body.key as string).toMatch(/^ps_key_/);

      const setCookies = readSetCookies(res);
      const apiKeyCookie = setCookies.find((c) => c.startsWith('plansync-apikey='));
      const userCookie = setCookies.find((c) => c.startsWith('plansync-user='));
      expect(apiKeyCookie).toBeDefined();
      expect(userCookie).toBeDefined();
      expect(apiKeyCookie!.toLowerCase()).toContain('httponly');

      const staleAfter = await testPrisma.apiKey.findUnique({ where: { id: stale.id } });
      expect(staleAfter).toBeNull();

      const sessions = await testPrisma.apiKey.findMany({
        where: { createdBy: userName, name: 'web-session' },
      });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].keyPrefix).toBe((body.key as string).slice(0, 15));
    });

    it('rejects wrong password with 401', async () => {
      const res = await loginPost(
        makeJsonReq('http://localhost/api/auth/login', {
          userName,
          password: 'definitely-not-it',
        }) as never,
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(String(body.error)).toMatch(/Invalid username or password/);
    });

    it('rejects missing password with 400', async () => {
      const res = await loginPost(
        makeJsonReq('http://localhost/api/auth/login', { userName }) as never,
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(String(body.error)).toMatch(/userName and password required/);
    });

    it('rejects unknown user when registration is closed', async () => {
      const res = await loginPost(
        makeJsonReq('http://localhost/api/auth/login', {
          userName: 'r117-login-stranger',
          password: 'whatever-12',
        }) as never,
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(String(body.error)).toMatch(/created by admin/i);
      const account = await testPrisma.userAccount.findUnique({
        where: { userName: 'r117-login-stranger' },
      });
      expect(account).toBeNull();
    });
  });

  describe('POST /api/auth/verify', () => {
    const existingUser = 'r117-verify-existing';
    const newUser = 'r117-verify-new';
    const password = 'r117-verify-pw-01';

    beforeAll(async () => {
      await deleteAccount(existingUser);
      await deleteAccount(newUser);
      await seedAccount(existingUser, password);
    });

    afterAll(async () => {
      await deleteAccount(existingUser);
      await deleteAccount(newUser);
    });

    it('happy path for existing account: 200, no web-session key churn', async () => {
      // verify() must NOT touch web-session keys (login() does that).
      // Seed one and confirm it survives.
      const seeded = await testPrisma.apiKey.create({
        data: {
          name: 'web-session',
          keyHash: 'verify:keep',
          keyPrefix: 'ps_key_keep0001',
          permissions: ['read'],
          createdBy: existingUser,
        },
      });

      const res = await verifyPost(
        makeJsonReq('http://localhost/api/auth/verify', {
          userName: existingUser,
          password,
        }) as never,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.userName).toBe(existingUser);
      expect(body.isNewUser).toBeUndefined();

      const after = await testPrisma.apiKey.findUnique({ where: { id: seeded.id } });
      expect(after).not.toBeNull();
    });

    it('rejects wrong password with 401 + success=false', async () => {
      const res = await verifyPost(
        makeJsonReq('http://localhost/api/auth/verify', {
          userName: existingUser,
          password: 'wrong-pw',
        }) as never,
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(String(body.error)).toMatch(/Invalid username or password/);
    });

    it('first call for unknown user creates the UserAccount (CLI bootstrap path)', async () => {
      // Distinct from /api/auth/login: verify() is the CLI bootstrap entry
      // and intentionally creates the account regardless of
      // PLANSYNC_OPEN_REGISTRATION (login() is the gated path).
      const res = await verifyPost(
        makeJsonReq('http://localhost/api/auth/verify', {
          userName: newUser,
          password,
        }) as never,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.isNewUser).toBe(true);

      const account = await testPrisma.userAccount.findUnique({
        where: { userName: newUser },
      });
      expect(account).not.toBeNull();
    });

    it('rejects missing password with 400', async () => {
      const res = await verifyPost(
        makeJsonReq('http://localhost/api/auth/verify', { userName: existingUser }) as never,
      );
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/auth/password', () => {
    const userName = 'r117-password';
    const password = 'r117-pw-original-01';

    beforeAll(async () => {
      await deleteAccount(userName);
      await seedAccount(userName, password);
    });

    afterAll(async () => {
      await deleteAccount(userName);
    });

    it('rejects an unauthenticated request with 401 (proves AUTH_DISABLED is off)', async () => {
      const req = makeReq('/api/auth/password', {
        method: 'PUT',
        body: { currentPassword: password, newPassword: 'whatever-safe-1' },
      });
      const res = await passwordPut(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(String(body.error)).toMatch(/Missing or invalid Authorization header/);
    });

    it('rejects wrong currentPassword with 401', async () => {
      const req = makeReq('/api/auth/password', {
        method: 'PUT',
        userName,
        authToken: password,
        body: { currentPassword: 'definitely-wrong', newPassword: 'replace-me-12' },
      });
      const res = await passwordPut(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(String(body.error)).toMatch(/Current password is incorrect/);
    });

    it('rejects newPassword shorter than 8 characters with 400', async () => {
      const req = makeReq('/api/auth/password', {
        method: 'PUT',
        userName,
        authToken: password,
        body: { currentPassword: password, newPassword: 'short' },
      });
      const res = await passwordPut(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(String(body.error)).toMatch(/at least 8 characters/);
    });

    it('rejects missing newPassword with 400', async () => {
      const req = makeReq('/api/auth/password', {
        method: 'PUT',
        userName,
        authToken: password,
        body: { currentPassword: password },
      });
      const res = await passwordPut(req);
      expect(res.status).toBe(400);
    });

    it('happy path: updates passwordHash, invalidates auth cache, old password rejected next', async () => {
      const newPw = 'r117-pw-rotated-01';

      // Drive the request through password-Bearer auth (the only auth path
      // the user has at this point). This exercises the real
      // authenticate() pipeline, including the post-update
      // invalidatePasswordCache() call.
      const req = makeReq('/api/auth/password', {
        method: 'PUT',
        userName,
        authToken: password,
        body: { currentPassword: password, newPassword: newPw },
      });
      const res = await passwordPut(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);

      // The persisted hash must now verify the new password and reject the
      // old one.
      const account = await testPrisma.userAccount.findUnique({ where: { userName } });
      expect(account).not.toBeNull();
      // Old password no longer authenticates against /verify.
      const oldVerify = await verifyPost(
        makeJsonReq('http://localhost/api/auth/verify', {
          userName,
          password,
        }) as never,
      );
      expect(oldVerify.status).toBe(401);

      // New password authenticates against /login.
      const newLogin = await loginPost(
        makeJsonReq('http://localhost/api/auth/login', {
          userName,
          password: newPw,
        }) as never,
      );
      expect(newLogin.status).toBe(200);

      // Restore for any later assertions / cleanup.
      const restore = await passwordPut(
        makeReq('/api/auth/password', {
          method: 'PUT',
          userName,
          authToken: newPw,
          body: { currentPassword: newPw, newPassword: password },
        }),
      );
      expect(restore.status).toBe(200);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('returns 200 and emits clearing cookies for both apikey and user', async () => {
      const res = await logoutPost(new NextRequest('http://localhost/api/auth/logout'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);

      const cookies = readSetCookies(res);
      const apiKey = cookies.find((c) => c.startsWith('plansync-apikey='));
      const userCookie = cookies.find((c) => c.startsWith('plansync-user='));
      expect(apiKey).toBeDefined();
      expect(userCookie).toBeDefined();
      expect(apiKey!).toMatch(/Max-Age=0/i);
      expect(userCookie!).toMatch(/Max-Age=0/i);
      expect(apiKey!.toLowerCase()).toContain('httponly');
    });
  });
});
