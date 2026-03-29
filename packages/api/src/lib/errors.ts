import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { AppError, ErrorCode, formatZodError } from '@plansync/shared';
import { logger } from './logger';

const PRISMA_ERROR_MAP: Record<string, { status: number; code: string; message: string }> = {
  P2002: {
    status: 409,
    code: ErrorCode.CONFLICT,
    message: 'A record with that unique value already exists',
  },
  P2025: { status: 404, code: ErrorCode.NOT_FOUND, message: 'Record not found' },
  P2003: {
    status: 400,
    code: ErrorCode.BAD_REQUEST,
    message: 'Related record not found (foreign key constraint)',
  },
};

export function handleApiError(error: unknown): NextResponse {
  if (error instanceof AppError || ((error as any)?.statusCode && (error as any)?.code)) {
    const appErr = error as AppError;
    return NextResponse.json(
      { error: { code: appErr.code, message: appErr.message, details: appErr.details } },
      { status: appErr.statusCode ?? 500 },
    );
  }

  if (error instanceof ZodError || (error as any)?.name === 'ZodError') {
    const formatted = formatZodError(error as ZodError);
    return NextResponse.json({ error: formatted }, { status: 400 });
  }

  const prismaCode = (error as any)?.code as string | undefined;
  if (prismaCode && PRISMA_ERROR_MAP[prismaCode]) {
    const mapped = PRISMA_ERROR_MAP[prismaCode];
    logger.warn({ code: prismaCode, meta: (error as any)?.meta }, 'Prisma error');
    return NextResponse.json(
      { error: { code: mapped.code, message: mapped.message } },
      { status: mapped.status },
    );
  }

  logger.error({ err: error }, 'Unhandled API error');
  return NextResponse.json(
    { error: { code: ErrorCode.INTERNAL, message: 'Internal server error' } },
    { status: 500 },
  );
}
