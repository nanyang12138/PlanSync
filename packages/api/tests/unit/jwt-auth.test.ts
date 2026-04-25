import { describe, it, expect, vi } from 'vitest';
import { signAccessToken, verifyAccessToken, generateRefreshToken } from '@/lib/jwt';

describe('JWT utilities', () => {
  it('signAccessToken produces a 3-segment base64url JWT', () => {
    const token = signAccessToken('alice');
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    parts.forEach((p) => expect(p).toMatch(/^[A-Za-z0-9_-]+$/));
  });

  it('verifyAccessToken returns { sub } for a valid token', () => {
    const token = signAccessToken('alice');
    const result = verifyAccessToken(token);
    expect(result).not.toBeNull();
    expect(result?.sub).toBe('alice');
  });

  it('verifyAccessToken returns null for a tampered signature', () => {
    const token = signAccessToken('alice');
    const [h, p] = token.split('.');
    expect(verifyAccessToken(`${h}.${p}.badsig`)).toBeNull();
  });

  it('verifyAccessToken returns null for an expired token', () => {
    vi.useFakeTimers();
    const token = signAccessToken('alice');
    vi.advanceTimersByTime(16 * 60 * 1000); // 16 min > 900s expiry
    expect(verifyAccessToken(token)).toBeNull();
    vi.useRealTimers();
  });

  it('verifyAccessToken returns null for malformed input', () => {
    expect(verifyAccessToken('')).toBeNull();
    expect(verifyAccessToken('only.two')).toBeNull();
    expect(verifyAccessToken('a.b.c.d')).toBeNull();
  });

  it('generateRefreshToken returns a 64-char lowercase hex string', () => {
    const token = generateRefreshToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generateRefreshToken produces unique values', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).not.toBe(b);
  });
});
