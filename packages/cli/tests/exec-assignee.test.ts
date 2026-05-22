/**
 * Tests for R-060: /exec must allow human-assigned tasks when the assignee
 * matches the current CLI user.
 *
 * Before R-060 the CLI rejected any task whose assigneeType !== 'agent', so
 * users could not /exec their own human tasks. The tests below exercise the
 * pure `resolveExecAssignee` helper that backs the launchExec gate.
 */

import { describe, it, expect } from 'vitest';
import { resolveExecAssignee } from '../src/exec.js';

describe('resolveExecAssignee (R-060)', () => {
  it('allows an agent-assigned task and uses the agent as executor', () => {
    const out = resolveExecAssignee(
      { assignee: 'bot-a', assigneeType: 'agent' },
      'alice',
    );
    expect(out).toEqual({ ok: true, executorType: 'agent', executorName: 'bot-a' });
  });

  it('allows a human-assigned task when assignee === current user', () => {
    const out = resolveExecAssignee(
      { assignee: 'alice', assigneeType: 'human' },
      'alice',
    );
    expect(out).toEqual({ ok: true, executorType: 'human', executorName: 'alice' });
  });

  it('rejects a human-assigned task when assignee !== current user', () => {
    const out = resolveExecAssignee(
      { assignee: 'bob', assigneeType: 'human' },
      'alice',
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toMatch(/human-assigned/);
      expect(out.reason).toMatch(/bob/);
      expect(out.reason).toMatch(/alice/);
    }
  });

  it('rejects an unassigned task', () => {
    const out = resolveExecAssignee(
      { assignee: null, assigneeType: 'agent' },
      'alice',
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toMatch(/assignee/);
    }
  });

  it('rejects when assignee is empty string', () => {
    const out = resolveExecAssignee({ assignee: '', assigneeType: 'human' }, 'alice');
    expect(out.ok).toBe(false);
  });

  it('rejects an unknown assigneeType (defense-in-depth)', () => {
    const out = resolveExecAssignee(
      { assignee: 'alice', assigneeType: 'robot' },
      'alice',
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toMatch(/agent member or a human/);
    }
  });

  it('rejects null assigneeType (treated as unassigned-type)', () => {
    const out = resolveExecAssignee(
      { assignee: 'alice', assigneeType: null },
      'alice',
    );
    expect(out.ok).toBe(false);
  });
});
