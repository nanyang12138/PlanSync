import { describe, it, expect } from 'vitest';
import { diffPlans, type PlanContent } from '../../src/drift/structural-diff';
import { severityForTask, severityForTasks, type TaskRefs } from '../../src/drift/severity';

const base: PlanContent & { version: number } = {
  version: 1,
  goal: 'ship feature X',
  scope: 'web only',
  constraints: ['use postgres', 'no breaking api changes'],
  standards: ['eslint', 'prettier'],
  deliverables: ['rest api', 'cli wrapper', 'docs'],
  openQuestions: [],
  requiredReviewers: [],
};

const taskAllRefs: TaskRefs = {
  // legacy task: empty refs means "depends on all"
  planDeliverableRefs: [],
  planConstraintRefs: null,
  planStandardRefs: null,
};

const taskNarrow: TaskRefs = {
  planDeliverableRefs: ['rest api'],
  planConstraintRefs: ['use postgres'],
  planStandardRefs: ['eslint'],
};

describe('severityForTask — breaking triggers', () => {
  it('goal change is always breaking, regardless of task refs', () => {
    const next = { ...base, version: 2, goal: 'ship feature Y' };
    expect(severityForTask(taskNarrow, diffPlans(base, next))).toBe('breaking');
    expect(severityForTask(taskAllRefs, diffPlans(base, next))).toBe('breaking');
  });

  it('modifying a referenced deliverable is breaking (modify = remove+add of same key)', () => {
    const next = {
      ...base,
      version: 2,
      deliverables: ['rest api v2', 'cli wrapper', 'docs'],
    };
    expect(severityForTask(taskNarrow, diffPlans(base, next))).toBe('breaking');
  });

  it('removing a referenced deliverable is breaking', () => {
    const next = { ...base, version: 2, deliverables: ['cli wrapper', 'docs'] };
    expect(severityForTask(taskNarrow, diffPlans(base, next))).toBe('breaking');
  });

  it('adding a deliverable the task does not reference is NOT breaking', () => {
    const next = { ...base, version: 2, deliverables: [...base.deliverables, 'graphql api'] };
    expect(severityForTask(taskNarrow, diffPlans(base, next))).toBe('low');
  });

  it('changing a referenced constraint is breaking', () => {
    const next = {
      ...base,
      version: 2,
      constraints: ['use mysql', 'no breaking api changes'],
    };
    expect(severityForTask(taskNarrow, diffPlans(base, next))).toBe('breaking');
  });

  it('legacy task (all refs) treats any deliverable change as breaking', () => {
    const next = { ...base, version: 2, deliverables: [...base.deliverables, 'new thing'] };
    expect(severityForTask(taskAllRefs, diffPlans(base, next))).toBe('breaking');
  });
});

describe('severityForTask — medium triggers', () => {
  it('scope change is medium when no deliverable/constraint touched', () => {
    const next = { ...base, version: 2, scope: 'web and mobile' };
    expect(severityForTask(taskNarrow, diffPlans(base, next))).toBe('medium');
  });

  it('changing a referenced standard is medium (not breaking)', () => {
    const next = { ...base, version: 2, standards: ['biome', 'prettier'] };
    expect(severityForTask(taskNarrow, diffPlans(base, next))).toBe('medium');
  });

  it('legacy task (null standard refs) treats any standard change as medium', () => {
    const next = { ...base, version: 2, standards: ['biome', 'prettier'] };
    expect(severityForTask(taskAllRefs, diffPlans(base, next))).toBe('medium');
  });

  it('changing an unreferenced standard is low for narrowly-scoped tasks', () => {
    // Task only references "eslint"; change "prettier" to "dprint"
    const next = { ...base, version: 2, standards: ['eslint', 'dprint'] };
    expect(severityForTask(taskNarrow, diffPlans(base, next))).toBe('low');
  });
});

describe('severityForTask — low / no-op', () => {
  it('open questions and reviewers changes are low for everyone', () => {
    const next = {
      ...base,
      version: 2,
      openQuestions: ['will we add SSO?'],
      requiredReviewers: ['alice'],
    };
    expect(severityForTask(taskNarrow, diffPlans(base, next))).toBe('low');
    expect(severityForTask(taskAllRefs, diffPlans(base, next))).toBe('low');
  });

  it('zero-change diff is low (no plan changes)', () => {
    expect(severityForTask(taskNarrow, diffPlans(base, { ...base, version: 2 }))).toBe('low');
  });
});

describe('severityForTask — priority of breaking > medium > low', () => {
  it('returns breaking when a diff contains both breaking and medium triggers', () => {
    const next = {
      ...base,
      version: 2,
      scope: 'mobile only', // medium
      goal: 'a different goal', // breaking
    };
    expect(severityForTask(taskNarrow, diffPlans(base, next))).toBe('breaking');
  });

  it('does not "downgrade" when an earlier change is low and a later change is medium', () => {
    const next = {
      ...base,
      version: 2,
      openQuestions: ['xxx'], // low
      scope: 'mobile only', // medium
    };
    expect(severityForTask(taskNarrow, diffPlans(base, next))).toBe('medium');
  });
});

describe('severityForTasks (batch)', () => {
  it('returns one entry per input task, in input order', () => {
    const t1 = { id: 't1', ...taskNarrow };
    const t2 = { id: 't2', ...taskAllRefs };
    const next = { ...base, version: 2, goal: 'changed' };
    const out = severityForTasks([t1, t2], diffPlans(base, next));
    expect(out).toEqual([
      { taskId: 't1', severity: 'breaking' },
      { taskId: 't2', severity: 'breaking' },
    ]);
  });

  it('short-circuits empty-diff case to low for every task', () => {
    const t1 = { id: 't1', ...taskNarrow };
    const out = severityForTasks([t1], diffPlans(base, { ...base, version: 2 }));
    expect(out).toEqual([{ taskId: 't1', severity: 'low' }]);
  });
});

describe('determinism — same inputs always give same answer', () => {
  it('repeated severity computation is stable', () => {
    const next = { ...base, version: 2, deliverables: ['rest api v2', 'cli wrapper', 'docs'] };
    const diff = diffPlans(base, next);
    const first = severityForTask(taskNarrow, diff);
    for (let i = 0; i < 50; i++) {
      expect(severityForTask(taskNarrow, diff)).toBe(first);
    }
  });
});
