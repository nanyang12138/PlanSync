import { describe, it, expect } from 'vitest';
import { handleApiError } from '../../src/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { ZodError } from 'zod';

// R-133: handleApiError previously used `(error as any)?.code` style narrowing.
// After removing `any` it must continue to:
//   - Recognise AppError instances (and plain-object lookalikes with statusCode+code)
//   - Recognise ZodError instances
//   - Recognise Prisma errors by mapping their numeric P-code to a friendly status
//   - Fall through to 500 for opaque values (string, null, plain Error)
describe('handleApiError — unknown narrowing (R-133)', () => {
  it('maps an AppError to its declared status + code', async () => {
    const res = handleApiError(new AppError(ErrorCode.NOT_FOUND, 'missing', 404));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe(ErrorCode.NOT_FOUND);
    expect(body.error.message).toBe('missing');
  });

  it('maps a plain-object AppError-lookalike (has statusCode+code) to its declared status', async () => {
    const lookalike = { statusCode: 418, code: 'TEAPOT', message: 'I am a teapot' };
    const res = handleApiError(lookalike);
    expect(res.status).toBe(418);
    const body = await res.json();
    expect(body.error.code).toBe('TEAPOT');
  });

  it('maps a ZodError to 400 with formatted details', async () => {
    let zerr: ZodError | null = null;
    try {
      const { z } = await import('zod');
      z.object({ id: z.string() }).parse({});
    } catch (e) {
      zerr = e as ZodError;
    }
    expect(zerr).not.toBeNull();
    const res = handleApiError(zerr);
    expect(res.status).toBe(400);
  });

  it('maps a Prisma P2025 (Record not found) to 404', async () => {
    const res = handleApiError({ code: 'P2025', meta: { cause: 'no row' } });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('maps a Prisma P2002 (unique constraint) to 409', async () => {
    const res = handleApiError({ code: 'P2002', meta: { target: ['email'] } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe(ErrorCode.CONFLICT);
  });

  it('falls through to 500 INTERNAL for null / string / vanilla Error', async () => {
    for (const value of [null, 'kaboom', new Error('boom'), 42, undefined]) {
      const res = handleApiError(value);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe(ErrorCode.INTERNAL);
    }
  });
});
