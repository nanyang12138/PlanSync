/**
 * R-181: declarative verification rules — list endpoint + owner-only create.
 *
 * Routes:
 *   GET   /api/projects/[projectId]/verification-rules
 *   POST  /api/projects/[projectId]/verification-rules
 *
 * Auth:
 *   - GET  is open to **any project member** (owner / developer, human /
 *     agent). The complete route's R-181 422 envelope returns
 *     `error.details.failedRules: [{ ruleId, kind, message }]` to whoever
 *     called complete — including non-owner agents — so the CLI's
 *     `/explain rule <id>` (R-184) MUST be callable by the same audience.
 *     Forcing owner-only here breaks #1220: non-owners get 403 and cannot
 *     self-serve the rule explanation that the gate error points them at.
 *
 *     Response shape is role-aware AND session-aware (#1411 + #1452):
 *       - Full-trust readers receive the full row, including `params`
 *         JSONB and `createdBy`. "Full trust" means the caller is an
 *         owner-role member AND is NOT using an exec-scoped API key.
 *       - Everyone else (non-owner members, AND owner-role members
 *         calling through an exec-scoped key issued for a single
 *         /exec or /worker run) receives the public projection
 *         `{ id, projectId, kind, scope, scopeValue, enabled,
 *         createdAt, updatedAt }`. We strip `params` and `createdBy`
 *         because `params` is owner-writable JSONB and may hold
 *         internal configuration (file paths, prompt fragments,
 *         arbitrary keys) that the broader execution audience never
 *         needs — the gate's `failedRules[].message` already surfaces
 *         the human-readable consequence (e.g. "required 100 chars").
 *
 *     The exec-scope guard (#1452) closes a hole noted on PR #1447:
 *     `projectRole === 'owner'` alone would let an owner-issued
 *     exec-scoped token (the kind /exec / /worker hand to a Genie
 *     sub-agent) keep reading owner-only `params`. The /exec session
 *     should never have wider read access than a non-owner agent.
 *   - POST stays owner-only and is also blocked for exec-scoped keys
 *     (`requireNotExecScoped`); same goes for PATCH/DELETE in [ruleId]/.
 *
 * The complete route reads the same table directly via prisma without an
 * extra auth check because it has already run `requireProjectRole` for
 * the project on the same request.
 */
import { NextRequest, NextResponse } from 'next/server';
import { Prisma, type VerificationRule } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { VERIFICATION_RULE_KINDS } from '@/lib/verification-rules';

type Params = { params: Promise<{ projectId: string }> };

/**
 * Public projection of a VerificationRule shown to non-owner project
 * members AND to owners who are calling through an exec-scoped API key.
 * See file header (#1411 + #1452) — owner-writable JSONB `params` and
 * `createdBy` are deliberately omitted from this surface.
 */
function publicRuleProjection(rule: VerificationRule) {
  return {
    id: rule.id,
    projectId: rule.projectId,
    kind: rule.kind,
    scope: rule.scope,
    scopeValue: rule.scopeValue,
    enabled: rule.enabled,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

const SCOPES = ['project', 'task_type', 'task'] as const;

function validatePayload(body: unknown): {
  kind: string;
  scope: string;
  scopeValue: string | null;
  params: Record<string, unknown>;
  enabled: boolean;
} {
  if (!body || typeof body !== 'object') {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'body must be an object');
  }
  const b = body as Record<string, unknown>;
  const kind = typeof b.kind === 'string' ? b.kind : '';
  if (!(VERIFICATION_RULE_KINDS as readonly string[]).includes(kind)) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `kind must be one of: ${VERIFICATION_RULE_KINDS.join(', ')}`,
    );
  }
  const scope = typeof b.scope === 'string' ? b.scope : 'project';
  if (!(SCOPES as readonly string[]).includes(scope)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `scope must be one of: ${SCOPES.join(', ')}`);
  }
  const scopeValue =
    scope === 'project'
      ? null
      : typeof b.scopeValue === 'string' && b.scopeValue.length > 0
        ? b.scopeValue
        : null;
  if (scope !== 'project' && scopeValue === null) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `scopeValue is required when scope=${scope}`);
  }
  const params =
    b.params && typeof b.params === 'object' && !Array.isArray(b.params)
      ? (b.params as Record<string, unknown>)
      : {};
  const enabled = typeof b.enabled === 'boolean' ? b.enabled : true;
  return { kind, scope, scopeValue, params, enabled };
}

export async function GET(req: NextRequest, ctx: Params) {
  const params = await ctx.params;
  try {
    const auth = await authenticate(req);
    // #1220: any project member can read the rule list so the CLI
    // `/explain rule <id>` (R-184) works for non-owner agents/developers
    // who hit a gate=rule 422 on complete. Mutations stay owner-only.
    const scopedAuth = await requireProjectRole(auth, params.projectId);

    const rules = await prisma.verificationRule.findMany({
      where: { projectId: params.projectId },
      orderBy: { createdAt: 'asc' },
    });
    // #1411 + #1452: only owner-role members on a non-exec-scoped session
    // see the full row (params + createdBy). Owner-issued exec-scoped
    // tokens — handed to /exec / /worker sub-agents — fall through to
    // the public projection so a compromised Genie or any code path
    // reusing the exec key cannot read owner-only `params`.
    const isFullTrust = scopedAuth.projectRole === 'owner' && !scopedAuth.execRunId;
    const data = isFullTrust ? rules : rules.map(publicRuleProjection);
    return NextResponse.json({ data });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: NextRequest, ctx: Params) {
  const params = await ctx.params;
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');

    const body = await req.json();
    const payload = validatePayload(body);

    const created = await prisma.verificationRule.create({
      data: {
        projectId: params.projectId,
        kind: payload.kind,
        scope: payload.scope,
        scopeValue: payload.scopeValue,
        params: payload.params as Prisma.InputJsonValue,
        enabled: payload.enabled,
        createdBy: auth.userName,
      },
    });
    return NextResponse.json({ data: created }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
