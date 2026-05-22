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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  return typeof v === 'string' ? v : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  return typeof v === 'number' ? v : undefined;
}

export function handleApiError(error: unknown): NextResponse {
  const errStatusCode = readNumber(error, 'statusCode');
  const errCode = readString(error, 'code');
  if (error instanceof AppError || (errStatusCode !== undefined && errCode !== undefined)) {
    const appErr = error as AppError;
    return NextResponse.json(
      { error: { code: appErr.code, message: appErr.message, details: appErr.details } },
      { status: appErr.statusCode ?? 500 },
    );
  }

  if (error instanceof ZodError || readString(error, 'name') === 'ZodError') {
    const formatted = formatZodError(error as ZodError);
    return NextResponse.json({ error: formatted }, { status: 400 });
  }

  const prismaCode = readString(error, 'code');
  if (prismaCode && PRISMA_ERROR_MAP[prismaCode]) {
    const mapped = PRISMA_ERROR_MAP[prismaCode];
    const meta = isRecord(error) ? error.meta : undefined;
    logger.warn({ code: prismaCode, meta }, 'Prisma error');
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
