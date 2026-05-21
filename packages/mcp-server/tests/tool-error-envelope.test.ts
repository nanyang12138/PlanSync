// R-037: MCP tool wrapper unifies error format. A tool that throws an
// ApiError (or any Error) must return a structured envelope with
// `isError: true`, so clients can detect failure reliably.
import { describe, it, expect, beforeEach } from 'vitest';
import { ApiError } from '../src/api-client';
import {
  buildAbortEnvelope,
  buildDelegationEnvelope,
  buildErrorEnvelope,
  wrapToolHandler,
  patchServerToolRegistration,
  evaluatePreflight,
} from '../src/tool-wrapper';
import { _resetRunAbortedForTests, signalRunAborted } from '../src/abort-signal';

const baseOptions = {
  delegationAllowed: new Set<string>(['plansync_safe_tool']),
  getDelegationAgent: () => undefined as string | undefined,
};

describe('R-037: tool error envelope', () => {
  beforeEach(() => {
    _resetRunAbortedForTests();
  });

  describe('buildErrorEnvelope', () => {
    it('translates ApiError into a structured `isError` envelope', () => {
      const err = new ApiError('Plan not found', 'NOT_FOUND', 404, { planId: 'pl_missing' });
      const env = buildErrorEnvelope(err, 'plansync_plan_show');

      expect(env.isError).toBe(true);
      expect(env.content).toHaveLength(1);
      expect(env.content[0].type).toBe('text');

      const payload = JSON.parse(env.content[0].text);
      expect(payload.error).toMatchObject({
        code: 'NOT_FOUND',
        message: 'Plan not found',
        status: 404,
        details: { planId: 'pl_missing' },
        tool: 'plansync_plan_show',
      });
    });

    it('translates non-ApiError into INTERNAL envelope', () => {
      const err = new Error('boom');
      const env = buildErrorEnvelope(err, 'plansync_task_show');

      expect(env.isError).toBe(true);
      const payload = JSON.parse(env.content[0].text);
      expect(payload.error.code).toBe('INTERNAL');
      expect(payload.error.message).toBe('boom');
      expect(payload.error.tool).toBe('plansync_task_show');
    });

    it('handles non-Error thrown values (string)', () => {
      const env = buildErrorEnvelope('not-an-error-instance', 'plansync_test_tool');
      expect(env.isError).toBe(true);
      const payload = JSON.parse(env.content[0].text);
      expect(payload.error.code).toBe('INTERNAL');
      expect(payload.error.message).toBe('not-an-error-instance');
    });
  });

  describe('buildAbortEnvelope', () => {
    it('emits RUN_ABORTED with abortCode + guidance', () => {
      const env = buildAbortEnvelope({
        code: 'RUN_STALE_VERSION',
        message: 'Plan v2 active; run was bound to v1',
        runId: 'run_1',
        taskId: 'task_1',
      });

      expect(env.isError).toBe(true);
      const payload = JSON.parse(env.content[0].text);
      expect(payload.error.code).toBe('RUN_ABORTED');
      expect(payload.error.abortCode).toBe('RUN_STALE_VERSION');
      expect(payload.error.guidance).toMatch(/drift v2/);
      expect(payload.error.runId).toBe('run_1');
    });
  });

  describe('buildDelegationEnvelope', () => {
    it('is NOT marked isError (deliberate policy block, not internal failure)', () => {
      const env = buildDelegationEnvelope('genie', 'plansync_plan_create');
      expect('isError' in env).toBe(false);
      const payload = JSON.parse(env.content[0].text);
      expect(payload.error).toBe('DELEGATION_BLOCKED');
      expect(payload.message).toContain('genie');
      expect(payload.message).toContain('plansync_plan_create');
    });
  });

  describe('wrapToolHandler', () => {
    it('returns handler result on success unchanged', async () => {
      const handler = async () => ({
        content: [{ type: 'text', text: 'ok' }],
      });
      const wrapped = wrapToolHandler('plansync_safe_tool', handler, baseOptions);
      const out = await wrapped({});
      expect(out).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    });

    it('catches a thrown ApiError and returns isError envelope', async () => {
      const handler = async () => {
        throw new ApiError('Forbidden', 'FORBIDDEN', 403);
      };
      const wrapped = wrapToolHandler('plansync_plan_update', handler, baseOptions);
      const out = (await wrapped({})) as { isError: boolean; content: Array<{ text: string }> };
      expect(out.isError).toBe(true);
      const payload = JSON.parse(out.content[0].text);
      expect(payload.error.code).toBe('FORBIDDEN');
      expect(payload.error.status).toBe(403);
      expect(payload.error.tool).toBe('plansync_plan_update');
    });

    it('catches a thrown Error and returns INTERNAL envelope', async () => {
      const handler = async () => {
        throw new Error('unexpected');
      };
      const wrapped = wrapToolHandler('plansync_anything', handler, baseOptions);
      const out = (await wrapped({})) as { isError: boolean; content: Array<{ text: string }> };
      expect(out.isError).toBe(true);
      const payload = JSON.parse(out.content[0].text);
      expect(payload.error.code).toBe('INTERNAL');
      expect(payload.error.message).toBe('unexpected');
    });

    it('short-circuits with RUN_ABORTED envelope when the run is aborted', async () => {
      signalRunAborted({
        code: 'RUN_PAUSED',
        message: 'Drift detected — pausing',
        runId: 'run_x',
      });

      const handler = async () => ({ content: [{ type: 'text', text: 'should not run' }] });
      const wrapped = wrapToolHandler('plansync_task_show', handler, baseOptions);
      const out = (await wrapped({})) as { isError: boolean; content: Array<{ text: string }> };

      expect(out.isError).toBe(true);
      const payload = JSON.parse(out.content[0].text);
      expect(payload.error.code).toBe('RUN_ABORTED');
      expect(payload.error.abortCode).toBe('RUN_PAUSED');
    });

    it('short-circuits with DELEGATION_BLOCKED for tools not in delegation allowlist', async () => {
      const handler = async () => ({ content: [{ type: 'text', text: 'should not run' }] });
      const wrapped = wrapToolHandler('plansync_blocked_tool', handler, {
        ...baseOptions,
        getDelegationAgent: () => 'genie',
      });
      const out = (await wrapped({})) as { isError?: boolean; content: Array<{ text: string }> };
      expect(out.isError).toBeFalsy();
      const payload = JSON.parse(out.content[0].text);
      expect(payload.error).toBe('DELEGATION_BLOCKED');
    });

    it('allows delegation-listed tools to proceed when delegation is active', async () => {
      const handler = async () => ({ content: [{ type: 'text', text: 'ran' }] });
      const wrapped = wrapToolHandler('plansync_safe_tool', handler, {
        ...baseOptions,
        getDelegationAgent: () => 'genie',
      });
      const out = await wrapped({});
      expect(out).toEqual({ content: [{ type: 'text', text: 'ran' }] });
    });
  });

  describe('evaluatePreflight', () => {
    it('returns allow when no abort and no delegation', () => {
      expect(evaluatePreflight('any_tool', baseOptions).kind).toBe('allow');
    });

    it('prefers abort over delegation check', () => {
      signalRunAborted({ code: 'MANUAL', message: 'manual stop' });
      const result = evaluatePreflight('plansync_blocked_tool', {
        ...baseOptions,
        getDelegationAgent: () => 'genie',
      });
      expect(result.kind).toBe('short-circuit');
      if (result.kind === 'short-circuit') {
        const payload = JSON.parse(result.response.content[0].text);
        expect(payload.error.code ?? payload.error).toBe('RUN_ABORTED');
      }
    });
  });

  describe('patchServerToolRegistration', () => {
    it('skips registration entirely for tools not in execAllowed', () => {
      const calls: Array<{ name: string }> = [];
      const fakeServer = {
        tool: (name: string, ..._rest: unknown[]) => {
          calls.push({ name });
        },
      };
      patchServerToolRegistration(fakeServer, {
        execAllowed: new Set(['plansync_allowed_only']),
        delegationAllowed: new Set(),
        getDelegationAgent: () => undefined,
      });

      fakeServer.tool('plansync_allowed_only', 'desc', {}, async () => ({
        content: [{ type: 'text', text: 'ok' }],
      }));
      fakeServer.tool('plansync_blocked', 'desc', {}, async () => ({
        content: [{ type: 'text', text: 'never' }],
      }));

      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('plansync_allowed_only');
    });

    it('wraps registered handlers so thrown ApiError becomes isError envelope', async () => {
      let wrappedHandler: ((args: unknown) => Promise<unknown>) | undefined;
      const fakeServer = {
        tool: (_name: string, _desc: unknown, _schema: unknown, handler: unknown) => {
          wrappedHandler = handler as (args: unknown) => Promise<unknown>;
        },
      };
      patchServerToolRegistration(fakeServer, {
        delegationAllowed: new Set(),
        getDelegationAgent: () => undefined,
      });

      fakeServer.tool('plansync_demo', 'desc', {}, async () => {
        throw new ApiError('nope', 'STATE_CONFLICT', 409, { reason: 'gated' });
      });

      expect(wrappedHandler).toBeDefined();
      const out = (await wrappedHandler!({})) as {
        isError: boolean;
        content: Array<{ text: string }>;
      };
      expect(out.isError).toBe(true);
      const payload = JSON.parse(out.content[0].text);
      expect(payload.error.code).toBe('STATE_CONFLICT');
      expect(payload.error.details).toEqual({ reason: 'gated' });
    });
  });
});
