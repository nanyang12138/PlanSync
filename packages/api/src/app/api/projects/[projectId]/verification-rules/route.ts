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
 *     The rule rows hold no secrets — only `kind`, `scope`, `params`,
 *     `enabled`, `createdBy`, timestamps — and project members already
 *     observe `kind`/`message` via the gate response, so widening read
 *     access here strictly matches the existing disclosure surface.
 *   - POST stays owner-only and is also blocked for exec-scoped keys
 *     (`requireNotExecScoped`); same goes for PATCH/DELETE in [ruleId]/.
 *
 * The complete route reads the same table directly via prisma without an
 * extra auth check because it has already run `requireProjectRole` for
 * the project on the same request.
 */
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { VERIFICATION_RULE_KINDS } from '@/lib/verification-rules';

type Params = { params: Promise<{ projectId: string }> };

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
    await requireProjectRole(auth, params.projectId);

    const rules = await prisma.verificationRule.findMany({
      where: { projectId: params.projectId },
      orderBy: { createdAt: 'asc' },
    });
    return NextResponse.json({ data: rules });
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
