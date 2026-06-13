/**
 * PR1 (advisory-review-ingest): `sanitizeAdvisoryReviews` is the pure,
 * never-throws gatekeeper that lets the `complete` path stay "always
 * advisory". It must accept ANY input (string, null, garbage array) and
 * return a safe, bounded list — dropping what it can't use and truncating
 * what's oversized into `warnings`, never throwing and never rejecting the
 * whole call.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeAdvisoryReviews, ADVISORY_REVIEW_CAPS } from '../../src/schemas/task';

const validReview = () => ({
  kind: 'code_review_advisory',
  source: 'exec_agent',
  reviewedRef: { branchName: 'feat/x', headSha: 'abc123', baseSha: 'def456' },
  summary: 'No blocker, 1 medium issue.',
  findings: [
    { severity: 'medium', file: 'a.ts', line: 88, message: 'missing test', confidence: 0.7 },
    { severity: 'low', file: 'b.ts', message: 'nit' },
  ],
});

describe('sanitizeAdvisoryReviews', () => {
  it('returns empty (no warnings) for undefined / null', () => {
    expect(sanitizeAdvisoryReviews(undefined)).toEqual({ reviews: [], warnings: [] });
    expect(sanitizeAdvisoryReviews(null)).toEqual({ reviews: [], warnings: [] });
  });

  it('drops a non-array input with a warning, never throws', () => {
    const out = sanitizeAdvisoryReviews('garbage');
    expect(out.reviews).toEqual([]);
    expect(out.warnings.join(' ')).toMatch(/not an array/i);
  });

  it('accepts a valid review and computes severity counts', () => {
    const out = sanitizeAdvisoryReviews([validReview()]);
    expect(out.warnings).toEqual([]);
    expect(out.reviews).toHaveLength(1);
    const r = out.reviews[0];
    expect(r.kind).toBe('code_review_advisory');
    expect(r.findings).toHaveLength(2);
    expect(r.counts.medium).toBe(1);
    expect(r.counts.low).toBe(1);
    expect(r.truncated).toBe(false);
    expect(r.reviewedRef).toEqual({ branchName: 'feat/x', headSha: 'abc123', baseSha: 'def456' });
  });

  it('defaults missing source to exec_agent', () => {
    const rev = validReview();
    delete (rev as Record<string, unknown>).source;
    const out = sanitizeAdvisoryReviews([rev]);
    expect(out.reviews[0].source).toBe('exec_agent');
  });

  it('drops a single invalid finding but keeps the good ones', () => {
    const rev = validReview();
    rev.findings = [
      { severity: 'high', file: 'a.ts', message: 'real' },
      { severity: 'high', file: 'b.ts' } as never, // missing message → invalid
    ];
    const out = sanitizeAdvisoryReviews([rev]);
    expect(out.reviews[0].findings).toHaveLength(1);
    expect(out.reviews[0].counts.high).toBe(1);
    expect(out.warnings.join(' ')).toMatch(/findings\[1\] invalid/i);
  });

  it('clamps out-of-range confidence into [0,1]', () => {
    const rev = validReview();
    rev.findings = [{ severity: 'low', file: 'a.ts', message: 'm', confidence: 5 }];
    const out = sanitizeAdvisoryReviews([rev]);
    expect(out.reviews[0].findings[0].confidence).toBe(1);
  });

  it('truncates an oversized message rather than dropping the finding', () => {
    const rev = validReview();
    const huge = 'x'.repeat(ADVISORY_REVIEW_CAPS.maxMessageChars + 500);
    rev.findings = [{ severity: 'low', file: 'a.ts', message: huge }];
    const out = sanitizeAdvisoryReviews([rev]);
    expect(out.reviews[0].findings).toHaveLength(1);
    expect(out.reviews[0].findings[0].message.length).toBe(ADVISORY_REVIEW_CAPS.maxMessageChars);
  });

  it('caps findings per review and flags truncated', () => {
    const rev = validReview();
    rev.findings = Array.from({ length: ADVISORY_REVIEW_CAPS.maxFindingsPerReview + 5 }, () => ({
      severity: 'info' as const,
      file: 'a.ts',
      message: 'm',
    }));
    const out = sanitizeAdvisoryReviews([rev]);
    expect(out.reviews[0].findings).toHaveLength(ADVISORY_REVIEW_CAPS.maxFindingsPerReview);
    expect(out.reviews[0].truncated).toBe(true);
    expect(out.warnings.join(' ')).toMatch(/kept first/i);
  });

  it('caps the number of reviews per complete', () => {
    const many = Array.from(
      { length: ADVISORY_REVIEW_CAPS.maxReviewsPerComplete + 3 },
      validReview,
    );
    const out = sanitizeAdvisoryReviews(many);
    expect(out.reviews).toHaveLength(ADVISORY_REVIEW_CAPS.maxReviewsPerComplete);
    expect(out.warnings.join(' ')).toMatch(/kept first/i);
  });

  it('drops a non-object review entry but keeps siblings', () => {
    const out = sanitizeAdvisoryReviews([validReview(), 42, null]);
    expect(out.reviews).toHaveLength(1);
    expect(out.warnings.join(' ')).toMatch(/not an object/i);
  });

  it('treats a missing findings array as empty (still a valid review)', () => {
    const rev = validReview();
    delete (rev as Record<string, unknown>).findings;
    const out = sanitizeAdvisoryReviews([rev]);
    expect(out.reviews).toHaveLength(1);
    expect(out.reviews[0].findings).toEqual([]);
    expect(out.warnings.join(' ')).toMatch(/findings missing/i);
  });
});
