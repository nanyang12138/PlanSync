import crypto from 'crypto';

function getSecret(): string {
  return process.env.JWT_SECRET || process.env.PLANSYNC_SECRET || 'dev-secret';
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function signAccessToken(userName: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const iat = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({ sub: userName, iat, exp: iat + 900 }));
  const sig = base64url(
    crypto.createHmac('sha256', getSecret()).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${sig}`;
}

export function verifyAccessToken(token: string): { sub: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = base64url(
    crypto.createHmac('sha256', getSecret()).update(`${header}.${payload}`).digest(),
  );
  if (expected !== sig) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (Math.floor(Date.now() / 1000) > claims.exp) return null;
    return { sub: claims.sub };
  } catch {
    return null;
  }
}

export function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString('hex');
}
