import crypto from 'crypto';
import { AppError, ErrorCode } from '@plansync/shared';

// ── Base64url helpers ─────────────────────────────────────────────────────────

function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlDecode(s: string): Buffer {
  const padded = s
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

// Pre-computed constant header for HS256
const HEADER = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

// ── Internal helpers ──────────────────────────────────────────────────────────

function getSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new AppError(ErrorCode.INTERNAL, 'JWT_SECRET is not configured');
  return s;
}

function signRaw(payload: Record<string, unknown>): string {
  const secret = getSecret();
  const payloadB64 = b64url(JSON.stringify(payload));
  const input = `${HEADER}.${payloadB64}`;
  const sig = b64url(crypto.createHmac('sha256', secret).update(input).digest());
  return `${input}.${sig}`;
}

function verifyAndDecode(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AppError(ErrorCode.UNAUTHORIZED, 'Invalid token format');
  const secret = getSecret();
  const [header, payloadB64, signature] = parts;
  const expected = b64url(
    crypto.createHmac('sha256', secret).update(`${header}.${payloadB64}`).digest(),
  );
  // timing-safe compare — both strings must be the same length
  const eBuf = Buffer.from(expected);
  const sBuf = Buffer.from(signature.padEnd(expected.length, '\0'));
  if (sBuf.length !== eBuf.length || !crypto.timingSafeEqual(sBuf, eBuf)) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 'Invalid token signature');
  }
  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    throw new AppError(ErrorCode.UNAUTHORIZED, 'Malformed token payload');
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof decoded.exp === 'number' && decoded.exp < now) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 'Token has expired');
  }
  return decoded;
}

// ── Public API ────────────────────────────────────────────────────────────────

const accessExpiry = () => parseInt(process.env.JWT_ACCESS_EXPIRY ?? '900', 10);
const refreshExpiry = () => parseInt(process.env.JWT_REFRESH_EXPIRY ?? '604800', 10);

export function signAccessToken(userName: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signRaw({ sub: userName, type: 'access', iat: now, exp: now + accessExpiry() });
}

export function signRefreshToken(userName: string, jti: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signRaw({ sub: userName, jti, type: 'refresh', iat: now, exp: now + refreshExpiry() });
}

/** Verify signature + expiry + type. Throws AppError(UNAUTHORIZED) on any failure. */
export function verifyToken(
  token: string,
  expectedType: 'access' | 'refresh',
): { userName: string; jti?: string } {
  const payload = verifyAndDecode(token);
  if (payload.type !== expectedType) {
    throw new AppError(
      ErrorCode.UNAUTHORIZED,
      `Expected ${expectedType} token, got ${payload.type}`,
    );
  }
  if (typeof payload.sub !== 'string') {
    throw new AppError(ErrorCode.UNAUTHORIZED, 'Token missing subject claim');
  }
  return { userName: payload.sub, jti: payload.jti as string | undefined };
}

/** Hash a JTI for DB storage (SHA-256, no salt — JTI is a random UUID). */
export function hashJti(jti: string): string {
  return crypto.createHash('sha256').update(jti).digest('hex');
}
