/**
 * R-154: deliverable-id-based diff + severity classifier — pure unit tests.
 *
 * The drift engine integration test `drift-engine.test.ts` exercises the
 * full pipeline against mock Prisma. This file pins the contract of the
 * pure functions themselves so a behavioural change shows up here first
 * (and the engine test only re-asserts the stitching).
 */
import { describe, it, expect } from 'vitest';
import {
  describeLinkedDeliverableChanges,
  diffDeliverables,
  diffHasBreakingChange,
  severityForTaskByDeliverables,
  type DeliverableLite,
} from '../../src/drift/deliverable-diff';

function d(
  id: string,
  slug: string,
  body = slug,
  refUri: string | null = null,
  title = slug,
): DeliverableLite {
  return { id, slug, title, body, refUri };
}

describe('diffDeliverables — diff is keyed by slug, identity preserved by row id', () => {
  it('slug present only in `from` → removed (keyed by OLD row id)', () => {
    const diff = diffDeliverables(
      [d('old-1', 'auth/login'), d('old-2', 'auth/signup')],
      [d('new-1', 'auth/signup')],
    );
    expect(diff.get('old-1')).toEqual({ kind: 'removed' });
    expect(diff.get('old-2')?.kind).toBe('unchanged');
    // Sanity: only the two old ids are keyed; no entries from `to` other
    // than ones not present in `from`.
    expect(diff.has('new-1')).toBe(false);
  });

  it('slug present only in `to` → added (keyed by NEW row id)', () => {
    const diff = diffDeliverables(
      [d('old-1', 'auth/login')],
      [d('new-1', 'auth/login'), d('new-2', 'auth/2fa')],
    );
    expect(diff.get('new-2')).toEqual({ kind: 'added' });
    // The slug that survived: unchanged.
    expect(diff.get('old-1')?.kind).toBe('unchanged');
  });

  it('same slug, body changed → modified with bodyChanged=true', () => {
    const diff = diffDeliverables(
      [d('old-1', 'auth/login', 'OAuth via Google only')],
      [d('new-1', 'auth/login', 'OAuth via Google AND Apple')],
    );
    expect(diff.get('old-1')).toEqual({
      kind: 'modified',
      bodyChanged: true,
      refUriChanged: false,
      titleChanged: false,
    });
  });

  it('same slug + body, only refUri changed → modified with refUriChanged=true', () => {
    const diff = diffDeliverables(
      [d('old-1', 'auth/login', 'spec', 'https://figma.com/A')],
      [d('new-1', 'auth/login', 'spec', 'https://figma.com/B')],
    );
    expect(diff.get('old-1')).toEqual({
      kind: 'modified',
      bodyChanged: false,
      refUriChanged: true,
      titleChanged: false,
    });
  });

  it('null vs empty string refUri are treated as the same (no spurious modify)', () => {
    const diff = diffDeliverables(
      [d('old-1', 'auth/login', 'spec', null)],
      [d('new-1', 'auth/login', 'spec', '')],
    );
    expect(diff.get('old-1')?.kind).toBe('unchanged');
  });

  it('only title changed (slug/body/refUri identical) → modified with titleChanged=true only', () => {
    const diff = diffDeliverables(
      [d('old-1', 'auth/login', 'spec', null, 'Login API')],
      [d('new-1', 'auth/login', 'spec', null, 'Sign-in API')],
    );
    expect(diff.get('old-1')).toEqual({
      kind: 'modified',
      bodyChanged: false,
      refUriChanged: false,
      titleChanged: true,
    });
  });

  it('two identical lists → every entry is `unchanged`', () => {
    const diff = diffDeliverables(
      [d('a-1', 'a', 'A'), d('b-1', 'b', 'B')],
      [d('a-2', 'a', 'A'), d('b-2', 'b', 'B')],
    );
    expect(diff.get('a-1')?.kind).toBe('unchanged');
    expect(diff.get('b-1')?.kind).toBe('unchanged');
  });

  it('empty `from`, non-empty `to` → all added (no exceptions)', () => {
    const diff = diffDeliverables([], [d('n-1', 'x'), d('n-2', 'y')]);
    expect(diff.get('n-1')?.kind).toBe('added');
    expect(diff.get('n-2')?.kind).toBe('added');
  });

  it('empty `to`, non-empty `from` → all removed', () => {
    const diff = diffDeliverables([d('o-1', 'x'), d('o-2', 'y')], []);
    expect(diff.get('o-1')?.kind).toBe('removed');
    expect(diff.get('o-2')?.kind).toBe('removed');
  });
});

describe('diffHasBreakingChange — R-207 plan-level breaking detector', () => {
  it('removed deliverable → true', () => {
    const diff = diffDeliverables([d('o-1', 'auth/login', 'spec')], []);
    expect(diffHasBreakingChange(diff)).toBe(true);
  });

  it('body rewritten → true', () => {
    const diff = diffDeliverables([d('o-1', 'auth/login', 'v1')], [d('n-1', 'auth/login', 'v2')]);
    expect(diffHasBreakingChange(diff)).toBe(true);
  });

  it('refUri-only change → false (re-orient, not breaking)', () => {
    const diff = diffDeliverables(
      [d('o-1', 'auth/login', 'spec', 'https://figma.com/A')],
      [d('n-1', 'auth/login', 'spec', 'https://figma.com/B')],
    );
    expect(diffHasBreakingChange(diff)).toBe(false);
  });

  it('title-only rename → false', () => {
    const diff = diffDeliverables(
      [d('o-1', 'auth/login', 'spec', null, 'Old')],
      [d('n-1', 'auth/login', 'spec', null, 'New')],
    );
    expect(diffHasBreakingChange(diff)).toBe(false);
  });

  it('added-only / unchanged → false', () => {
    const diff = diffDeliverables(
      [d('o-1', 'auth/login', 'spec')],
      [d('o-1', 'auth/login', 'spec'), d('n-2', 'auth/logout', 'spec2')],
    );
    expect(diffHasBreakingChange(diff)).toBe(false);
  });
});

describe('severityForTaskByDeliverables — R-154 severity matrix', () => {
  it('empty link list + breaking diff (deliverable removed) → severity="medium" (R-207: no longer silently low)', () => {
    const diff = diffDeliverables(
      [d('o-1', 'auth/login', 'spec')],
      [
        /* removed */
      ],
    );
    expect(severityForTaskByDeliverables([], diff)).toBe('medium');
  });

  it('empty link list + breaking diff (body rewritten) → severity="medium" (R-207)', () => {
    const diff = diffDeliverables(
      [d('o-1', 'auth/login', 'v1 spec')],
      [d('n-1', 'auth/login', 'v2 spec')],
    );
    expect(severityForTaskByDeliverables([], diff)).toBe('medium');
  });

  it('empty link list + cosmetic diff (title-only rename) → severity="low" (R-207 keeps R-154 anti-fatigue)', () => {
    const diff = diffDeliverables(
      [d('o-1', 'auth/login', 'spec', null, 'Old Title')],
      [d('n-1', 'auth/login', 'spec', null, 'New Title')],
    );
    expect(severityForTaskByDeliverables([], diff)).toBe('low');
  });

  it('empty link list + no change at all → severity="low" (R-207)', () => {
    const diff = diffDeliverables(
      [d('o-1', 'auth/login', 'spec')],
      [d('n-1', 'auth/login', 'spec')],
    );
    expect(severityForTaskByDeliverables([], diff)).toBe('low');
  });

  it('any linked deliverable removed → severity="breaking"', () => {
    const diff = diffDeliverables(
      [d('o-1', 'auth/login', 'spec')],
      [
        /* removed */
      ],
    );
    expect(severityForTaskByDeliverables(['o-1'], diff)).toBe('breaking');
  });

  it('linked deliverable modified body → severity="breaking"', () => {
    const diff = diffDeliverables(
      [d('o-1', 'auth/login', 'v1 spec')],
      [d('n-1', 'auth/login', 'v2 spec')],
    );
    expect(severityForTaskByDeliverables(['o-1'], diff)).toBe('breaking');
  });

  it('linked deliverable modified refUri only → severity="medium"', () => {
    const diff = diffDeliverables(
      [d('o-1', 'auth/login', 'spec', 'https://figma.com/A')],
      [d('n-1', 'auth/login', 'spec', 'https://figma.com/B')],
    );
    expect(severityForTaskByDeliverables(['o-1'], diff)).toBe('medium');
  });

  it('linked deliverable title-only modify → severity="low" (R-154 verification: rename title does NOT trigger high)', () => {
    const diff = diffDeliverables(
      [d('o-1', 'auth/login', 'spec', null, 'Old Title')],
      [d('n-1', 'auth/login', 'spec', null, 'New Title')],
    );
    expect(severityForTaskByDeliverables(['o-1'], diff)).toBe('low');
  });

  it('linked deliverable unchanged → severity="low"', () => {
    const diff = diffDeliverables(
      [d('o-1', 'auth/login', 'spec')],
      [d('n-1', 'auth/login', 'spec')],
    );
    expect(severityForTaskByDeliverables(['o-1'], diff)).toBe('low');
  });

  it('linked deliverable not in diff (e.g. links pointing to a stale plan) → severity="low" (no crash)', () => {
    const diff = diffDeliverables(
      [d('o-1', 'auth/login', 'spec')],
      [d('n-1', 'auth/login', 'spec')],
    );
    expect(severityForTaskByDeliverables(['o-other'], diff)).toBe('low');
  });

  it('mixed links: any "breaking" wins regardless of order', () => {
    const diff = diffDeliverables(
      [d('o-keep', 'auth/login', 'spec'), d('o-gone', 'auth/2fa', 'spec')],
      [d('n-keep', 'auth/login', 'spec')],
    );
    expect(severityForTaskByDeliverables(['o-keep', 'o-gone'], diff)).toBe('breaking');
    expect(severityForTaskByDeliverables(['o-gone', 'o-keep'], diff)).toBe('breaking');
  });

  it('multiple modified refUris but no body changes → severity="medium" (does not escalate)', () => {
    const diff = diffDeliverables(
      [d('o-1', 'fig/a', 'spec', 'AA'), d('o-2', 'fig/b', 'spec', 'BB')],
      [d('n-1', 'fig/a', 'spec', 'AA-new'), d('n-2', 'fig/b', 'spec', 'BB-new')],
    );
    expect(severityForTaskByDeliverables(['o-1', 'o-2'], diff)).toBe('medium');
  });
});

describe('describeLinkedDeliverableChanges — human-readable reason builder', () => {
  it('returns null when no linked deliverable appears in the diff', () => {
    const diff = diffDeliverables([d('o-1', 'a', 'A')], [d('n-1', 'a', 'A')]);
    const slugById = new Map([['o-1', 'a']]);
    expect(describeLinkedDeliverableChanges(['o-1'], diff, slugById)).toBeNull();
  });

  it('returns a parts-list for removed and modified entries by slug', () => {
    const diff = diffDeliverables(
      [d('o-1', 'auth/login', 'spec'), d('o-2', 'auth/2fa', 'spec')],
      [d('n-1', 'auth/login', 'OAuth')],
    );
    const slugById = new Map([
      ['o-1', 'auth/login'],
      ['o-2', 'auth/2fa'],
    ]);
    const out = describeLinkedDeliverableChanges(['o-1', 'o-2'], diff, slugById);
    expect(out).toContain('modified body: auth/login');
    expect(out).toContain('removed: auth/2fa');
  });
});
