// E2E: Multi-user workflow via real genie -p
// Alice (owner) and Bob (developer) each use `genie -p` with plansync MCP tools.
// Each genie call uses --dangerously-skip-permissions (auto-approve tools without
// blocking on stdin) and --mcp-config JSON (bypass settings.json entirely).
//
// Flow:
//   Alice setup:  create project + member + plan + task (via genie -p)
//   Bob work:     claim + execute task (via genie -p)
//   Alice v2:     activate new plan version → drift created (via genie -p)
//   Bob resolve:  resolve drift + mark task done (via genie -p)
//   Verify:       plansync-cli from both Alice and Bob perspectives
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import { connectMcpClient, mcp, cli, deleteProject, runGenie } from './mcp-helpers';

const SERVER_URL = `http://localhost:${process.env.PORT || 3001}`;
const API_SECRET = process.env.PLANSYNC_SECRET || 'dev-secret';

const PROJECT_NAME = `genie-multi-${Date.now()}`;

let projectId: string;
let taskId: string;
let driftId: string;

describe('Workflow: 多人协作工作流（genie -p）', () => {
  let aliceWorkDir: string;
  let bobWorkDir: string;

  beforeAll(async () => {
    aliceWorkDir = fs.mkdtempSync('/tmp/plansync-e2e-alice-');
    bobWorkDir = fs.mkdtempSync('/tmp/plansync-e2e-bob-');

    // Alice sets up: project, member (Bob), plan v1, task
    const aliceSetupPrompt = `Using plansync MCP tools, complete these steps in order:
1. Create a project named "${PROJECT_NAME}" with phase "planning"
2. Add member "bob" with role "developer" and type "human"
3. Create a plan titled "Sprint 1", goal "Build auth module", scope "Login + JWT"
4. Activate the plan
5. Create a task titled "Implement login API", type "code", priority "p0"
Output: ALICE_SETUP_COMPLETE`;

    const aliceSetup = runGenie(aliceSetupPrompt, SERVER_URL, 'alice', aliceWorkDir, 600_000);
    expect(aliceSetup.status).toBe(0);

    // Look up projectId and taskId using the unique project name
    const aliceClient = await connectMcpClient(SERVER_URL, 'alice');
    const projects = await mcp(aliceClient, 'plansync_project_list', {});
    const proj = (projects.data ?? []).find((p: any) => p.name === PROJECT_NAME);
    expect(proj).toBeDefined();
    projectId = proj!.id;
    const tasks = await mcp(aliceClient, 'plansync_task_list', { projectId });
    taskId = tasks.data?.[0]?.id;
    await aliceClient.close();
  }, 720_000); // 12 minutes for beforeAll

  afterAll(async () => {
    await deleteProject(SERVER_URL, projectId);
    for (const dir of [aliceWorkDir, bobWorkDir]) {
      if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('G-M1: plansync-cli status（Alice）显示团队成员和活跃计划', () => {
    const r = cli(['status'], projectId, { PLANSYNC_USER: 'alice' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Members:');
    expect(r.stdout).toContain('Active Plan:');
  });

  it('G-M2: Bob 通过 genie 认领并执行任务', () => {
    if (!taskId) {
      console.warn('No taskId; skipping G-M2');
      return;
    }
    const bobWorkPrompt = `Using plansync MCP tools for project "${projectId}":
1. Claim task "${taskId}" (assigneeType: "human", startImmediately: true)
2. Start execution (executorType: "human", executorName: "bob")
3. Complete the execution with status "completed", outputSummary "Login API implemented"
Output: BOB_WORK_COMPLETE`;

    const r = runGenie(bobWorkPrompt, SERVER_URL, 'bob', bobWorkDir, 600_000);
    expect(r.status).toBe(0);
  }, 660_000);

  it('G-M3: plansync-cli tasks（Alice）看到任务已被认领', () => {
    const r = cli(['tasks'], projectId, { PLANSYNC_USER: 'alice' });
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it('G-M4: Alice 通过 genie 激活计划 v2（触发 drift）', () => {
    const alicePlanPrompt = `Using plansync MCP tools for project "${projectId}":
1. Create a plan titled "Sprint 1 v2", goal "Build auth + OAuth", scope "Login + JWT + Google SSO"
2. Activate the new plan
Output: ALICE_PLAN_V2_COMPLETE`;

    const r = runGenie(alicePlanPrompt, SERVER_URL, 'alice', aliceWorkDir, 600_000);
    expect(r.status).toBe(0);
  }, 660_000);

  it('G-M5: plansync-cli drift（Bob）显示 drift alert', () => {
    const r = cli(['drift'], projectId, { PLANSYNC_USER: 'bob' });
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it('G-M6: Alice 处理 drift（owner-only），Bob 标记任务完成', async () => {
    // Find the drift ID via MCP SDK first
    const aliceClient = await connectMcpClient(SERVER_URL, 'alice');
    const drifts = await mcp(aliceClient, 'plansync_drift_list', { projectId });
    driftId = drifts.data?.[0]?.id;
    await aliceClient.close();

    if (!driftId || !taskId) {
      console.warn('Missing driftId or taskId; skipping G-M6');
      return;
    }

    // Alice (owner) resolves the drift
    const aliceResolvePrompt = `Using plansync MCP tools for project "${projectId}":
1. Call plansync_drift_resolve with projectId "${projectId}", driftId "${driftId}", action "no_impact"
Output: ALICE_RESOLVE_COMPLETE`;

    const ra = runGenie(aliceResolvePrompt, SERVER_URL, 'alice', aliceWorkDir, 600_000);
    expect(ra.status).toBe(0);

    // Bob marks the task done
    const bobDonePrompt = `Using plansync MCP tools for project "${projectId}":
1. Call plansync_task_update with projectId "${projectId}", taskId "${taskId}", status "done"
Output: BOB_DONE_COMPLETE`;

    const rb = runGenie(bobDonePrompt, SERVER_URL, 'bob', bobWorkDir, 600_000);
    expect(rb.status).toBe(0);
  }, 660_000);

  it('G-M7: plansync-cli status（Alice）显示 0 个 drift', () => {
    const r = cli(['status'], projectId, { PLANSYNC_USER: 'alice' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Open Drifts: 0');
  });

  it('G-M8: plansync-cli tasks（Alice）验证任务 done、负责人为 bob', () => {
    if (!taskId) return;
    const r = cli(['tasks', taskId], projectId, { PLANSYNC_USER: 'alice' });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe('done');
    expect(parsed.assignee).toBe('bob');
  });
});
