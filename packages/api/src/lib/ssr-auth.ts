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
 * Trusted identity surfaced to SSR pages. `keyProjectId` / `execRunId`
 * mirror the same fields on `AuthContext` so SSR scope checks stay
 * structurally identical to `requireProjectRole`:
 *  - `keyProjectId` is set only when the principal came from a verified
 *    `plansync-apikey` cookie whose ApiKey row carries a `projectId`
 *    (project-scoped or exec-scoped keys).
 *  - `execRunId` is set only when the verified key was minted for a
 *    specific execution run.
 *  - Both fields are `null` for the AUTH_DISABLED `plansync-user` /
 *    `PLANSYNC_USER` fallback, which by definition has no key scope.
 */
interface SsrPrincipal {
  userName: string;
  keyProjectId: string | null;
  execRunId: string | null;
}

/**
 * Resolve the authenticated principal for the current SSR request,
 * including any API-key scope (project / exec) it carries.
 *
 * - When `plansync-apikey` is set, verifies it via the same scrypt /
 *   cache path the API routes use and returns the row's `createdBy`
 *   plus the key's `projectId` / `execRunId` scope. This is the only
 *   path that runs in production / staging because the middleware
 *   redirects unauthenticated users to /login.
 * - When AUTH_DISABLED=true (test mode) and no API key cookie exists,
 *   falls back to the `plansync-user` cookie or `PLANSYNC_USER` env var
 *   so vitest / Playwright runs without the login flow keep working.
 *   The fallback path never carries key scope.
 * - Otherwise returns `null`. Callers must treat that as "not signed
 *   in" and refuse to render.
 */
async function resolveCurrentPrincipal(): Promise<SsrPrincipal | null> {
  const cookieStore = await cookies();
  const rawKey = cookieStore.get('plansync-apikey')?.value;

  if (rawKey) {
    const verified = await verifyApiKey(rawKey);
    if (verified) {
      return {
        userName: verified.userName,
        keyProjectId: verified.projectId,
        execRunId: verified.execRunId,
      };
    }
    // Fall through: a stale / revoked key cookie should not unlock the
    // AUTH_DISABLED fallback below.
    return null;
  }

  if (process.env.AUTH_DISABLED === 'true') {
    const userCookie = cookieStore.get('plansync-user')?.value;
    if (userCookie) {
      return { userName: userCookie, keyProjectId: null, execRunId: null };
    }
    const envUser = process.env.PLANSYNC_USER || process.env.USER;
    if (envUser) {
      return { userName: envUser, keyProjectId: null, execRunId: null };
    }
    return null;
  }

  return null;
}

/**
 * Resolve only the authenticated user name. Thin wrapper over
 * `resolveCurrentPrincipal` kept for callers that don't care about
 * key scope (e.g. rendering a user badge).
 */
export async function resolveCurrentUserName(): Promise<string | null> {
  const principal = await resolveCurrentPrincipal();
  return principal?.userName ?? null;
}

/**
 * Authorise the current SSR request against `projectId`. Returns the
 * trusted user name and their `ProjectMember` role on success. Calls
 * Next.js `notFound()` when the caller is not signed in, is not a
 * member, or is presenting an API key whose scope does not match
 * `projectId` — using 404 (rather than 403) deliberately so a
 * non-member / wrong-scope caller cannot use the page's response to
 * confirm a project's existence.
 *
 * The signature mirrors `requireProjectRole` from `lib/auth.ts` so
 * server-component pages and API routes share the same mental model:
 * "look up the membership row; if it isn't there, refuse to render".
 *
 * Closes #1287: the previous implementation only validated membership
 * by `(projectId, userName)` and silently ignored the API key's own
 * `projectId` / `execRunId` scope. A project-scoped or exec-scoped key
 * issued for project A could then be planted as the `plansync-apikey`
 * cookie to render sibling project B's deliverables / task titles /
 * comments whenever the same user happened to be a member of both —
 * a cross-project scope bypass. Both guards from `requireProjectRole`
 * are now mirrored here verbatim:
 *   1. `keyProjectId` set AND ≠ requested projectId → refuse.
 *   2. `execRunId` set AND no `keyProjectId` (dirty data) → refuse.
 */
export async function requireProjectMembershipOrNotFound(projectId: string): Promise<{
  userName: string;
  role: 'owner' | 'developer';
}> {
  const principal = await resolveCurrentPrincipal();
  if (!principal) notFound();

  // R-137 (mirrored): API-key scope must match the page's project. We
  // call `notFound()` rather than throwing 403 to preserve the same
  // existence-hiding contract the membership check below uses — a
  // scoped key bound to project A must not be able to confirm whether
  // project B exists either.
  if (principal.keyProjectId && principal.keyProjectId !== projectId) {
    notFound();
  }
  if (principal.execRunId && !principal.keyProjectId) {
    notFound();
  }

  const member = await prisma.projectMember.findUnique({
    where: { projectId_name: { projectId, name: principal.userName } },
    select: { role: true },
  });

  if (!member) notFound();

  return {
    userName: principal.userName,
    role: member.role as 'owner' | 'developer',
  };
}
