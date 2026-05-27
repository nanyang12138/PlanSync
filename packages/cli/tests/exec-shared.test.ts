/**
 * Tests for R-062: shared exec-mode helpers used by BOTH `/exec` (CLI) and
 * `bin/plansync --exec` (shell entry point). Verifies that both entry points
 * produce identical prompts, MCP env, and drift-gate behaviour.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveExecAssignee,
  buildExecPrompt,
  buildExecMcpEnv,
  buildExecMcpConfigJson,
  openDriftAlerts,
} from '../src/exec-shared.mjs';

describe('resolveExecAssignee (R-062 shared helper)', () => {
  it('still allows an agent-assigned task (back-compat with R-060)', () => {
    const out = resolveExecAssignee({ assignee: 'bot-a', assigneeType: 'agent' }, 'alice');
    expect(out).toEqual({ ok: true, executorType: 'agent', executorName: 'bot-a' });
  });

  it('still allows human assignee matching current user', () => {
    const out = resolveExecAssignee({ assignee: 'alice', assigneeType: 'human' }, 'alice');
    expect(out).toEqual({ ok: true, executorType: 'human', executorName: 'alice' });
  });

  it('rejects a human-assigned task when assignee differs from current user', () => {
    const out = resolveExecAssignee({ assignee: 'bob', assigneeType: 'human' }, 'alice');
    expect(out.ok).toBe(false);
  });
});

describe('openDriftAlerts (R-062 shared helper)', () => {
  it('returns only alerts with status === "open"', () => {
    const pack = {
      driftAlerts: [
        { status: 'open', reason: 'plan v2 changed scope' },
        { status: 'resolved', reason: 'rebound earlier' },
        { status: 'open', reason: 'deliverable removed' },
      ],
    };
    const out = openDriftAlerts(pack);
    expect(out).toHaveLength(2);
    expect(out.every((a) => a.status === 'open')).toBe(true);
  });

  it('returns [] for missing / malformed driftAlerts', () => {
    expect(openDriftAlerts(null)).toEqual([]);
    expect(openDriftAlerts(undefined)).toEqual([]);
    expect(openDriftAlerts({})).toEqual([]);
    expect(openDriftAlerts({ driftAlerts: 'not-an-array' })).toEqual([]);
  });
});

describe('buildExecPrompt (R-062 shared prompt)', () => {
  it('embeds the taskId verbatim', () => {
    const prompt = buildExecPrompt({ taskId: 'task-abc', taskPack: {} });
    expect(prompt).toContain('task-abc');
  });

  it('tells the LLM the run is pre-registered (no execution_start)', () => {
    const prompt = buildExecPrompt({ taskId: 't1', taskPack: {} });
    expect(prompt).toMatch(/Do NOT call plansync_execution_start/);
    expect(prompt).toMatch(/PLANSYNC_EXEC_RUN_ID/);
    expect(prompt).toMatch(/plansync_exec_context/);
  });

  // R-204 / fix #1436: the previous prompt told the LLM to call the
  // deprecated `plansync_execution_complete` alias. Once that alias is
  // removed the prompt would silently leave runs hanging forever. Lock the
  // prompt to the unified `plansync_run({action:"complete", ...})` surface
  // and forbid the bare legacy call site from re-introducing itself as a
  // positive instruction.
  it('instructs the LLM to complete via plansync_run({action:"complete"}), not the deprecated alias', () => {
    const prompt = buildExecPrompt({ taskId: 't1', taskPack: {} });
    expect(prompt).toMatch(/plansync_run/);
    expect(prompt).toMatch(/action="complete"/);
    // Permit the prompt to *mention* the legacy name (to warn the LLM
    // that it's deprecated) but disallow a positive "call X" directive.
    expect(prompt).not.toMatch(/call plansync_execution_complete/);
    expect(prompt).not.toMatch(/then call plansync_execution_complete/);
  });

  it('forbids plan_create / plan_propose / plan_activate / plan_reactivate', () => {
    const prompt = buildExecPrompt({ taskId: 't1', taskPack: {} });
    expect(prompt).toMatch(/plansync_plan_create/);
    expect(prompt).toMatch(/plansync_plan_propose/);
    expect(prompt).toMatch(/plansync_plan_activate/);
    expect(prompt).toMatch(/plansync_plan_reactivate/);
  });

  it('includes the task pack as JSON', () => {
    const pack = { task: { id: 't1', title: 'do thing' } };
    const prompt = buildExecPrompt({ taskId: 't1', taskPack: pack });
    expect(prompt).toContain('"title": "do thing"');
  });
});

describe('buildExecMcpEnv (R-062 shared MCP env)', () => {
  it('produces the full exec env block', () => {
    const out = buildExecMcpEnv({
      runId: 'run-1',
      taskId: 'task-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      apiUrl: 'http://api.test',
      apiKey: 'k',
      user: 'alice',
      secret: 'sek',
    });
    expect(out).toEqual({
      PLANSYNC_API_URL: 'http://api.test',
      PLANSYNC_API_KEY: 'k',
      PLANSYNC_USER: 'alice',
      PLANSYNC_SECRET: 'sek',
      PLANSYNC_PROJECT: 'proj-1',
      PLANSYNC_EXEC_RUN_ID: 'run-1',
      PLANSYNC_EXEC_TASK_ID: 'task-1',
      PLANSYNC_EXEC_SESSION_ID: 'sess-1',
      LOG_LEVEL: 'warn',
    });
  });

  it('defaults apiUrl when not provided', () => {
    const out = buildExecMcpEnv({
      runId: 'r',
      taskId: 't',
      projectId: 'p',
      sessionId: 's',
    });
    expect(out.PLANSYNC_API_URL).toBe('http://localhost:3001');
    expect(out.PLANSYNC_API_KEY).toBe('');
    expect(out.PLANSYNC_USER).toBe('');
    expect(out.LOG_LEVEL).toBe('warn');
  });
});

describe('buildExecMcpConfigJson (R-062 shared MCP config)', () => {
  it('wraps the env in the claude-code --mcp-config structure', () => {
    const json = buildExecMcpConfigJson({
      runId: 'r',
      taskId: 't',
      projectId: 'p',
      sessionId: 's',
      localNodeBin: '/usr/bin/node',
      mcpServerDist: '/opt/mcp.js',
      apiUrl: 'http://api',
      apiKey: 'k',
      user: 'alice',
    });
    const parsed = JSON.parse(json);
    expect(parsed.mcpServers.plansync.command).toBe('/usr/bin/node');
    expect(parsed.mcpServers.plansync.args).toEqual(['/opt/mcp.js']);
    expect(parsed.mcpServers.plansync.env.PLANSYNC_EXEC_RUN_ID).toBe('r');
    expect(parsed.mcpServers.plansync.env.PLANSYNC_EXEC_TASK_ID).toBe('t');
    expect(parsed.mcpServers.plansync.env.PLANSYNC_EXEC_SESSION_ID).toBe('s');
    expect(parsed.mcpServers.plansync.env.PLANSYNC_PROJECT).toBe('p');
    expect(parsed.mcpServers.plansync.env.PLANSYNC_API_KEY).toBe('k');
  });
});
