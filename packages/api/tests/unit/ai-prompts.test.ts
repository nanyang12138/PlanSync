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

  // R-188: user-controlled fields (title, assignee, description) are now
  // wrapped in <untrusted source="..."> tags. The system-author fields
  // (id, status) stay raw outside the tags. The contract here pins both
  // halves so a future refactor that drops the wrap fails loudly.
  it('buildConflictPredictionUser wraps user-controlled fields and keeps id/status raw', () => {
    const tasks: ConflictPredictionTaskInput[] = [
      { id: 't1', title: 'Login flow', status: 'in_progress', assignee: 'alice', description: 'JWT' },
      { id: 't2', title: 'Token refresh', status: 'todo', assignee: null, description: null },
    ];
    const out = buildConflictPredictionUser(tasks);
    // Raw system-author halves
    expect(out).toContain('[t1]');
    expect(out).toContain('(in_progress, assigned:');
    expect(out).toContain('[t2]');
    expect(out).toContain('(todo, assigned:');
    // Wrapped user halves
    expect(out).toContain('<untrusted source="task">Login flow</untrusted>');
    expect(out).toContain('<untrusted source="user">alice</untrusted>');
    expect(out).toContain('<untrusted source="task">JWT</untrusted>');
    expect(out).toContain('<untrusted source="task">Token refresh</untrusted>');
    expect(out).toContain('<untrusted source="user">unassigned</untrusted>');
    expect(out).toContain('<untrusted source="task">no description</untrusted>');
  });

  it('buildImpactAnalysisUser wraps diff payload + task fields, keeps version/status raw', () => {
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
    // Diff JSON is wrapped (it was previously an unfiltered AI output)
    expect(out).toContain('<untrusted source="plan">');
    expect(out).toContain('"aspect": "goal"');
    // Task fields wrapped
    expect(out).toContain('<untrusted source="task">Write SSO docs</untrusted>');
    expect(out).toContain('<untrusted source="task">cover IdPs</untrusted>');
    expect(out).toContain('<untrusted source="task">doc</untrusted>');
    // System-author fields raw
    expect(out).toContain('Bound Plan Version: v3');
    expect(out).toContain('Current Status: in_progress');
  });
});
