/**
 * R-142: MCP `execution_aborted` is now a protocol-level error.
 *
 * Once the API tells the heartbeat that the run is paused / stale / race-lost
 * and `signalRunAborted` latches the process-wide abort flag, every
 * subsequent tool call must short-circuit with
 * `{ isError: true, error.code: 'RUN_ABORTED' }` so generic MCP clients
 * cannot keep dispatching tools after the soft `sendLoggingMessage` hint.
 *
 * The rollback escape hatch — `PLANSYNC_MCP_LEGACY_ABORT=true` — reverts to
 * pre-R-142 behaviour where the abort latch does NOT block tool calls
 * (operators use it for emergency triage only).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { evaluatePreflight, isLegacyAbortEnabled, wrapToolHandler } from '../src/tool-wrapper';
import { _resetRunAbortedForTests, signalRunAborted } from '../src/abort-signal';

const baseOptions = {
  delegationAllowed: new Set<string>(['plansync_any_tool']),
  getDelegationAgent: () => undefined as string | undefined,
};

beforeEach(() => {
  _resetRunAbortedForTests();
  delete process.env.PLANSYNC_MCP_LEGACY_ABORT;
});

afterEach(() => {
  delete process.env.PLANSYNC_MCP_LEGACY_ABORT;
});

describe('R-142: RUN_ABORTED short-circuits every subsequent tool call', () => {
  it('returns isError + code=RUN_ABORTED on the very next call after abort', async () => {
    signalRunAborted({
      code: 'RUN_STALE_VERSION',
      message: 'Plan v2 active; run was bound to v1',
      runId: 'run_x',
      taskId: 'task_y',
      runBoundPlanVersion: 1,
      taskBoundPlanVersion: 2,
    });

    const handler = async () => ({
      content: [{ type: 'text', text: 'should never run' }],
    });
    const wrapped = wrapToolHandler('plansync_task_show', handler, baseOptions);
    const out = (await wrapped({})) as {
      isError: boolean;
      content: Array<{ text: string }>;
    };

    expect(out.isError).toBe(true);
    const payload = JSON.parse(out.content[0].text);
    expect(payload.error.code).toBe('RUN_ABORTED');
    expect(payload.error.abortCode).toBe('RUN_STALE_VERSION');
    expect(payload.error.runId).toBe('run_x');
    expect(payload.error.taskId).toBe('task_y');
    expect(payload.error.guidance).toMatch(/Do NOT call any more PlanSync tools/i);
  });

  it('keeps short-circuiting on a second, third, … call (latch is sticky)', async () => {
    signalRunAborted({ code: 'RUN_PAUSED', message: 'paused', runId: 'r1' });

    const handler = async () => ({ content: [{ type: 'text', text: 'nope' }] });
    const a = wrapToolHandler('plansync_task_list', handler, baseOptions);
    const b = wrapToolHandler('plansync_status', handler, baseOptions);

    for (const w of [a, b, a, b]) {
      const out = (await w({})) as {
        isError: boolean;
        content: Array<{ text: string }>;
      };
      expect(out.isError).toBe(true);
      expect(JSON.parse(out.content[0].text).error.code).toBe('RUN_ABORTED');
    }
  });
});

describe('R-142 rollback: PLANSYNC_MCP_LEGACY_ABORT bypasses the gate', () => {
  it('isLegacyAbortEnabled defaults to false', () => {
    expect(isLegacyAbortEnabled({})).toBe(false);
    expect(isLegacyAbortEnabled({ PLANSYNC_MCP_LEGACY_ABORT: '' })).toBe(false);
    expect(isLegacyAbortEnabled({ PLANSYNC_MCP_LEGACY_ABORT: 'false' })).toBe(false);
    expect(isLegacyAbortEnabled({ PLANSYNC_MCP_LEGACY_ABORT: '0' })).toBe(false);
  });

  it('isLegacyAbortEnabled accepts the canonical truthy strings', () => {
    expect(isLegacyAbortEnabled({ PLANSYNC_MCP_LEGACY_ABORT: 'true' })).toBe(true);
    expect(isLegacyAbortEnabled({ PLANSYNC_MCP_LEGACY_ABORT: 'TRUE' })).toBe(true);
    expect(isLegacyAbortEnabled({ PLANSYNC_MCP_LEGACY_ABORT: '1' })).toBe(true);
    expect(isLegacyAbortEnabled({ PLANSYNC_MCP_LEGACY_ABORT: 'yes' })).toBe(true);
    expect(isLegacyAbortEnabled({ PLANSYNC_MCP_LEGACY_ABORT: '  true  ' })).toBe(true);
  });

  it('with legacy flag set, an aborted run does NOT block tool calls', async () => {
    process.env.PLANSYNC_MCP_LEGACY_ABORT = 'true';
    signalRunAborted({ code: 'RUN_PAUSED', message: 'paused', runId: 'r1' });

    const handler = async () => ({
      content: [{ type: 'text', text: 'legacy: handler ran' }],
    });
    const wrapped = wrapToolHandler('plansync_task_show', handler, baseOptions);
    const out = await wrapped({});

    expect(out).toEqual({ content: [{ type: 'text', text: 'legacy: handler ran' }] });
  });

  it('legacy flag also keeps evaluatePreflight in "allow"', () => {
    process.env.PLANSYNC_MCP_LEGACY_ABORT = '1';
    signalRunAborted({ code: 'RUN_PAUSED', message: 'paused' });

    const result = evaluatePreflight('plansync_task_list', baseOptions);
    expect(result.kind).toBe('allow');
  });
});
