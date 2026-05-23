/**
 * Minimal fixture builders. Each helper returns a fresh deep copy so
 * mutation in one test never leaks into another.
 */
import type { Project, Plan, Task, DriftAlert, ExecutionRun } from '@plansync/shared';

let counter = 0;
const id = (prefix: string) => `${prefix}_${++counter}`;
const now = () => new Date('2026-05-23T00:00:00Z');

export function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: id('proj'),
    name: 'Project',
    description: null,
    phase: 'planning',
    repoUrl: null,
    defaultBranch: null,
    createdBy: 'alice',
    createdAt: now(),
    updatedAt: now(),
    ...over,
  };
}

export function makePlan(over: Partial<Plan> = {}): Plan {
  return {
    id: id('plan'),
    projectId: 'proj_1',
    version: 1,
    status: 'draft',
    title: 'Plan',
    goal: 'Build it',
    scope: 'In',
    constraints: [],
    standards: [],
    deliverables: [],
    openQuestions: [],
    changeSummary: null,
    why: null,
    requiredReviewers: [],
    createdBy: 'alice',
    activatedAt: null,
    activatedBy: null,
    createdAt: now(),
    updatedAt: now(),
    ...over,
  };
}

export function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: id('task'),
    projectId: 'proj_1',
    title: 'Task',
    description: null,
    type: 'code',
    priority: 'p1',
    status: 'todo',
    assignee: null,
    assigneeType: 'unassigned',
    boundPlanVersion: 1,
    branchName: null,
    prUrl: null,
    agentContext: null,
    expectedOutput: null,
    agentConstraints: [],
    planDeliverableRefs: [],
    planConstraintRefs: [],
    planStandardRefs: [],
    startDate: null,
    dueDate: null,
    createdAt: now(),
    updatedAt: now(),
    ...over,
  };
}

export function makeDrift(over: Partial<DriftAlert> = {}): DriftAlert {
  return {
    id: id('drift'),
    projectId: 'proj_1',
    taskId: 'task_1',
    type: 'version_mismatch',
    severity: 'high',
    reason: 'plan changed',
    status: 'open',
    resolvedAction: null,
    currentPlanVersion: 2,
    taskBoundVersion: 1,
    compatibilityScore: null,
    impactAnalysis: null,
    suggestedAction: null,
    affectedAreas: [],
    planDiffId: null,
    createdAt: now(),
    resolvedAt: null,
    resolvedBy: null,
    ...over,
  };
}

export function makeRun(over: Partial<ExecutionRun> = {}): ExecutionRun {
  return {
    id: id('run'),
    taskId: 'task_1',
    executorType: 'agent',
    executorName: 'agent-a',
    boundPlanVersion: 1,
    status: 'running',
    taskPackSnapshot: {},
    lastHeartbeatAt: now(),
    outputSummary: null,
    filesChanged: [],
    branchName: null,
    blockers: [],
    driftSignals: [],
    deliverablesMet: [],
    startedAt: now(),
    endedAt: null,
    ...over,
  };
}
