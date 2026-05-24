/**
 * R-181: owner CRUD endpoints for declarative verification rules.
 *
 * Routes:
 *   GET   /api/projects/[projectId]/verification-rules
 *   POST  /api/projects/[projectId]/verification-rules
 *
 * Auth: owner-only (mutations also blocked for exec-scoped keys). The
 * complete route reads the same table without an auth check because it
 * runs after `requireProjectRole` for the project already.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { VERIFICATION_RULE_KINDS } from '@/lib/verification-rules';

type Params = { params: { projectId: string } };

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
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `scope must be one of: ${SCOPES.join(', ')}`,
    );
  }
  const scopeValue =
    scope === 'project'
      ? null
      : typeof b.scopeValue === 'string' && b.scopeValue.length > 0
        ? b.scopeValue
        : null;
  if (scope !== 'project' && scopeValue === null) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `scopeValue is required when scope=${scope}`,
    );
  }
  const params =
    b.params && typeof b.params === 'object' && !Array.isArray(b.params)
      ? (b.params as Record<string, unknown>)
      : {};
  const enabled = typeof b.enabled === 'boolean' ? b.enabled : true;
  return { kind, scope, scopeValue, params, enabled };
}

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId, 'owner');

    const rules = await prisma.verificationRule.findMany({
      where: { projectId: params.projectId },
      orderBy: { createdAt: 'asc' },
    });
    return NextResponse.json({ data: rules });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: NextRequest, { params }: Params) {
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
        params: payload.params,
        enabled: payload.enabled,
        createdBy: auth.userName,
      },
    });
    return NextResponse.json({ data: created }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
