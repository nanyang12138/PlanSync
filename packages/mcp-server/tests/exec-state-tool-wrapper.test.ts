/**
 * R-171: tool-wrapper FSM integration tests.
 *
 * Verifies that when a `ToolWrapperOptions.execStateManager` is supplied,
 * `evaluatePreflight` short-circuits illegal transitions in enforce mode
 * BEFORE calling the handler, and lets legal transitions through. Also
 * verifies the ordering: abort > delegation > FSM (the most-severe gate
 * wins).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { evaluatePreflight, wrapToolHandler } from '../src/tool-wrapper';
import { ExecStateManager } from '../src/exec-state-manager';
import { _resetRunAbortedForTests, signalRunAborted } from '../src/abort-signal';

beforeEach(() => {
  _resetRunAbortedForTests();
});

const noDelegation = {
  delegationAllowed: new Set<string>(['plansync_anything']),
  getDelegationAgent: () => undefined as string | undefined,
};

describe('R-171: evaluatePreflight FSM short-circuit', () => {
  it('allows a legal first call (exec_context) in enforce mode', () => {
    const mgr = new ExecStateManager({ enforceMode: 'enforce' });
    const res = evaluatePreflight('plansync_exec_context', {
      ...noDelegation,
      execStateManager: mgr,
    });
    expect(res.kind).toBe('allow');
    expect(mgr.getState()).toBe('CONTEXT_LOADED');
  });

  it('short-circuits an illegal first call (execution_complete) in enforce mode', () => {
    const mgr = new ExecStateManager({ enforceMode: 'enforce' });
    const res = evaluatePreflight('plansync_execution_complete', {
      ...noDelegation,
      execStateManager: mgr,
    });
    expect(res.kind).toBe('short-circuit');
    if (res.kind === 'short-circuit') {
      const payload = JSON.parse(
        (res.response as { content: Array<{ text: string }> }).content[0].text,
      );
      expect(payload.error.code).toBe('OUT_OF_SEQUENCE');
    }
    // State does NOT advance on rejection.
    expect(mgr.getState()).toBe('UNINITIALIZED');
  });

  it('shadow mode allows the same illegal call (no short-circuit)', () => {
    const mgr = new ExecStateManager({ enforceMode: 'shadow' });
    const res = evaluatePreflight('plansync_execution_complete', {
      ...noDelegation,
      execStateManager: mgr,
    });
    expect(res.kind).toBe('allow');
  });

  it('off mode behaves identically to no manager (no short-circuit)', () => {
    const mgr = new ExecStateManager({ enforceMode: 'off' });
    const res = evaluatePreflight('plansync_execution_complete', {
      ...noDelegation,
      execStateManager: mgr,
    });
    expect(res.kind).toBe('allow');
  });

  it('omitting execStateManager preserves pre-R-171 behaviour', () => {
    const res = evaluatePreflight('plansync_execution_complete', { ...noDelegation });
    expect(res.kind).toBe('allow');
  });
});

describe('R-171: preflight gate ordering (abort > delegation > FSM)', () => {
  it('RUN_ABORTED wins even when FSM would also reject', () => {
    const mgr = new ExecStateManager({ enforceMode: 'enforce' });
    signalRunAborted({
      code: 'RUN_PAUSED',
      message: 'paused',
      runId: 'run_x',
      taskId: 'task_x',
    });
    const res = evaluatePreflight('plansync_execution_complete', {
      ...noDelegation,
      execStateManager: mgr,
    });
    expect(res.kind).toBe('short-circuit');
    if (res.kind === 'short-circuit') {
      const payload = JSON.parse(
        (res.response as { content: Array<{ text: string }> }).content[0].text,
      );
      // RUN_ABORTED envelope, not OUT_OF_SEQUENCE.
      expect(payload.error.code).toBe('RUN_ABORTED');
    }
    // FSM never saw the call.
    expect(mgr.getState()).toBe('UNINITIALIZED');
  });

  it('DELEGATION_BLOCKED wins over FSM (when both would reject)', () => {
    const mgr = new ExecStateManager({ enforceMode: 'enforce' });
    const opts = {
      delegationAllowed: new Set<string>(['plansync_exec_context']), // execution_start NOT allowed
      getDelegationAgent: () => 'alice',
      execStateManager: mgr,
    };
    const res = evaluatePreflight('plansync_execution_start', opts);
    expect(res.kind).toBe('short-circuit');
    if (res.kind === 'short-circuit') {
      const payload = JSON.parse(
        (res.response as { content: Array<{ text: string }> }).content[0].text,
      );
      expect(payload.error).toBe('DELEGATION_BLOCKED');
    }
    // FSM never saw the call.
    expect(mgr.getState()).toBe('UNINITIALIZED');
  });
});

describe('R-171: wrapToolHandler honours FSM short-circuit', () => {
  it('skips the handler entirely on OUT_OF_SEQUENCE', async () => {
    const mgr = new ExecStateManager({ enforceMode: 'enforce' });
    let handlerInvoked = false;
    const wrapped = wrapToolHandler(
      'plansync_execution_complete',
      async () => {
        handlerInvoked = true;
        return { ok: true };
      },
      { ...noDelegation, execStateManager: mgr },
    );
    const out = await wrapped({});
    expect(handlerInvoked).toBe(false);
    expect((out as { isError?: boolean }).isError).toBe(true);
  });

  it('invokes the handler on a legal call', async () => {
    const mgr = new ExecStateManager({ enforceMode: 'enforce' });
    let handlerInvoked = false;
    const wrapped = wrapToolHandler(
      'plansync_exec_context',
      async () => {
        handlerInvoked = true;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
      { ...noDelegation, execStateManager: mgr },
    );
    await wrapped({});
    expect(handlerInvoked).toBe(true);
    expect(mgr.getState()).toBe('CONTEXT_LOADED');
  });
});
