import { NextRequest } from 'next/server';
import { ZodSchema } from 'zod';
import { AppError, ErrorCode } from '@plansync/shared';

export async function validateBody<T>(req: NextRequest, schema: ZodSchema<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new AppError(ErrorCode.BAD_REQUEST, 'Request body must be valid JSON');
  }
  return schema.parse(body);
}

export function validateSearchParams<T>(req: NextRequest, schema: ZodSchema<T>): T {
  const params = Object.fromEntries(req.nextUrl.searchParams.entries());
  return schema.parse(params);
}
