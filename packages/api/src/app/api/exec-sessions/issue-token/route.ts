import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { AppError, ErrorCode } from '@plansync/shared';

const issueTokenSchema = z.object({
  runId: z.string().min(1),
  taskId: z.string().min(1),
  projectId: z.string().min(1),
  ttlSeconds: z
    .number()
    .int()
    .positive()
    .max(86_400 * 7)
    .optional(),
});

export async function POST(req: NextRequest) {
  try {
    const auth = await authenticate(req);
    const body = await validateBody(req, issueTokenSchema);

    // Refuse to issue a scoped token from inside an already-scoped session,
    // so a compromised Genie cannot mint fresh tokens for itself.
    if (auth.execRunId) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'Cannot issue an exec-scoped token from within an exec-scoped session',
      );
    }

    const member = await requireProjectRole(auth, body.projectId);

    const run = await prisma.executionRun.findUnique({
      where: { id: body.runId },
      select: {
        id: true,
        taskId: true,
        executorName: true,
        status: true,
        task: { select: { projectId: true } },
      },
    });
    if (!run || run.taskId !== body.taskId || run.task.projectId !== body.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Execution run not found in this project');
    }
    if (run.status !== 'running') {
      throw new AppError(
        ErrorCode.STATE_CONFLICT,
        `Execution run is "${run.status}" — only running runs can be scoped`,
      );
    }

    // Either project owner OR the run's own executor may issue a scoped token.
    if (member.projectRole !== 'owner' && run.executorName !== auth.userName) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'Only project owners or the run executor can issue a scoped token for this run',
      );
    }

    const rawKey = `ps_key_exec_${crypto.randomBytes(24).toString('hex')}`;
    const keyPrefix = rawKey.slice(0, 15);

    const salt = crypto.randomBytes(16);
    const keyHash = await new Promise<string>((resolve, reject) => {
      crypto.scrypt(rawKey, salt, 64, (err, derivedKey) => {
        if (err) reject(err);
        else resolve(salt.toString('hex') + ':' + derivedKey.toString('hex'));
      });
    });

    const ttlMs = (body.ttlSeconds ?? 24 * 3600) * 1000;
    const expiresAt = new Date(Date.now() + ttlMs);

    const apiKey = await prisma.apiKey.create({
      data: {
        projectId: body.projectId,
        name: `exec:${body.runId}`,
        keyHash,
        keyPrefix,
        permissions: ['read', 'write'],
        createdBy: auth.userName,
        execRunId: body.runId,
        expiresAt,
      },
    });

    return NextResponse.json(
      {
        data: {
          id: apiKey.id,
          key: rawKey,
          execRunId: body.runId,
          expiresAt,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
