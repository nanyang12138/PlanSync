import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { AppError, ErrorCode, formatZodError } from '@plansync/shared';
import { logger } from './logger';

export function handleApiError(error: unknown): NextResponse {
  if (error instanceof AppError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, details: error.details } },
      { status: error.statusCode },
    );
  }

  if (error instanceof ZodError) {
    const formatted = formatZodError(error);
    return NextResponse.json({ error: formatted }, { status: 400 });
  }

  logger.error({ err: error }, 'Unhandled API error');
  return NextResponse.json(
    { error: { code: ErrorCode.INTERNAL, message: 'Internal server error' } },
    { status: 500 },
  );
}
