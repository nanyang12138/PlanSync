import { describe, it, expect } from 'vitest';
import { diffPlans, itemKey, type PlanContent } from '../../src/drift/structural-diff';

const empty = (): PlanContent & { version: number } => ({
  version: 1,
  goal: '',
  scope: '',
  constraints: [],
  standards: [],
  deliverables: [],
  openQuestions: [],
  requiredReviewers: [],
});

describe('itemKey', () => {
  it('is deterministic across calls for the same input', () => {
    expect(itemKey('hello world')).toBe(itemKey('hello world'));
  });

  it('trims surrounding whitespace (matches "use postgres" and "  use postgres  ")', () => {
    expect(itemKey('use postgres')).toBe(itemKey('  use postgres  '));
  });

  it('does NOT collapse internal whitespace or normalize case (those are semantic changes)', () => {
    expect(itemKey('Use Postgres')).not.toBe(itemKey('use postgres'));
    expect(itemKey('use  postgres')).not.toBe(itemKey('use postgres'));
  });

  it('returns an 8-character hex string', () => {
    expect(itemKey('anything')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('produces distinct keys for distinct short strings (sanity check, not a strict collision proof)', () => {
    const keys = new Set([
      itemKey('a'),
      itemKey('b'),
      itemKey('c'),
      itemKey('hello'),
      itemKey('world'),
      itemKey('use postgres'),
      itemKey('use mysql'),
    ]);
    expect(keys.size).toBe(7);
  });
});

describe('diffPlans', () => {
  it('identical plans produce zero changes', () => {
    const a = { ...empty(), goal: 'g', scope: 's', constraints: ['c1'], version: 1 };
    const b = { ...a, version: 2 };
    const diff = diffPlans(a, b);
    expect(diff.changes).toEqual([]);
    expect(diff.fromVersion).toBe(1);
    expect(diff.toVersion).toBe(2);
  });

  it('detects scalar field modification (goal)', () => {
    const a = { ...empty(), goal: 'ship feature X', version: 1 };
    const b = { ...empty(), goal: 'ship feature Y', version: 2 };
    const diff = diffPlans(a, b);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toEqual({
      op: 'modify',
      field: 'goal',
      before: 'ship feature X',
      after: 'ship feature Y',
    });
  });

  it('detects array item removal', () => {
    const a = { ...empty(), constraints: ['use postgres', 'use redis'], version: 1 };
    const b = { ...empty(), constraints: ['use postgres'], version: 2 };
    const diff = diffPlans(a, b);
    expect(diff.changes).toHaveLength(1);
    const ch = diff.changes[0];
    expect(ch.op).toBe('remove');
    expect(ch.field).toBe('constraints');
    if (ch.op === 'remove') {
      expect(ch.before).toBe('use redis');
      expect(ch.itemKey).toBe(itemKey('use redis'));
    }
  });

  it('detects array item addition', () => {
    const a = { ...empty(), deliverables: ['api'], version: 1 };
    const b = { ...empty(), deliverables: ['api', 'cli'], version: 2 };
    const diff = diffPlans(a, b);
    expect(diff.changes).toHaveLength(1);
    const ch = diff.changes[0];
    expect(ch.op).toBe('add');
    if (ch.op === 'add') {
      expect(ch.after).toBe('cli');
      expect(ch.itemKey).toBe(itemKey('cli'));
    }
  });

  it('renders text modification as remove + add (no fuzzy modify in v1)', () => {
    const a = { ...empty(), constraints: ['use postgres'], version: 1 };
    const b = { ...empty(), constraints: ['use postgres 15'], version: 2 };
    const diff = diffPlans(a, b);
    expect(diff.changes).toHaveLength(2);
    const ops = diff.changes.map((c) => c.op).sort();
    expect(ops).toEqual(['add', 'remove']);
  });

  it('reordering an array is a no-op (item identity is content-based)', () => {
    const a = { ...empty(), standards: ['a', 'b', 'c'], version: 1 };
    const b = { ...empty(), standards: ['c', 'a', 'b'], version: 2 };
    const diff = diffPlans(a, b);
    expect(diff.changes).toEqual([]);
  });

  it('handles changes across multiple fields independently', () => {
    const a = {
      ...empty(),
      version: 1,
      goal: 'g1',
      scope: 's1',
      constraints: ['c'],
      deliverables: ['d'],
    };
    const b = {
      ...empty(),
      version: 2,
      goal: 'g2',
      scope: 's1',
      constraints: ['c'],
      deliverables: ['d', 'd2'],
    };
    const diff = diffPlans(a, b);
    const fields = diff.changes.map((c) => c.field).sort();
    expect(fields).toEqual(['deliverables', 'goal']);
  });

  it('emits stable output across repeated calls (determinism contract)', () => {
    const a = { ...empty(), constraints: ['x', 'y'], deliverables: ['a'], version: 1 };
    const b = { ...empty(), constraints: ['y', 'z'], deliverables: ['a', 'b'], version: 2 };
    const d1 = diffPlans(a, b);
    const d2 = diffPlans(a, b);
    expect(d1).toEqual(d2);
  });

  it('removes duplicates within a single field as a single key (current dedupe behavior)', () => {
    // Plan content with intentional duplicates collapses to one key; second
    // copy becomes invisible to the diff. This is a known limitation of the
    // hash-based key strategy and is documented in structural-diff.ts.
    const a = { ...empty(), constraints: ['x', 'x'], version: 1 };
    const b = { ...empty(), constraints: ['x'], version: 2 };
    const diff = diffPlans(a, b);
    expect(diff.changes).toEqual([]);
  });
});
