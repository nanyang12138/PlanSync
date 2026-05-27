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

  it('terminal states only accept plansync_exec_context to start the next session (P0-14)', () => {
    // Closes #765-class — previously the terminal states had empty
    // allowedTools, which blocked the documented "open a new exec_context
    // for the next task" recovery path. They now accept exactly one
    // tool (plansync_exec_context) which transitions back to
    // CONTEXT_LOADED so the next /exec session can proceed.
    for (const state of TERMINAL_STATES) {
      const node = EXEC_STATE_MACHINE[state];
      expect(node.allowedTools).toEqual(['plansync_exec_context']);
      expect(node.requiredNextOneOf).toEqual(['plansync_exec_context']);
      expect(node.transitions).toEqual({ plansync_exec_context: 'CONTEXT_LOADED' });
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
    // P0-14: plansync_execution_abort is NOT a real MCP tool (not in
    // EXEC_ALLOWED in mcp-server/src/index.ts). We removed it from
    // RUN_STARTED.allowedTools — early exit goes through
    // plansync_execution_complete with status='cancelled'/'failed'.
    expect(tools).not.toContain('plansync_execution_abort');
    // P0-14: comment_edit / comment_delete ARE in the exec-mode
    // whitelist (EXEC_ALLOWED) and should be reachable from
    // PACK_FETCHED + RUN_STARTED.
    expect(tools).toContain('plansync_comment_edit');
    expect(tools).toContain('plansync_comment_delete');
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

  it('rejects plansync_execution_abort because the tool does not exist (P0-14)', () => {
    // Closes #765-class — the FSM previously declared
    // plansync_execution_abort as a transition out of RUN_STARTED, but
    // mcp-server does not register such a tool. Calling it produced an
    // OUT_OF_SEQUENCE-shaped lie; now it correctly fails with
    // OUT_OF_SEQUENCE because the tool is genuinely unknown.
    const r = checkTransition('RUN_STARTED', 'plansync_execution_abort');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(OUT_OF_SEQUENCE);
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

  it('accepts plansync_execution_complete from PACK_FETCHED (the /exec collapse path, P0-14)', () => {
    // Closes #765-class — /exec sub-sessions get a pre-registered
    // run from plansync_exec_context. The agent then reads the task
    // pack and is supposed to call plansync_execution_complete
    // directly, with no separate plansync_execution_start. Without
    // this transition the FSM rejected the legitimate /exec flow.
    const r = checkTransition('PACK_FETCHED', 'plansync_execution_complete');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nextState).toBe('COMPLETED');
  });

  // R6 / closes #957 #941: /exec parents that bake the task pack into
  // the agent prompt (so the sub-agent never makes a task_pack MCP
  // call) must be allowed to go CONTEXT_LOADED → COMPLETED directly.
  it('accepts plansync_execution_complete from CONTEXT_LOADED (R6 / closes #957 #941)', () => {
    const r = checkTransition('CONTEXT_LOADED', 'plansync_execution_complete');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nextState).toBe('COMPLETED');
  });

  it('rejects gated WRITE tools once the run is COMPLETED but allows plansync_exec_context (P0-14)', () => {
    for (const t of [
      'plansync_execution_heartbeat',
      'plansync_execution_complete',
      'plansync_task_pack',
      'plansync_execution_start',
    ]) {
      const r = checkTransition('COMPLETED', t);
      expect(r.ok, `expected ${t} from COMPLETED to fail`).toBe(false);
    }
    // ...but exec_context restarts the session.
    const restart = checkTransition('COMPLETED', 'plansync_exec_context');
    expect(restart.ok).toBe(true);
    if (restart.ok) expect(restart.nextState).toBe('CONTEXT_LOADED');
  });

  it('rejects gated WRITE tools once the run is ABORTED but allows plansync_exec_context', () => {
    const heartbeat = checkTransition('ABORTED', 'plansync_execution_heartbeat');
    expect(heartbeat.ok).toBe(false);
    const restart = checkTransition('ABORTED', 'plansync_exec_context');
    expect(restart.ok).toBe(true);
    if (restart.ok) expect(restart.nextState).toBe('CONTEXT_LOADED');
  });

  // Closes #765-class — comment_edit / comment_delete were in
  // EXEC_ALLOWED but not in the FSM. Legit edits / deletes during
  // PACK_FETCHED + RUN_STARTED used to be rejected.
  it('accepts comment_edit / comment_delete from PACK_FETCHED + RUN_STARTED (P0-14)', () => {
    for (const state of ['PACK_FETCHED', 'RUN_STARTED'] as const) {
      for (const tool of ['plansync_comment_edit', 'plansync_comment_delete']) {
        const r = checkTransition(state, tool);
        expect(r.ok, `${tool} from ${state} should be allowed`).toBe(true);
        if (r.ok) expect(r.nextState).toBe(state);
      }
    }
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

  // Closes #1145 — R-155 added plansync_deliverable_list / _show to the
  // mcp-server EXEC_ALLOWED + DELEGATION_ALLOWED whitelists but missed
  // READ_ONLY_TOOLS, so PLANSYNC_EXEC_STATE_ENFORCE=enforce sessions had
  // these GET-only tools blocked with OUT_OF_SEQUENCE the moment an
  // agent inspected structured deliverables.
  it('treats plansync_deliverable_list / _show as read-only from every state (#1145)', () => {
    for (const tool of ['plansync_deliverable_list', 'plansync_deliverable_show']) {
      expect(READ_ONLY_TOOLS).toContain(tool);
      for (const state of EXEC_STATES) {
        const r = checkTransition(state, tool);
        expect(r.ok, `${tool} should be allowed from ${state}`).toBe(true);
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
