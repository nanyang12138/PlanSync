import { describe, it, expect } from 'vitest';
import { proposePlanSchema, reviewerSpecSchema } from '../../src/schemas/plan';

describe('proposePlanSchema (R-032)', () => {
  it('accepts an empty object (reviewers optional)', () => {
    expect(proposePlanSchema.parse({})).toEqual({});
  });

  it('accepts reviewers as bare strings', () => {
    const parsed = proposePlanSchema.parse({ reviewers: ['alice', 'bob'] });
    expect(parsed.reviewers).toEqual(['alice', 'bob']);
  });

  it('accepts reviewers as structured objects', () => {
    const parsed = proposePlanSchema.parse({
      reviewers: [
        { name: 'genie', type: 'agent' },
        { name: 'alice', focusNotes: 'auth flow' },
      ],
    });
    expect(parsed.reviewers).toHaveLength(2);
  });

  it('rejects empty string reviewer names', () => {
    expect(() => reviewerSpecSchema.parse('')).toThrow();
    expect(() => reviewerSpecSchema.parse({ name: '' })).toThrow();
  });

  it('rejects unknown member types', () => {
    expect(() =>
      proposePlanSchema.parse({ reviewers: [{ name: 'x', type: 'robot' }] }),
    ).toThrow();
  });

  it('rejects more than 20 reviewers', () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `r${i}`);
    expect(() => proposePlanSchema.parse({ reviewers: tooMany })).toThrow();
  });

  it('accepts exactly 20 reviewers (boundary)', () => {
    const ok = Array.from({ length: 20 }, (_, i) => `r${i}`);
    const parsed = proposePlanSchema.parse({ reviewers: ok });
    expect(parsed.reviewers).toHaveLength(20);
  });

  it('rejects non-array reviewers', () => {
    expect(() => proposePlanSchema.parse({ reviewers: 'alice' })).toThrow();
  });
});
