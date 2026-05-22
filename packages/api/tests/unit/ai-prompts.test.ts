import { describe, it, expect } from 'vitest';
import {
  buildPlanDiffUser,
  type PlanDiffInput,
} from '../../src/lib/ai/prompts/plan-diff.prompt';
import {
  buildConflictPredictionUser,
  type ConflictPredictionTaskInput,
} from '../../src/lib/ai/prompts/conflict-prediction.prompt';
import {
  buildImpactAnalysisUser,
  type ImpactAnalysisDiffInput,
  type ImpactAnalysisTaskInput,
} from '../../src/lib/ai/prompts/impact-analysis.prompt';

// R-133: AI prompt builders used `any` for their plan/task/diff inputs.
// After migration, exported interfaces define the minimum shape they
// rely on. Tests pin the wire-format contract.
describe('AI prompt builders — typed inputs (R-133)', () => {
  it('buildPlanDiffUser renders both versions and lists plan fields', () => {
    const planA: PlanDiffInput = {
      version: 1,
      status: 'archived',
      title: 'Initial plan',
      goal: 'Ship MVP',
      scope: 'core auth',
      constraints: ['use postgres'],
      standards: ['Conventional Commits'],
      deliverables: ['/login'],
      openQuestions: [],
    };
    const planB: PlanDiffInput = {
      version: 2,
      status: 'active',
      title: 'Revised plan',
      goal: 'Ship MVP + SSO',
      scope: 'core auth + SSO',
      constraints: ['use postgres', 'no third-party SSO'],
      standards: ['Conventional Commits'],
      deliverables: ['/login', '/sso'],
      openQuestions: ['Which IdP?'],
    };
    const out = buildPlanDiffUser(planA, planB);
    expect(out).toContain('Plan v1 (archived)');
    expect(out).toContain('Plan v2 (active)');
    expect(out).toContain('Ship MVP + SSO');
    expect(out).toContain('Which IdP?');
  });

  it('buildConflictPredictionUser summarises each task on its own line', () => {
    const tasks: ConflictPredictionTaskInput[] = [
      { id: 't1', title: 'Login flow', status: 'in_progress', assignee: 'alice', description: 'JWT' },
      { id: 't2', title: 'Token refresh', status: 'todo', assignee: null, description: null },
    ];
    const out = buildConflictPredictionUser(tasks);
    expect(out).toContain('[t1] "Login flow" (in_progress, assigned: alice) - JWT');
    expect(out).toContain('[t2] "Token refresh" (todo, assigned: unassigned) - no description');
  });

  it('buildImpactAnalysisUser includes diff JSON and bound plan version', () => {
    const diff: ImpactAnalysisDiffInput = {
      changes: [{ aspect: 'goal', type: 'modified', impact: 'high', description: 'reframe' }],
    };
    const task: ImpactAnalysisTaskInput = {
      title: 'Write SSO docs',
      description: 'cover IdPs',
      type: 'doc',
      status: 'in_progress',
      boundPlanVersion: 3,
    };
    const out = buildImpactAnalysisUser(diff, task);
    expect(out).toContain('## Plan Changes');
    expect(out).toContain('"aspect": "goal"');
    expect(out).toContain('Title: Write SSO docs');
    expect(out).toContain('Bound Plan Version: v3');
  });
});
