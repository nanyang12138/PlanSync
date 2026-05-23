/**
 * Exec-state token sign / verify — MCP-server mirror of
 * `packages/api/src/lib/exec-state-token.ts`.
 *
 * MUST stay byte-compatible with the API copy. The parity contract is
 * exercised in `tests/exec-state-token-parity.test.ts`, which sources both
 * implementations into the same suite and round-trips tokens between them.
 *
 * Why a mirror instead of import:
 *   - `@plansync/mcp-server` does not depend on `@plansync/api` (and must
 *     not, to keep the MCP subprocess self-contained — see
 *     `packages/mcp-server/package.json`).
 *   - `@plansync/shared` is `node:crypto`-free by convention (see
 *     `packages/shared/src/drift/structural-diff.ts`: "we use FNV-1a ...
 *     no Node crypto"). Putting HMAC helpers there would block browser
 *     consumption of the shared package and is an explicit non-goal.
 *
 * The functions are deliberately tiny (~20 LOC each) and import nothing
 * runtime-specific beyond `node:crypto` + the shared payload schema, so
 * keeping two copies is cheaper than the architectural cost of adding a
 * new shared sub-package.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  EXEC_STATE_TOKEN_MAX_AGE_MS,
  execStateTokenPayloadSchema,
  type ExecStateTokenPayload,
} from '@plansync/shared';

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str: string): Buffer {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

export type ExecStateTokenError = 'MALFORMED' | 'BAD_SIGNATURE' | 'BAD_PAYLOAD' | 'EXPIRED';

export type VerifyResult =
  | { ok: true; payload: ExecStateTokenPayload }
  | { ok: false; reason: ExecStateTokenError; message: string };

export function signExecStateToken(payload: ExecStateTokenPayload, secret: string): string {
  if (!secret || secret.length === 0) {
    throw new Error('signExecStateToken: secret must be a non-empty string');
  }
  const safe = execStateTokenPayloadSchema.parse(payload);
  const payloadJson = JSON.stringify(safe);
  const payloadB64 = base64urlEncode(Buffer.from(payloadJson, 'utf8'));
  const sig = createHmac('sha256', secret).update(payloadB64).digest();
  return `${payloadB64}.${base64urlEncode(sig)}`;
}

export function verifyExecStateToken(
  token: string,
  secret: string,
  nowMs: number = Date.now(),
): VerifyResult {
  if (!secret) {
    return { ok: false, reason: 'BAD_SIGNATURE', message: 'verifyExecStateToken: missing secret' };
  }
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'MALFORMED', message: 'Token must be a non-empty string' };
  }
  const parts = token.split('.');
  if (parts.length !== 2) {
    return {
      ok: false,
      reason: 'MALFORMED',
      message: `Expected 2 segments separated by '.', got ${parts.length}`,
    };
  }
  const [payloadB64, sigB64] = parts;
  const expectedSig = createHmac('sha256', secret).update(payloadB64).digest();
  let providedSig: Buffer;
  try {
    providedSig = base64urlDecode(sigB64);
  } catch {
    return { ok: false, reason: 'MALFORMED', message: 'Signature segment is not valid base64url' };
  }
  if (providedSig.length !== expectedSig.length) {
    return { ok: false, reason: 'BAD_SIGNATURE', message: 'Signature length mismatch' };
  }
  if (!timingSafeEqual(providedSig, expectedSig)) {
    return { ok: false, reason: 'BAD_SIGNATURE', message: 'Signature did not verify' };
  }
  let payloadJson: string;
  try {
    payloadJson = base64urlDecode(payloadB64).toString('utf8');
  } catch {
    return { ok: false, reason: 'MALFORMED', message: 'Payload segment is not valid base64url' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return { ok: false, reason: 'MALFORMED', message: 'Payload segment is not valid JSON' };
  }
  const safe = execStateTokenPayloadSchema.safeParse(parsed);
  if (!safe.success) {
    return {
      ok: false,
      reason: 'BAD_PAYLOAD',
      message: `Payload failed schema validation: ${safe.error.message}`,
    };
  }
  const age = nowMs - safe.data.issuedAt;
  if (age < 0) {
    return {
      ok: false,
      reason: 'BAD_PAYLOAD',
      message: `Token issuedAt is in the future (skew=${-age}ms)`,
    };
  }
  if (age > EXEC_STATE_TOKEN_MAX_AGE_MS) {
    return {
      ok: false,
      reason: 'EXPIRED',
      message: `Token is older than ${EXEC_STATE_TOKEN_MAX_AGE_MS}ms (age=${age}ms)`,
    };
  }
  return { ok: true, payload: safe.data };
}
