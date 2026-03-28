#!/usr/bin/env node
import { Command } from 'commander';

const API_URL = (process.env.PLANSYNC_API_URL || 'http://localhost:3000').replace(/\/$/, '');
const API_KEY = process.env.PLANSYNC_API_KEY || process.env.PLANSYNC_SECRET || 'dev-secret';
const USER = process.env.PLANSYNC_USER || process.env.USER || 'anonymous';
const PROJECT = process.env.PLANSYNC_PROJECT || '';

type ApiErr = { error?: { message?: string; code?: string } };

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${API_URL}/api${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'X-User-Name': USER,
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    },
  });
}

async function apiJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, options);
  const json = (await res.json()) as T & ApiErr;
  if (!res.ok) {
    const msg = json.error?.message || `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return json;
}

function requireProject(): string {
  if (!PROJECT) {
    console.error('Set PLANSYNC_PROJECT (or pass --project).');
    process.exit(1);
  }
  return PROJECT;
}

const program = new Command();

program.name('plansync-cli').description('PlanSync CLI').version('0.1.0');

program
  .command('status')
  .description('Show project status (active plan, members, tasks, drifts)')
  .option('-p, --project <id>', 'Project ID (overrides PLANSYNC_PROJECT)')
  .action(async (opts: { project?: string }) => {
    const projectId = opts.project || requireProject();
    const { data } = await apiJson<{
      data: {
        project: { name: string };
        activePlan: { version: number; title: string } | null;
        tasks: { status: string }[];
        driftAlerts: unknown[];
        members: unknown[];
      };
    }>(`/projects/${projectId}/dashboard`);

    console.log(`Project: ${data.project.name}`);
    console.log(
      `Active Plan: ${data.activePlan ? `v${data.activePlan.version} — ${data.activePlan.title}` : 'None'}`,
    );
    console.log(`Members: ${data.members.length}`);
    const done = data.tasks.filter((t) => t.status === 'done').length;
    console.log(`Tasks: ${data.tasks.length} (${done} done)`);
    console.log(`Open Drifts: ${data.driftAlerts.length}`);
  });

const driftCmd = program.command('drift').description('Drift alerts (default: list open)');

driftCmd
  .command('resolve <driftId> <action>')
  .description('Resolve a drift (rebind | cancel | no_impact)')
  .option('-p, --project <id>', 'Project ID')
  .action(async (driftId: string, action: string, opts: { project?: string }) => {
    const projectId = opts.project || requireProject();
    const allowed = new Set(['rebind', 'cancel', 'no_impact']);
    if (!allowed.has(action)) {
      console.error(`Invalid action "${action}". Use: rebind, cancel, no_impact`);
      process.exit(1);
    }
    const { data } = await apiJson<{ data: { resolved: boolean; action: string } }>(
      `/projects/${projectId}/drifts/${driftId}`,
      { method: 'POST', body: JSON.stringify({ action }) },
    );
    console.log(`Resolved: ${data.resolved}, action: ${data.action}`);
  });

driftCmd.option('-p, --project <id>', 'Project ID').action(async (opts: { project?: string }) => {
  const projectId = opts.project || requireProject();
  const { data } = await apiJson<{
    data: {
      id: string;
      taskId: string;
      severity: string;
      taskBoundVersion: number;
      currentPlanVersion: number;
      reason: string;
      status: string;
    }[];
  }>(`/projects/${projectId}/drifts?status=open&pageSize=100`);

  if (data.length === 0) {
    console.log('No open drift alerts.');
    return;
  }
  for (const d of data) {
    console.log(
      `[${d.severity}] ${d.id} task=${d.taskId} bound=v${d.taskBoundVersion} active=v${d.currentPlanVersion}`,
    );
    console.log(`  ${d.reason}`);
  }
});

const planCmd = program.command('plan').description('Plans');

planCmd
  .command('show')
  .description('Show the active plan')
  .option('-p, --project <id>', 'Project ID')
  .action(async (opts: { project?: string }) => {
    const projectId = opts.project || requireProject();
    const { data } = await apiJson<{
      data: {
        id: string;
        version: number;
        title: string;
        goal: string;
        scope: string;
        status: string;
        constraints: string[];
        deliverables: string[];
      };
    }>(`/projects/${projectId}/plans/active`);

    console.log(`Plan v${data.version} [${data.status}] ${data.title}`);
    console.log(`Goal: ${data.goal}`);
    console.log(`Scope: ${data.scope}`);
    console.log(`Constraints: ${data.constraints.join('; ') || '—'}`);
    console.log(`Deliverables: ${data.deliverables.join('; ') || '—'}`);
  });

program
  .command('tasks [taskId]')
  .description('List tasks, or show one task by ID')
  .option('-p, --project <id>', 'Project ID')
  .option('--mine', 'Only tasks assigned to PLANSYNC_USER')
  .option('--status <status>', 'Filter by status (todo|in_progress|blocked|done|cancelled)')
  .option('--page <n>', 'Page number', '1')
  .option('--page-size <n>', 'Page size', '50')
  .action(
    async (
      taskId: string | undefined,
      opts: { project?: string; mine?: boolean; status?: string; page: string; pageSize: string },
    ) => {
      const projectId = opts.project || requireProject();

      if (taskId) {
        const { data } = await apiJson<{
          data: Record<string, unknown>;
        }>(`/projects/${projectId}/tasks/${taskId}`);
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      const q = new URLSearchParams();
      q.set('page', opts.page);
      q.set('pageSize', opts.pageSize);
      if (opts.status) q.set('status', opts.status);
      if (opts.mine) q.set('assignee', USER);

      const { data, pagination } = await apiJson<{
        data: {
          id: string;
          title: string;
          status: string;
          assignee: string | null;
          boundPlanVersion: number;
        }[];
        pagination: { page: number; pageSize: number; total: number; totalPages: number };
      }>(`/projects/${projectId}/tasks?${q.toString()}`);

      if (data.length === 0) {
        console.log('No tasks.');
        return;
      }
      for (const t of data) {
        const who = t.assignee || '—';
        console.log(`${t.id}\t[${t.status}]\tv${t.boundPlanVersion}\t${who}\t${t.title}`);
      }
      console.log(
        `— page ${pagination.page}/${pagination.totalPages} (${pagination.total} total) —`,
      );
    },
  );

program.parse();
