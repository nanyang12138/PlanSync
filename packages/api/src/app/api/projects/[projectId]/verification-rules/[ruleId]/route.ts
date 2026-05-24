/**
 * R-181: per-rule mutations.
 *
 * Routes:
 *   PATCH  /api/projects/[projectId]/verification-rules/[ruleId]
 *   DELETE /api/projects/[projectId]/verification-rules/[ruleId]
 *
 * PATCH accepts a partial `{ enabled?, params?, scope?, scopeValue?, kind? }`
 * body. Most owner toggles are `{ enabled: false }` to quickly disable a
 * noisy rule without losing its history.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { VERIFICATION_RULE_KINDS } from '@/lib/verification-rules';

type Params = { params: { projectId: string; ruleId: string } };

const SCOPES = ['project', 'task_type', 'task'] as const;

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');

    const existing = await prisma.verificationRule.findUnique({
      where: { id: params.ruleId },
    });
    if (!existing || existing.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'VerificationRule not found');
    }

    const body = (await req.json()) as Record<string, unknown>;
    const data: {
      enabled?: boolean;
      kind?: string;
      scope?: string;
      scopeValue?: string | null;
      params?: Record<string, unknown>;
    } = {};

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'enabled must be boolean');
      }
      data.enabled = body.enabled;
    }
    if (body.kind !== undefined) {
      if (
        typeof body.kind !== 'string' ||
        !(VERIFICATION_RULE_KINDS as readonly string[]).includes(body.kind)
      ) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          `kind must be one of: ${VERIFICATION_RULE_KINDS.join(', ')}`,
        );
      }
      data.kind = body.kind;
    }
    if (body.scope !== undefined) {
      if (typeof body.scope !== 'string' || !(SCOPES as readonly string[]).includes(body.scope)) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          `scope must be one of: ${SCOPES.join(', ')}`,
        );
      }
      data.scope = body.scope;
    }
    if (body.scopeValue !== undefined) {
      data.scopeValue =
        body.scopeValue === null
          ? null
          : typeof body.scopeValue === 'string'
            ? body.scopeValue
            : null;
    }
    if (body.params !== undefined) {
      if (!body.params || typeof body.params !== 'object' || Array.isArray(body.params)) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'params must be an object');
      }
      data.params = body.params as Record<string, unknown>;
    }

    const updated = await prisma.verificationRule.update({
      where: { id: params.ruleId },
      data,
    });
    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');

    const existing = await prisma.verificationRule.findUnique({
      where: { id: params.ruleId },
    });
    if (!existing || existing.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'VerificationRule not found');
    }
    await prisma.verificationRule.delete({ where: { id: params.ruleId } });
    return NextResponse.json({ data: { id: params.ruleId, deleted: true } });
  } catch (error) {
    return handleApiError(error);
  }
}
