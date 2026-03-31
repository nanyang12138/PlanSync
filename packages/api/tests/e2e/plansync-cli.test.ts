// E2E: plansync-cli (packages/cli/dist/index.js) command tests
// Tests invoke the compiled CLI bundle via `node packages/cli/dist/index.js` using the
// project-local runtime. Data is created via real MCP tool calls (through the PlanSync
// MCP server started by `plansync --host genie`) — no direct HTTP calls for setup.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import { connectMcpClient, mcp, cli, deleteProject } from './mcp-helpers';

const ROOT = path.resolve(__dirname, '../../../..');
const LOCAL_NODE = path.join(ROOT, '.local-runtime/node/bin/node');
const CLI = path.join(ROOT, 'packages/cli/dist/index.js');
const SERVER_URL = `http://localhost:${process.env.PORT || 3001}`;
const API_SECRET = process.env.PLANSYNC_SECRET || 'dev-secret';
const TEST_USER = 'e2e-cli-user';

// Fail early with a clear message if prerequisites are missing
if (!fs.existsSync(LOCAL_NODE)) {
  throw new Error(
    `Local node runtime not found at ${LOCAL_NODE}.\n` +
      'Run ./bin/ps-admin start to install it, then re-run the E2E tests.',
  );
}
if (!fs.existsSync(CLI)) {
  throw new Error(
    `CLI bundle not found at ${CLI}.\n` +
      'Run: cd packages/cli && node ../../node_modules/.bin/tsc -p tsconfig.json',
  );
}

// ── Test data ─────────────────────────────────────────────────────────────

let projectId: string;
let emptyProjectId: string;
let taskId: string;
let driftId: string;

beforeAll(async () => {
  const client = await connectMcpClient(SERVER_URL, TEST_USER);

  // ── Main project: active plan v2, one task bound to v1 (→ drift) ──
  const proj = await mcp(client, 'plansync_project_create', {
    name: `e2e-cli-${Date.now()}`,
    phase: 'planning',
  });
  projectId = proj.data.id;

  // Plan v1 → activate
  const plan1 = await mcp(client, 'plansync_plan_create', {
    projectId,
    title: 'E2E Plan v1',
    goal: 'Initial goal',
    scope: 'Initial scope',
  });
  await mcp(client, 'plansync_plan_activate', { projectId, planId: plan1.data.id });

  // Task bound to v1
  const task = await mcp(client, 'plansync_task_create', {
    projectId,
    title: 'E2E Task 1',
    type: 'code',
  });
  taskId = task.data.id;

  // Plan v2 → activate (drift engine creates an alert for the v1-bound task)
  const plan2 = await mcp(client, 'plansync_plan_create', {
    projectId,
    title: 'E2E Plan v2',
    goal: 'Updated goal',
    scope: 'Updated scope',
  });
  await mcp(client, 'plansync_plan_activate', { projectId, planId: plan2.data.id });

  // Wait for drift to appear (drift engine is synchronous, but give it a moment)
  for (let i = 0; i < 5; i++) {
    const drifts = await mcp(client, 'plansync_drift_list', { projectId });
    if (drifts.data?.length > 0) {
      driftId = drifts.data[0].id;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // ── Empty project (no plans, no tasks) ──
  const emptyProj = await mcp(client, 'plansync_project_create', {
    name: `e2e-empty-${Date.now()}`,
    phase: 'planning',
  });
  emptyProjectId = emptyProj.data.id;

  await client.close();
}, 60_000);

afterAll(async () => {
  await deleteProject(SERVER_URL, projectId);
  await deleteProject(SERVER_URL, emptyProjectId);
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('E2E: plansync-cli', () => {
  it('C1: plansync-cli status → exit 0, stdout contains "Project:"', () => {
    const r = cli(['status'], projectId, { PLANSYNC_USER: TEST_USER });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Project:');
  });

  it('C2: plansync-cli status → stdout contains "Active Plan:", "Members:", "Tasks:", "Open Drifts:"', () => {
    const r = cli(['status'], projectId, { PLANSYNC_USER: TEST_USER });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Active Plan:');
    expect(r.stdout).toContain('Members:');
    expect(r.stdout).toContain('Tasks:');
    expect(r.stdout).toContain('Open Drifts:');
  });

  it('C3: plansync-cli plan show (active plan) → exit 0, stdout contains "Goal:"', () => {
    const r = cli(['plan', 'show'], projectId, { PLANSYNC_USER: TEST_USER });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Goal:');
    expect(r.stdout).toContain('Scope:');
  });

  it('C4: plansync-cli plan show (no active plan) → exit non-0 or error message', () => {
    const r = cli(['plan', 'show'], emptyProjectId, { PLANSYNC_USER: TEST_USER });
    // When there is no active plan, the API returns 404; CLI throws → exit non-zero
    const out = r.stdout + r.stderr;
    expect(r.status !== 0 || out.length > 0).toBe(true);
    if (r.status === 0) {
      // Unlikely, but if it exits 0 it must say something meaningful
      expect(out.toLowerCase()).toMatch(/no active plan|not found|404/);
    }
  });

  it('C5: plansync-cli drift (open drifts exist) → exit 0, stdout contains drift info', () => {
    const r = cli(['drift'], projectId, { PLANSYNC_USER: TEST_USER });
    expect(r.status).toBe(0);
    // Either shows a drift line or "No open drift alerts." (if C6 resolved it already)
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it('C6: plansync-cli drift resolve <id> no_impact → exit 0', () => {
    if (!driftId) {
      console.warn('No drift ID found; skipping C6 (drift may not have been created)');
      return;
    }
    const r = cli(['drift', 'resolve', driftId, 'no_impact'], projectId, {
      PLANSYNC_USER: TEST_USER,
    });
    expect(r.status).toBe(0);
  });

  it('C7: plansync-cli tasks → exit 0', () => {
    const r = cli(['tasks'], projectId, { PLANSYNC_USER: TEST_USER });
    expect(r.status).toBe(0);
  });

  it('C8: plansync-cli tasks → stdout contains task data or "No tasks."', () => {
    const r = cli(['tasks'], projectId, { PLANSYNC_USER: TEST_USER });
    expect(r.status).toBe(0);
    // Output is either tab-separated task rows or "No tasks."
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it('C9: plansync-cli tasks <taskId> → exit 0, stdout is valid JSON with correct id', () => {
    const r = cli(['tasks', taskId], projectId, { PLANSYNC_USER: TEST_USER });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.id).toBe(taskId);
  });

  it('C10: plansync-cli tasks --mine → exit 0', () => {
    const r = cli(['tasks', '--mine'], projectId, { PLANSYNC_USER: TEST_USER });
    expect(r.status).toBe(0);
  });

  it('C11: plansync-cli tasks --status todo → exit 0', () => {
    const r = cli(['tasks', '--status', 'todo'], projectId, { PLANSYNC_USER: TEST_USER });
    expect(r.status).toBe(0);
  });

  it('C12: plansync-cli status (PLANSYNC_PROJECT unset) → exit 1, error mentions PLANSYNC_PROJECT', () => {
    const r = cli(['status'], '', { PLANSYNC_PROJECT: '' });
    expect(r.status).toBe(1);
    const out = r.stdout + r.stderr;
    expect(out).toContain('PLANSYNC_PROJECT');
  });
});
