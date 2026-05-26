// SSR-side authorization helpers for App Router pages.
//
// Closes #1258: the deliverables SSR page (and any future project-scoped
// page that loads sensitive content like task titles / comments / drift
// alerts) must verify that the caller is a member of the project before
// rendering. API routes already do this through `authenticate(req)` +
// `requireProjectRole(...)`, but server components don't get a
// `NextRequest` — they get cookies. These helpers bridge the gap.
//
// The trusted identity comes from the `plansync-apikey` cookie, which is
// `httpOnly` (set by the login route) and therefore cannot be tampered
// with by a malicious client. The non-httpOnly `plansync-user` cookie is
// only consulted as a fallback for the `AUTH_DISABLED=true` test mode —
// production / staging always go through the API key path.
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { prisma } from './prisma';
import { verifyApiKey } from './auth';

/**
 * Resolve the authenticated user name for the current SSR request.
 *
 * - When `plansync-apikey` is set, verifies it via the same scrypt /
 *   cache path the API routes use and returns the row's `createdBy`.
 *   This is the only path that runs in production / staging because
 *   the middleware redirects unauthenticated users to /login.
 * - When AUTH_DISABLED=true (test mode) and no API key cookie exists,
 *   falls back to the `plansync-user` cookie or `PLANSYNC_USER` env var
 *   so vitest / Playwright runs without the login flow keep working.
 * - Otherwise returns `null`. Callers must treat that as "not signed
 *   in" and refuse to render.
 */
export async function resolveCurrentUserName(): Promise<string | null> {
  const cookieStore = await cookies();
  const rawKey = cookieStore.get('plansync-apikey')?.value;

  if (rawKey) {
    const verified = await verifyApiKey(rawKey);
    if (verified) return verified.userName;
    // Fall through: a stale / revoked key cookie should not unlock the
    // AUTH_DISABLED fallback below.
    return null;
  }

  if (process.env.AUTH_DISABLED === 'true') {
    const userCookie = cookieStore.get('plansync-user')?.value;
    if (userCookie) return userCookie;
    const envUser = process.env.PLANSYNC_USER || process.env.USER;
    return envUser || null;
  }

  return null;
}

/**
 * Authorise the current SSR request against `projectId`. Returns the
 * trusted user name and their `ProjectMember` role on success. Calls
 * Next.js `notFound()` when the caller is not signed in or is not a
 * member — using 404 (rather than 403) deliberately so a non-member
 * cannot use the page's response to confirm a project's existence.
 *
 * The signature mirrors `requireProjectRole` from `lib/auth.ts` so
 * server-component pages and API routes share the same mental model:
 * "look up the membership row; if it isn't there, refuse to render".
 */
export async function requireProjectMembershipOrNotFound(projectId: string): Promise<{
  userName: string;
  role: 'owner' | 'developer';
}> {
  const userName = await resolveCurrentUserName();
  if (!userName) notFound();

  const member = await prisma.projectMember.findUnique({
    where: { projectId_name: { projectId, name: userName } },
    select: { role: true },
  });

  if (!member) notFound();

  return {
    userName,
    role: member.role as 'owner' | 'developer',
  };
}
