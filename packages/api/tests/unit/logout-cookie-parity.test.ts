import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as logoutPost } from '../../src/app/api/auth/logout/route';

describe('POST /api/auth/logout — cookie clearing parity (#347)', () => {
  const ORIG_COOKIE_CROSS_SITE = process.env.PLANSYNC_COOKIE_CROSS_SITE;
  const ORIG_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    delete process.env.PLANSYNC_COOKIE_CROSS_SITE;
    Reflect.set(process.env, 'NODE_ENV', 'test');
  });

  afterEach(() => {
    if (ORIG_COOKIE_CROSS_SITE === undefined) delete process.env.PLANSYNC_COOKIE_CROSS_SITE;
    else process.env.PLANSYNC_COOKIE_CROSS_SITE = ORIG_COOKIE_CROSS_SITE;
    if (ORIG_NODE_ENV === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
    else Reflect.set(process.env, 'NODE_ENV', ORIG_NODE_ENV);
  });

  function readSetCookies(res: Response): string[] {
    // Headers.getSetCookie() preserves each Set-Cookie line individually;
    // .get('set-cookie') would join them with a comma which then collides
    // with `Expires=..., Sat, ...`. Use the dedicated API.
    const headers = res.headers as Headers & { getSetCookie?: () => string[] };
    if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
    const raw = headers.get('set-cookie') ?? '';
    return raw
      .split(/,(?=\s*[A-Za-z_][A-Za-z0-9_-]*=)/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  it('default mode (lax, non-secure) clears with matching attributes', async () => {
    const res = await logoutPost(new NextRequest('http://localhost/api/auth/logout'));
    const cookies = readSetCookies(res);
    const apiKey = cookies.find((c) => c.startsWith('plansync-apikey='));
    const user = cookies.find((c) => c.startsWith('plansync-user='));
    expect(apiKey).toBeDefined();
    expect(user).toBeDefined();
    // Empty-value clear with Max-Age=0
    expect(apiKey).toMatch(/Max-Age=0/i);
    expect(apiKey!.toLowerCase()).toContain('samesite=lax');
    expect(apiKey!.toLowerCase()).toContain('httponly');
    expect(user!.toLowerCase()).toContain('samesite=lax');
  });

  it('cross-site mode (PLANSYNC_COOKIE_CROSS_SITE=true) clears with SameSite=None; Secure', async () => {
    process.env.PLANSYNC_COOKIE_CROSS_SITE = 'true';
    const res = await logoutPost(new NextRequest('http://localhost/api/auth/logout'));
    const cookies = readSetCookies(res);
    const apiKey = cookies.find((c) => c.startsWith('plansync-apikey='));
    const user = cookies.find((c) => c.startsWith('plansync-user='));
    expect(apiKey).toBeDefined();
    expect(user).toBeDefined();
    expect(apiKey!.toLowerCase()).toContain('samesite=none');
    expect(apiKey!.toLowerCase()).toContain('secure');
    expect(user!.toLowerCase()).toContain('samesite=none');
    expect(user!.toLowerCase()).toContain('secure');
  });

  it('production mode (NODE_ENV=production) issues Secure even without cross-site flag', async () => {
    Reflect.set(process.env, 'NODE_ENV', 'production');
    const res = await logoutPost(new NextRequest('http://localhost/api/auth/logout'));
    const cookies = readSetCookies(res);
    const apiKey = cookies.find((c) => c.startsWith('plansync-apikey='));
    expect(apiKey!.toLowerCase()).toContain('secure');
    // Default sameSite=lax in production (cross-site only flips when explicit env is set).
    expect(apiKey!.toLowerCase()).toContain('samesite=lax');
  });
});
