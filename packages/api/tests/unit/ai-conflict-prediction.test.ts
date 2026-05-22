import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the AI client BEFORE importing predictConflicts so the SUT picks up
// the stubbed isAvailable + complete(). Use vi.hoisted because vi.mock is
// hoisted above all imports and would otherwise reach an uninitialised local.
const { mockComplete } = vi.hoisted(() => ({ mockComplete: vi.fn() }));

vi.mock('../../src/lib/ai/client', () => ({
  aiClient: {
    get isAvailable() {
      return true;
    },
    providerName: 'mock',
    complete: mockComplete,
  },
}));

import { predictConflicts } from '../../src/lib/ai/conflict-prediction';

const TASKS = [
  { id: 't1', title: 'A', status: 'in_progress', assignee: 'alice' },
  { id: 't2', title: 'B', status: 'in_progress', assignee: 'bob' },
];

describe('predictConflicts type predicate (#137)', () => {
  beforeEach(() => {
    mockComplete.mockReset();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('returns { conflicts: [] } when AI returns invalid top-level shape', async () => {
    mockComplete.mockResolvedValueOnce(JSON.stringify({ wrong: 'shape' }));
    const result = await predictConflicts(TASKS);
    expect(result).toEqual({ conflicts: [] });
  });

  it('returns null when AI returns un-parseable text', async () => {
    mockComplete.mockResolvedValueOnce('not-json-at-all <<<<');
    const result = await predictConflicts(TASKS);
    expect(result).toBeNull();
  });

  it('keeps a fully-typed conflict object', async () => {
    mockComplete.mockResolvedValueOnce(
      JSON.stringify({
        conflicts: [
          {
            taskIds: ['t1', 't2'],
            type: 'overlap',
            severity: 'high',
            description: 'Both tasks edit the same module',
            recommendation: 'Sequence them',
          },
        ],
      }),
    );
    const result = await predictConflicts(TASKS);
    expect(result?.conflicts).toHaveLength(1);
    expect(result?.conflicts[0].type).toBe('overlap');
  });

  it('drops conflicts that are missing the type field', async () => {
    mockComplete.mockResolvedValueOnce(
      JSON.stringify({
        conflicts: [
          {
            taskIds: ['t1', 't2'],
            // type missing
            severity: 'high',
            description: 'd',
            recommendation: 'r',
          },
        ],
      }),
    );
    const result = await predictConflicts(TASKS);
    expect(result?.conflicts).toEqual([]);
  });

  it('drops conflicts with empty severity / recommendation strings', async () => {
    mockComplete.mockResolvedValueOnce(
      JSON.stringify({
        conflicts: [
          {
            taskIds: ['t1', 't2'],
            type: 'overlap',
            severity: '',
            description: 'd',
            recommendation: '',
          },
        ],
      }),
    );
    const result = await predictConflicts(TASKS);
    expect(result?.conflicts).toEqual([]);
  });

  it('drops conflicts whose taskIds contain non-string entries', async () => {
    mockComplete.mockResolvedValueOnce(
      JSON.stringify({
        conflicts: [
          {
            taskIds: ['t1', 42],
            type: 'overlap',
            severity: 'high',
            description: 'd',
            recommendation: 'r',
          },
        ],
      }),
    );
    const result = await predictConflicts(TASKS);
    expect(result?.conflicts).toEqual([]);
  });

  it('returns { conflicts: [] } when fewer than 2 tasks are provided', async () => {
    const result = await predictConflicts([TASKS[0]]);
    expect(result).toEqual({ conflicts: [] });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('keeps the valid entries and drops the invalid ones in the same response', async () => {
    mockComplete.mockResolvedValueOnce(
      JSON.stringify({
        conflicts: [
          // valid
          {
            taskIds: ['t1', 't2'],
            type: 'overlap',
            severity: 'medium',
            description: 'd',
            recommendation: 'r',
          },
          // invalid: type missing
          { taskIds: ['t1', 't2'], severity: 'high', description: 'd', recommendation: 'r' },
          // invalid: taskIds empty array is fine for length, but contains non-string
          {
            taskIds: ['t1', 99],
            type: 'overlap',
            severity: 'high',
            description: 'd',
            recommendation: 'r',
          },
        ],
      }),
    );
    const result = await predictConflicts(TASKS);
    expect(result?.conflicts).toHaveLength(1);
    expect(result?.conflicts[0].severity).toBe('medium');
  });
});
