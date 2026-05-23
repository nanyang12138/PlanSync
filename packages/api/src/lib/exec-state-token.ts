/**
 * Exec-state token sign / verify (R-171).
 *
 * Canonical home for the HMAC crypto that backs `stateToken` in the
 * `@plansync/shared` `exec-state` FSM (see R-170 + `docs/PROTOCOL.md`).
 *
 * Wire format:
 *
 *     stateToken = base64url(JSON(payload)) + "." +
 *                  base64url(HMAC_SHA256(secret, JSON(payload)))
 *
 * The payload contract is `execStateTokenPayloadSchema` in
 * `@plansync/shared/protocol/exec-state` — single source of truth. Both
 * `signExecStateToken` and `verifyExecStateToken` re-validate against that
 * schema so a corrupted / forged / version-mismatched payload is always
 * rejected.
 *
 * `verifyExecStateToken` returns a tagged union (`ok | reason`) instead of
 * throwing so callers can render structured `OUT_OF_SEQUENCE` envelopes
 * without a try/catch dance.
 *
 * Why this lives in `packages/api/src/lib/` and not in `@plansync/shared`:
 *   - `@plansync/shared` is a zero-runtime-dep package (only zod). Pulling
 *     in `node:crypto` would block browser consumption of the package and
 *     break the convention codified in `structural-diff.ts` ("we use FNV-1a
 *     ... no Node crypto").
 *   - The MCP server runs in its own subprocess and cannot import from the
 *     api package. It carries a mirror copy at
 *     `packages/mcp-server/src/exec-state-token.ts`; a contract test
 *     (`mcp-token-parity.test.ts`) round-trips both implementations against
 *     each other to keep them in lockstep.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  EXEC_STATE_TOKEN_MAX_AGE_MS,
  execStateTokenPayloadSchema,
  type ExecStateTokenPayload,
} from '@plansync/shared';

/** Encode a Buffer as RFC 4648 §5 base64url (no padding). */
function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode an RFC 4648 §5 base64url string back to a Buffer. */
function base64urlDecode(str: string): Buffer {
  // Restore standard base64 alphabet + padding before delegating to Buffer.
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

/**
 * Sign a payload into the canonical `payloadB64.sigB64` wire form.
 *
 * The payload is validated against `execStateTokenPayloadSchema` before
 * signing — passing a malformed object throws (programmer error, not a
 * runtime user error).
 */
export function signExecStateToken(payload: ExecStateTokenPayload, secret: string): string {
  if (!secret || secret.length === 0) {
    throw new Error('signExecStateToken: secret must be a non-empty string');
  }
  // Re-parse so we always sign the canonicalised shape. If someone passes
  // extra fields, zod's default `.strict()` would reject them; the payload
  // schema is `.object({...})` (non-strict) so this is a safety net more
  // than a guard, but it keeps the signed bytes deterministic.
  const safe = execStateTokenPayloadSchema.parse(payload);
  const payloadJson = JSON.stringify(safe);
  const payloadB64 = base64urlEncode(Buffer.from(payloadJson, 'utf8'));
  const sig = createHmac('sha256', secret).update(payloadB64).digest();
  return `${payloadB64}.${base64urlEncode(sig)}`;
}

/**
 * Reasons a token can be rejected. Callers map these to the
 * `OUT_OF_SEQUENCE` envelope in the MCP tool wrapper (R-171) or to a
 * 401-equivalent in API routes (R-191+).
 */
export type ExecStateTokenError =
  | 'MALFORMED' // wrong number of segments / non-base64 / non-JSON
  | 'BAD_SIGNATURE' // HMAC didn't verify
  | 'BAD_PAYLOAD' // JSON parsed but failed schema (wrong v, missing runId, ...)
  | 'EXPIRED'; // issuedAt + maxAge < now

export type VerifyResult =
  | { ok: true; payload: ExecStateTokenPayload }
  | { ok: false; reason: ExecStateTokenError; message: string };

/**
 * Verify a token string against the secret + the canonical payload schema.
 *
 * Returns a tagged result instead of throwing so callers can render the
 * matching wire error without a try/catch. The function performs:
 *
 *   1. structural split (`payloadB64.sigB64`)
 *   2. constant-time HMAC verify
 *   3. JSON parse of the payload segment
 *   4. zod schema parse (rejects payload shape / version drift)
 *   5. freshness check against `EXEC_STATE_TOKEN_MAX_AGE_MS`
 *
 * Use `nowMs` to inject the clock from tests; defaults to `Date.now()`.
 */
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
    // Clock skew or forged future-dated token. Reject defensively — a
    // legitimate token can always be re-issued on the next call.
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
