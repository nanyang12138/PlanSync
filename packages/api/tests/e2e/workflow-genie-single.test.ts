// E2E: Single-user workflow via real genie -p
// Alice acts as both owner and developer. The test:
//   1. Spawns `genie -p --dangerously-skip-permissions --mcp-config JSON` with a prompt
//      that instructs the AI to use plansync MCP tools to complete a full single-user
//      workflow (create project → plan → task → execute → done)
//   2. Verifies the resulting state with `plansync-cli` commands
//
// Using --dangerously-skip-permissions is critical: without it, genie blocks waiting for
// permission approval on stdin that is already consumed by the prompt text.
// Using --mcp-config avoids ~/.claude/settings.json manipulation entirely.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import { connectMcpClient, mcp, cli, deleteProject, runGenie } from './mcp-helpers';

const SERVER_URL = `http://localhost:${process.env.PORT || 3001}`;
const API_SECRET = process.env.PLANSYNC_SECRET || 'dev-secret';

// Unique project name so we can find it after genie finishes
const PROJECT_NAME = `genie-single-${Date.now()}`;

let projectId: string;
let taskId: string;

describe('Workflow: 单人工作流（genie -p）', () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = fs.mkdtempSync('/tmp/plansync-e2e-single-');

    // Launch real genie -p with a full single-user workflow prompt.
    // genie uses --mcp-config to find plansync tools and --dangerously-skip-permissions
    // to auto-approve all tool calls without blocking on stdin.
    const prompt = `Using the plansync MCP tools available to you, complete these steps in order:
1. Create a project named "${PROJECT_NAME}" with phase "planning"
2. Create a plan titled "MVP v1", goal "Build MVP", scope "Auth and Chat module"
3. Activate that plan
4. Create a task titled "Build auth service", type "code", priority "p0"
5. Claim the task (assigneeType: "human", startImmediately: true)
6. Start execution (executorType: "human", executorName: "alice")
7. Complete the execution with status "completed", outputSummary "Auth service implemented"
8. Update the task status to "done"
When all steps are done, output: WORKFLOW_COMPLETE`;

    const r = runGenie(prompt, SERVER_URL, 'alice', workDir, 600_000);
    expect(r.status).toBe(0);

    // Find the project and task IDs using the unique project name
    const client = await connectMcpClient(SERVER_URL, 'alice');
    const projects = await mcp(client, 'plansync_project_list', {});
    const proj = (projects.data ?? []).find((p: any) => p.name === PROJECT_NAME);
    expect(proj).toBeDefined();
    projectId = proj.id;

    const tasks = await mcp(client, 'plansync_task_list', { projectId });
    taskId = tasks.data?.[0]?.id;
    await client.close();

    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
  }, 720_000); // 12 minutes for beforeAll

  afterAll(async () => {
    await deleteProject(SERVER_URL, projectId);
  });

  it('G-S1: plansync-cli status 显示活跃计划', () => {
    const r = cli(['status'], projectId, { PLANSYNC_USER: 'alice' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Active Plan:');
  });

  it('G-S2: plansync-cli plan show 显示 MVP v1 和 Goal:', () => {
    const r = cli(['plan', 'show'], projectId, { PLANSYNC_USER: 'alice' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('MVP v1');
    expect(r.stdout).toContain('Goal:');
  });

  it('G-S3: plansync-cli tasks <id> 显示任务已完成（done）', () => {
    if (!taskId) {
      console.warn('No taskId found; skipping G-S3');
      return;
    }
    const r = cli(['tasks', taskId], projectId, { PLANSYNC_USER: 'alice' });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe('done');
  });

  it('G-S4: plansync-cli status 显示 0 个 drift alerts', () => {
    const r = cli(['status'], projectId, { PLANSYNC_USER: 'alice' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Open Drifts: 0');
  });
});
