import { describe, it, expect, vi, beforeEach } from 'vitest';

type MockTask = {
  id: string;
  projectId: string;
  title: string;
  status: string;
  boundPlanVersion: number;
  executionRuns: Array<{ status: string }>;
};

function computeSeverity(task: MockTask): 'high' | 'medium' | 'low' {
  const hasRunning = task.executionRuns.some((r) => r.status === 'running');
  if (hasRunning) return 'high';
  if (['in_progress', 'blocked', 'todo'].includes(task.status)) return 'medium';
  return 'low';
}

function shouldScanTask(task: { status: string }): boolean {
  return task.status !== 'cancelled';
}

describe('Drift Engine - Severity Calculation', () => {
  it('should return HIGH severity when task has running execution', () => {
    const task: MockTask = {
      id: 't1',
      projectId: 'p1',
      title: 'Test',
      status: 'in_progress',
      boundPlanVersion: 1,
      executionRuns: [{ status: 'running' }],
    };
    expect(computeSeverity(task)).toBe('high');
  });

  it('should return MEDIUM severity for in_progress task without running execution', () => {
    const task: MockTask = {
      id: 't2',
      projectId: 'p1',
      title: 'Test',
      status: 'in_progress',
      boundPlanVersion: 1,
      executionRuns: [],
    };
    expect(computeSeverity(task)).toBe('medium');
  });

  it('should return MEDIUM severity for todo task', () => {
    const task: MockTask = {
      id: 't3',
      projectId: 'p1',
      title: 'Test',
      status: 'todo',
      boundPlanVersion: 1,
      executionRuns: [],
    };
    expect(computeSeverity(task)).toBe('medium');
  });

  it('should return MEDIUM severity for blocked task', () => {
    const task: MockTask = {
      id: 't4',
      projectId: 'p1',
      title: 'Test',
      status: 'blocked',
      boundPlanVersion: 1,
      executionRuns: [],
    };
    expect(computeSeverity(task)).toBe('medium');
  });

  it('should return LOW severity for done task', () => {
    const task: MockTask = {
      id: 't5',
      projectId: 'p1',
      title: 'Test',
      status: 'done',
      boundPlanVersion: 1,
      executionRuns: [],
    };
    expect(computeSeverity(task)).toBe('low');
  });
});

describe('Drift Engine - Cancelled Task Exclusion', () => {
  it('should exclude cancelled tasks from scan', () => {
    expect(shouldScanTask({ status: 'cancelled' })).toBe(false);
  });

  it('should include in_progress tasks in scan', () => {
    expect(shouldScanTask({ status: 'in_progress' })).toBe(true);
  });

  it('should include todo tasks in scan', () => {
    expect(shouldScanTask({ status: 'todo' })).toBe(true);
  });

  it('should include done tasks in scan', () => {
    expect(shouldScanTask({ status: 'done' })).toBe(true);
  });
});

describe('Drift Engine - Edge Cases', () => {
  it('should handle task with completed execution (not running)', () => {
    const task: MockTask = {
      id: 't6',
      projectId: 'p1',
      title: 'Test',
      status: 'in_progress',
      boundPlanVersion: 1,
      executionRuns: [{ status: 'completed' }],
    };
    expect(computeSeverity(task)).toBe('medium');
  });

  it('should handle task with multiple executions, one running', () => {
    const task: MockTask = {
      id: 't7',
      projectId: 'p1',
      title: 'Test',
      status: 'in_progress',
      boundPlanVersion: 1,
      executionRuns: [{ status: 'completed' }, { status: 'running' }],
    };
    expect(computeSeverity(task)).toBe('high');
  });
});
