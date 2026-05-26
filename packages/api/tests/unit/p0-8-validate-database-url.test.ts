/**
 * P0-8 / R1b — DATABASE_URL validation contract.
 *
 * The functions live inside scripts/run-worker.ts; we mirror them
 * here for unit testing because run-worker.ts is a script (its
 * top-level statements run on import) and refactoring it to export
 * the helpers has wider blast radius than this regression deserves.
 *
 * The static-source check at the bottom asserts the canonical
 * source still defines the right helpers, so a future refactor
 * that drops them will fail this test.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// --- Mirror of the validator in scripts/run-worker.ts ---
const PG_URL_RE = /^postgres(?:ql)?:\/\/([^/?#]*)/;

function redactDbUrl(raw: string): string {
  // Closes #1046 — refuse to echo any colon-separated leading
  // token unless the raw input actually contained `://`. WHATWG
  // `new URL('alice:s3cret@db/x')` parses successfully with
  // `protocol='alice:'` (a non-special scheme), and the pre-fix
  // success branch leaked that token. Same trap was in the catch
  // fallback's `${raw.slice(0,colon)}`.
  if (!raw.includes('://')) {
    return '[unparseable]';
  }
  try {
    const u = new URL(raw);
    const port = u.port ? `:${u.port}` : '';
    return `${u.protocol}//***@${u.hostname || '?'}${port}/…`;
  } catch {
    const sep = raw.indexOf('://');
    return `${raw.slice(0, sep)}://[unparseable]`;
  }
}

function validateDatabaseUrl(raw: string | undefined): string | null {
  if (!raw) return 'DATABASE_URL is not set';
  const trimmed = raw.trim();
  if (!trimmed) return 'DATABASE_URL is empty / whitespace-only';
  if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(trimmed)) {
    return `DATABASE_URL contains unresolved \${VAR} template; redacted=${redactDbUrl(trimmed)}`;
  }
  if (!trimmed.startsWith('postgresql://') && !trimmed.startsWith('postgres://')) {
    return `DATABASE_URL must start with 'postgresql://' (redacted=${redactDbUrl(trimmed)})`;
  }
  const hostMatch = trimmed.match(PG_URL_RE);
  if (!hostMatch || !hostMatch[1] || hostMatch[1].split('@').pop() === '') {
    return `DATABASE_URL has empty host (redacted=${redactDbUrl(trimmed)})`;
  }
  try {
    const u = new URL(trimmed);
    if (!u.hostname) {
      return `DATABASE_URL has empty hostname (redacted=${redactDbUrl(trimmed)})`;
    }
  } catch {
    return `DATABASE_URL is not a parsable URL (redacted=${redactDbUrl(trimmed)})`;
  }
  return null;
}

describe('P0-8 / R1b validateDatabaseUrl', () => {
  it('rejects undefined / empty / whitespace-only', () => {
    expect(validateDatabaseUrl(undefined)).toMatch(/not set/);
    expect(validateDatabaseUrl('')).toMatch(/not set/);
    expect(validateDatabaseUrl('   ')).toMatch(/empty/);
  });

  it('rejects unresolved ${VAR} template (curly form)', () => {
    const r = validateDatabaseUrl('postgresql://${USER}@localhost/x');
    expect(r).toMatch(/unresolved/);
    // Must not include the raw value in the log message.
    expect(r).not.toContain('${USER}@localhost');
  });

  it('does NOT reject literal $ chars in passwords (closes #935 #942 #952)', () => {
    expect(
      validateDatabaseUrl('postgresql://user:pa$$word123@db.internal:5432/plansync'),
    ).toBeNull();
    expect(validateDatabaseUrl('postgres://user:has$pecial@db.internal/plansync')).toBeNull();
  });

  it('rejects non-postgres schemes without leaking credentials', () => {
    const r = validateDatabaseUrl('mysql://user:pass@host/db');
    expect(r).toMatch(/postgresql/);
    expect(r).not.toContain('user:pass');
    expect(r).not.toContain('s3cret');
  });

  it('rejects postgres URL with no host (closes #1004)', () => {
    expect(validateDatabaseUrl('postgresql://')).toMatch(/empty host|empty hostname/);
    expect(validateDatabaseUrl('postgresql:///plansync_dev')).toMatch(/empty host|empty hostname/);
  });

  it('accepts well-formed postgres + postgresql URLs', () => {
    expect(validateDatabaseUrl('postgresql://user:pass@db.internal:5432/plansync')).toBeNull();
    expect(validateDatabaseUrl('postgres://localhost/plansync_dev')).toBeNull();
  });
});

describe('P0-8 / R1b redactDbUrl', () => {
  it('masks credentials in postgres URL', () => {
    const out = redactDbUrl('postgresql://alice:s3cret@db.internal:5432/plansync');
    expect(out).not.toContain('alice');
    expect(out).not.toContain('s3cret');
    expect(out).toContain('db.internal');
  });

  it('masks credentials in non-postgres URL too (closes #1003 #990)', () => {
    const out = redactDbUrl('mysql://alice:s3cret@db.internal/plansync');
    // Pre-fix the redactor returned the first 16 chars verbatim:
    // "mysql://alice:s3" — leaking 's3' from the password.
    expect(out).not.toContain('alice');
    expect(out).not.toContain('s3cret');
    expect(out).not.toContain('s3');
  });

  it('handles unparseable inputs without echoing them', () => {
    const out = redactDbUrl('not://a$valid:url@@@@');
    expect(out).not.toContain('valid:url');
    expect(out.length).toBeLessThan(40);
  });

  it('does NOT leak the leading token on inputs without :// (closes #1046)', () => {
    // Pre-fix: `new URL('alice:s3cret@db/x')` succeeded with
    // protocol='alice:' and the redactor emitted 'alice://***@?/…',
    // leaking the username 'alice'. Same trap for any inadvertent
    // `user:pass@host` paste.
    const out1 = redactDbUrl('alice:s3cret@db/x');
    expect(out1).not.toContain('alice');
    expect(out1).not.toContain('s3cret');
    expect(out1).toBe('[unparseable]');

    const out2 = redactDbUrl('user:pass@host');
    expect(out2).not.toContain('user');
    expect(out2).not.toContain('pass');
    expect(out2).toBe('[unparseable]');

    // Plain garbage stays unparseable too.
    expect(redactDbUrl('not-a-url')).toBe('[unparseable]');
    expect(redactDbUrl('')).toBe('[unparseable]');
  });

  it('still redacts properly when :// is present but URL parser rejects', () => {
    // `://` in the input means we can safely echo the part BEFORE
    // it, which by definition has no credentials.
    const out = redactDbUrl('postgresql://[unbalanced');
    expect(out.startsWith('postgresql://')).toBe(true);
    expect(out).toContain('[unparseable]');
  });
});

// Static-source guard: if a future refactor drops the validator from
// run-worker.ts the mirrored copy above silently goes stale. This
// test fails when that happens so the divergence is caught at CI.
describe('P0-8 / R1b run-worker.ts source still defines the contract', () => {
  it('exports validateDatabaseUrl + redactDbUrl + PG_URL_RE', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../scripts/run-worker.ts'), 'utf8');
    expect(src).toMatch(/function\s+validateDatabaseUrl\s*\(/);
    expect(src).toMatch(/function\s+redactDbUrl\s*\(/);
    expect(src).toMatch(/PG_URL_RE\s*=/);
    // The two key behavioural lines must still be there.
    expect(src).toMatch(/empty host/);
    expect(src).toMatch(/postgres(?:ql)?:\/\//);
  });
});
