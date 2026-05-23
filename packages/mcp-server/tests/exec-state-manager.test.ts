/**
 * R-171: ExecStateManager unit tests.
 *
 * Covers:
 *   - off / shadow / enforce mode behaviour for an illegal sequence
 *   - legal sequence walks UNINITIALIZED → CONTEXT_LOADED → PACK_FETCHED →
 *     RUN_STARTED → COMPLETED with no false negatives
 *   - read-only tools allowed from any state (even terminal)
 *   - newToken minted only when secret + runId + projectId are bound
 *   - bindRun rebinds run identity for token minting
 *   - readEnforceMode tolerates typos / case
 *   - terminal-state rejection of follow-up writes
 */
import { describe, expect, it } from 'vitest';
import {
  ExecStateManager,
  buildOutOfSequenceEnvelope,
  readEnforceMode,
} from '../src/exec-state-manager';
import { verifyExecStateToken } from '../src/exec-state-token';

const SECRET = 'mgr-test-secret-XXXXXXXXXXXXXXXXXXXXXX';

function legalSequence(mgr: ExecStateManager) {
  return [
    mgr.recordToolCall('plansync_exec_context'),
    mgr.recordToolCall('plansync_task_pack'),
    mgr.recordToolCall('plansync_execution_start'),
    mgr.recordToolCall('plansync_execution_heartbeat'),
    mgr.recordToolCall('plansync_execution_complete'),
  ];
}

describe('R-171 ExecStateManager: readEnforceMode', () => {
  it('defaults to off when env var is missing', () => {
    expect(readEnforceMode({})).toBe('off');
  });
  it('returns off for unknown values (defensive default)', () => {
    expect(readEnforceMode({ PLANSYNC_EXEC_STATE_ENFORCE: 'bogus' })).toBe('off');
    expect(readEnforceMode({ PLANSYNC_EXEC_STATE_ENFORCE: '' })).toBe('off');
  });
  it('accepts shadow / enforce case-insensitively with trimming', () => {
    expect(readEnforceMode({ PLANSYNC_EXEC_STATE_ENFORCE: '  shadow  ' })).toBe('shadow');
    expect(readEnforceMode({ PLANSYNC_EXEC_STATE_ENFORCE: 'ENFORCE' })).toBe('enforce');
  });
});

describe('R-171 ExecStateManager: legal sequence (any mode)', () => {
  for (const mode of ['off', 'shadow', 'enforce'] as const) {
    it(`walks the full FSM in ${mode} mode without rejection`, () => {
      const mgr = new ExecStateManager({ enforceMode: mode });
      const results = legalSequence(mgr);
      for (const r of results) expect(r.ok).toBe(true);
      expect(mgr.getState()).toBe('COMPLETED');
    });
  }
});

describe('R-171 ExecStateManager: illegal sequence', () => {
  it('off mode: silently allows + does not advance state', () => {
    const mgr = new ExecStateManager({ enforceMode: 'off' });
    // Skip exec_context, try task_pack directly.
    const r = mgr.recordToolCall('plansync_task_pack');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.advanced).toBe(false);
      expect(r.state).toBe('UNINITIALIZED');
    }
  });

  it('shadow mode: allows + reports shadowViolation + does not advance', () => {
    const mgr = new ExecStateManager({ enforceMode: 'shadow' });
    const r = mgr.recordToolCall('plansync_task_pack');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.shadowViolation).toBe(true);
      expect(r.state).toBe('UNINITIALIZED');
    }
  });

  it('enforce mode: rejects with structured OUT_OF_SEQUENCE envelope', () => {
    const mgr = new ExecStateManager({ enforceMode: 'enforce' });
    const r = mgr.recordToolCall('plansync_execution_complete');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.envelope.isError).toBe(true);
      const payload = JSON.parse(r.envelope.content[0].text);
      expect(payload.error.code).toBe('OUT_OF_SEQUENCE');
      expect(payload.error.currentState).toBe('UNINITIALIZED');
      expect(payload.error.requiredNextOneOf).toContain('plansync_exec_context');
      expect(payload.error.hint).toMatch(/plansync_exec_context/);
      expect(r.state).toBe('UNINITIALIZED');
    }
  });
});

describe('R-171 ExecStateManager: read-only tools', () => {
  it('allowed from UNINITIALIZED in enforce mode without advancing state', () => {
    const mgr = new ExecStateManager({ enforceMode: 'enforce' });
    const r = mgr.recordToolCall('plansync_status');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.advanced).toBe(false);
      expect(r.state).toBe('UNINITIALIZED');
    }
  });

  it('allowed from terminal COMPLETED state in enforce mode', () => {
    const mgr = new ExecStateManager({ enforceMode: 'enforce' });
    legalSequence(mgr);
    expect(mgr.getState()).toBe('COMPLETED');
    const r = mgr.recordToolCall('plansync_plan_show');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state).toBe('COMPLETED');
  });
});

describe('R-171 ExecStateManager: terminal state rejects writes in enforce mode', () => {
  it('rejects any write attempt after COMPLETED', () => {
    const mgr = new ExecStateManager({ enforceMode: 'enforce' });
    legalSequence(mgr);
    expect(mgr.getState()).toBe('COMPLETED');
    const r = mgr.recordToolCall('plansync_execution_start');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const payload = JSON.parse(r.envelope.content[0].text);
      expect(payload.error.code).toBe('OUT_OF_SEQUENCE');
      expect(payload.error.currentState).toBe('COMPLETED');
      // No nextRequired available from a terminal state.
      expect(payload.error.requiredNextOneOf).toEqual([]);
      expect(payload.error.hint).toMatch(/terminal/);
    }
  });
});

describe('R-171 ExecStateManager: token minting', () => {
  it('does not mint a token when secret is missing', () => {
    const mgr = new ExecStateManager({
      enforceMode: 'enforce',
      runId: 'run_x',
      projectId: 'proj_x',
    });
    const r = mgr.recordToolCall('plansync_exec_context');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newToken).toBeUndefined();
  });

  it('does not mint a token when runId is missing', () => {
    const mgr = new ExecStateManager({ enforceMode: 'enforce', secret: SECRET });
    const r = mgr.recordToolCall('plansync_exec_context');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newToken).toBeUndefined();
  });

  it('mints a verifiable token once secret + runId + projectId are bound', () => {
    const NOW = 1_700_000_000_000;
    const mgr = new ExecStateManager({
      enforceMode: 'enforce',
      secret: SECRET,
      runId: 'run_t1',
      projectId: 'proj_t1',
      taskId: 'task_t1',
      nowMs: () => NOW,
    });
    const r = mgr.recordToolCall('plansync_exec_context');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(typeof r.newToken).toBe('string');
      const verified = verifyExecStateToken(r.newToken!, SECRET, NOW + 1);
      expect(verified.ok).toBe(true);
      if (verified.ok) {
        expect(verified.payload.runId).toBe('run_t1');
        expect(verified.payload.projectId).toBe('proj_t1');
        expect(verified.payload.taskId).toBe('task_t1');
        expect(verified.payload.state).toBe('CONTEXT_LOADED');
        expect(verified.payload.issuedAt).toBe(NOW);
      }
    }
  });

  it('bindRun rebinds the token identity', () => {
    const NOW = 1_700_000_000_000;
    const mgr = new ExecStateManager({
      enforceMode: 'enforce',
      secret: SECRET,
      nowMs: () => NOW,
    });
    // First step issues no token (no runId yet).
    const r1 = mgr.recordToolCall('plansync_exec_context');
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.newToken).toBeUndefined();
    // Bind run identity (typical: after exec_context returns the runId).
    mgr.bindRun({ runId: 'run_late', projectId: 'proj_late' });
    const r2 = mgr.recordToolCall('plansync_task_pack');
    expect(r2.ok).toBe(true);
    if (r2.ok && r2.newToken) {
      const v = verifyExecStateToken(r2.newToken, SECRET, NOW + 1);
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.payload.runId).toBe('run_late');
    }
  });
});

describe('R-171 ExecStateManager: buildOutOfSequenceEnvelope shape', () => {
  it('contains the exact fields documented in docs/PROTOCOL.md', () => {
    const env = buildOutOfSequenceEnvelope('plansync_execution_complete', 'PACK_FETCHED');
    expect(env.isError).toBe(true);
    const payload = JSON.parse(env.content[0].text);
    expect(payload.error).toMatchObject({
      code: 'OUT_OF_SEQUENCE',
      currentState: 'PACK_FETCHED',
    });
    expect(payload.error.allowedTools).toContain('plansync_execution_start');
    expect(payload.error.requiredNextOneOf).toEqual(['plansync_execution_start']);
    expect(payload.error.message).toMatch(/PACK_FETCHED/);
  });
});
