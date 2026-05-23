import { describe, expect, it } from 'vitest';

import {
  EXEC_STATES,
  EXEC_STATE_MACHINE,
  EXEC_STATE_TOKEN_MAX_AGE_MS,
  OUT_OF_SEQUENCE,
  READ_ONLY_TOOLS,
  TERMINAL_STATES,
  checkTransition,
  execStateTokenPayloadSchema,
  isTerminalState,
  listGatedTools,
  nextStateForTool,
  type ExecState,
} from '../../src/protocol/exec-state';

describe('exec-state FSM table', () => {
  it('lists exactly the 6 protocol states in canonical order', () => {
    expect(EXEC_STATES).toEqual([
      'UNINITIALIZED',
      'CONTEXT_LOADED',
      'PACK_FETCHED',
      'RUN_STARTED',
      'COMPLETED',
      'ABORTED',
    ]);
  });

  it('declares COMPLETED and ABORTED as the only terminal states', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(['ABORTED', 'COMPLETED']);
    for (const s of EXEC_STATES) {
      expect(isTerminalState(s)).toBe(s === 'COMPLETED' || s === 'ABORTED');
    }
  });

  it('has a node for every declared state', () => {
    for (const state of EXEC_STATES) {
      expect(EXEC_STATE_MACHINE[state]).toBeDefined();
    }
  });

  it('keeps terminal states sealed (no allowed tools, no required next)', () => {
    for (const state of TERMINAL_STATES) {
      const node = EXEC_STATE_MACHINE[state];
      expect(node.allowedTools).toEqual([]);
      expect(node.requiredNextOneOf).toEqual([]);
      expect(node.transitions).toEqual({});
    }
  });

  it('declares every transition target to be a known state', () => {
    for (const node of Object.values(EXEC_STATE_MACHINE)) {
      for (const target of Object.values(node.transitions)) {
        expect(EXEC_STATES).toContain(target as ExecState);
      }
    }
  });

  it('declares every requiredNextOneOf entry to be in allowedTools', () => {
    for (const node of Object.values(EXEC_STATE_MACHINE)) {
      for (const required of node.requiredNextOneOf) {
        expect(node.allowedTools).toContain(required);
      }
    }
  });

  it('listGatedTools surfaces every tool that participates in the FSM', () => {
    const tools = listGatedTools();
    expect(tools).toContain('plansync_exec_context');
    expect(tools).toContain('plansync_task_pack');
    expect(tools).toContain('plansync_execution_start');
    expect(tools).toContain('plansync_execution_heartbeat');
    expect(tools).toContain('plansync_execution_complete');
    expect(tools).toContain('plansync_execution_abort');
    // returned sorted + deduped
    expect(tools).toEqual([...tools].sort());
    expect(new Set(tools).size).toBe(tools.length);
  });

  it('never lists a read-only tool inside a gated state', () => {
    // Read-only tools are short-circuited before the table is consulted;
    // putting them in `allowedTools` would create confusing ambiguity.
    for (const node of Object.values(EXEC_STATE_MACHINE)) {
      for (const t of node.allowedTools) {
        expect(READ_ONLY_TOOLS).not.toContain(t);
      }
    }
  });
});

describe('checkTransition', () => {
  it('walks the happy path UNINITIALIZED → COMPLETED', () => {
    let state: ExecState = 'UNINITIALIZED';
    const steps: Array<[string, ExecState]> = [
      ['plansync_exec_context', 'CONTEXT_LOADED'],
      ['plansync_task_pack', 'PACK_FETCHED'],
      ['plansync_execution_start', 'RUN_STARTED'],
      ['plansync_execution_heartbeat', 'RUN_STARTED'],
      ['plansync_execution_heartbeat', 'RUN_STARTED'],
      ['plansync_execution_complete', 'COMPLETED'],
    ];
    for (const [tool, expected] of steps) {
      const r = checkTransition(state, tool);
      expect(r.ok, `expected ${tool} from ${state} to succeed`).toBe(true);
      if (r.ok) {
        expect(r.nextState).toBe(expected);
        state = r.nextState;
      }
    }
    expect(state).toBe('COMPLETED');
  });

  it('walks the abort path RUN_STARTED → ABORTED', () => {
    const r = checkTransition('RUN_STARTED', 'plansync_execution_abort');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nextState).toBe('ABORTED');
  });

  it('rejects skipping plansync_task_pack and goes straight to execution_start', () => {
    const r = checkTransition('CONTEXT_LOADED', 'plansync_execution_start');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(OUT_OF_SEQUENCE);
      expect(r.currentState).toBe('CONTEXT_LOADED');
      expect(r.requiredNextOneOf).toContain('plansync_task_pack');
      expect(r.message).toMatch(/plansync_execution_start/);
      expect(r.message).toMatch(/CONTEXT_LOADED/);
    }
  });

  it('rejects calling plansync_execution_complete before plansync_execution_start', () => {
    const r = checkTransition('PACK_FETCHED', 'plansync_execution_complete');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(OUT_OF_SEQUENCE);
      expect(r.requiredNextOneOf).toEqual(['plansync_execution_start']);
    }
  });

  it('rejects any gated tool once the run is COMPLETED', () => {
    for (const t of [
      'plansync_execution_heartbeat',
      'plansync_execution_complete',
      'plansync_task_pack',
      'plansync_execution_start',
    ]) {
      const r = checkTransition('COMPLETED', t);
      expect(r.ok, `expected ${t} from COMPLETED to fail`).toBe(false);
    }
  });

  it('rejects any gated tool once the run is ABORTED', () => {
    const r = checkTransition('ABORTED', 'plansync_execution_heartbeat');
    expect(r.ok).toBe(false);
  });

  it('lets read-only tools through from any state, including terminal ones', () => {
    for (const state of EXEC_STATES) {
      for (const ro of READ_ONLY_TOOLS) {
        const r = checkTransition(state, ro);
        expect(r.ok, `${ro} should be allowed from ${state}`).toBe(true);
        if (r.ok) {
          expect(r.nextState).toBe(state);
          expect(r.readOnly).toBe(true);
        }
      }
    }
  });

  it('lets idempotent calls (heartbeat / drift_resolve) stay in RUN_STARTED', () => {
    for (const tool of [
      'plansync_execution_heartbeat',
      'plansync_drift_resolve',
      'plansync_task_rebind',
      'plansync_comment_create',
      'plansync_plan_suggest',
    ]) {
      const r = checkTransition('RUN_STARTED', tool);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.nextState).toBe('RUN_STARTED');
    }
  });

  it('rejects unknown tools with OUT_OF_SEQUENCE rather than throwing', () => {
    const r = checkTransition('RUN_STARTED', 'plansync_definitely_not_a_tool');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(OUT_OF_SEQUENCE);
      expect(r.allowedTools.length).toBeGreaterThan(0);
    }
  });
});

describe('nextStateForTool', () => {
  it('returns the next state on a valid transition', () => {
    expect(nextStateForTool('UNINITIALIZED', 'plansync_exec_context')).toBe('CONTEXT_LOADED');
    expect(nextStateForTool('RUN_STARTED', 'plansync_execution_heartbeat')).toBe('RUN_STARTED');
  });

  it('throws on illegal transitions with a hint in the message', () => {
    expect(() => nextStateForTool('UNINITIALIZED', 'plansync_execution_complete')).toThrow(
      /UNINITIALIZED/,
    );
  });
});

describe('execStateTokenPayloadSchema', () => {
  it('accepts a well-formed payload', () => {
    const ok = execStateTokenPayloadSchema.safeParse({
      v: 1,
      runId: 'run_abc',
      projectId: 'proj_xyz',
      state: 'RUN_STARTED',
      issuedAt: Date.now(),
      taskId: 'task_1',
    });
    expect(ok.success).toBe(true);
  });

  it('rejects an unknown state', () => {
    const bad = execStateTokenPayloadSchema.safeParse({
      v: 1,
      runId: 'run_abc',
      projectId: 'proj_xyz',
      state: 'WAT',
      issuedAt: 0,
    });
    expect(bad.success).toBe(false);
  });

  it('rejects v != 1 so the schema can be rotated later', () => {
    const bad = execStateTokenPayloadSchema.safeParse({
      v: 2,
      runId: 'run_abc',
      projectId: 'proj_xyz',
      state: 'RUN_STARTED',
      issuedAt: 0,
    });
    expect(bad.success).toBe(false);
  });

  it('requires non-empty runId / projectId', () => {
    const bad = execStateTokenPayloadSchema.safeParse({
      v: 1,
      runId: '',
      projectId: 'proj_xyz',
      state: 'RUN_STARTED',
      issuedAt: 0,
    });
    expect(bad.success).toBe(false);
  });

  it('rejects negative or non-integer issuedAt', () => {
    expect(
      execStateTokenPayloadSchema.safeParse({
        v: 1,
        runId: 'run_abc',
        projectId: 'proj_xyz',
        state: 'RUN_STARTED',
        issuedAt: -1,
      }).success,
    ).toBe(false);
    expect(
      execStateTokenPayloadSchema.safeParse({
        v: 1,
        runId: 'run_abc',
        projectId: 'proj_xyz',
        state: 'RUN_STARTED',
        issuedAt: 1.5,
      }).success,
    ).toBe(false);
  });

  it('exposes a finite token max age in milliseconds', () => {
    expect(EXEC_STATE_TOKEN_MAX_AGE_MS).toBeGreaterThan(0);
    expect(Number.isFinite(EXEC_STATE_TOKEN_MAX_AGE_MS)).toBe(true);
  });
});
