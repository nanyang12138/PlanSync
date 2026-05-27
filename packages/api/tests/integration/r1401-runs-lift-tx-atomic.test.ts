/**
 * Closes #1401 — POST /runs lift (todo→in_progress claim or
 * awaiting_evidence→in_progress R-192 reopen) and the new running
 * run's INSERT must commit atomically.
 *
 * Pre-fix the route ran two independent prisma calls:
 *
 *   1. `prisma.task.updateMany({ status: 'in_progress' })` ← commit-1
 *   2. `prisma.executionRun.create({ status: 'running' })` ← commit-2
 *
 * A concurrent PATCH /tasks/:id from a non-owner could land between
 * the two commits and observe an inconsistent snapshot:
 *
 *   - task.status = 'in_progress'  ← commit-1 visible
 *   - latest run  = old 'completed' ← commit-2 not yet visible
 *
 * In that window PATCH's R-192 guard at
 * `packages/api/src/app/api/projects/[projectId]/tasks/[taskId]/route.ts`
 * passes both gates (the `awaiting_evidence → done` owner-only branch
 * does not fire because the source state already advanced; the
 * `hasCompletedRun` shortcut anchors on the latest run, which is the
 * old completed one), so a non-owner can flip the task to `done` —
 * bypassing R-192 exactly as in the post-fix #1306 attack, just
 * compressed into the in-flight POST-/runs window.
 *
 * The fix wraps both writes in a single `prisma.$transaction` so
 * external readers under PostgreSQL READ COMMITTED see them at the
 * same commit boundary. We exercise the contract two ways:
 *
 *   1. Static-source guard: the lift `task.updateMany` and the run
 *      `executionRun.create` must live inside the same `$transaction`
 *      callback, both using the `tx` client (not `prisma` directly).
 *      Mirrors the established pattern in `b15-plan-patch-tx-atomic.test.ts`.
 *   2. End-to-end happy path: a real POST /runs against an
 *      `awaiting_evidence` task lands the task in `in_progress` with
 *      a fresh `running` run as the latest, so the post-fix invariant
 *      "PATCH cannot see in_progress without also seeing running run
 *      as latest" holds for any subsequent reader.
 *
 * Reproducing the precise concurrency race (a PATCH that fires
 * between commit-1 and commit-2) would need two coordinated DB
 * connections with a deterministic barrier — Prisma's interactive
 * transactions do not offer that hook, and bolting one on for a
 * single test would dwarf the fix. The structural guard proves the
 * atomicity contract at the source-code level instead.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { POST as runsStartPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

const ROUTE_FILE = path.resolve(
  __dirname,
  '../../src/app/api/projects/[projectId]/tasks/[taskId]/runs/route.ts',
);

describe('#1401 (static guard) — POST /runs lift + create are inside one $transaction', () => {
  // Helper — locate the POST handler body and split it into the
  // `$transaction` callback body and the surrounding tail. Mirrors
  // the pattern in `b15-plan-patch-tx-atomic.test.ts`.
  function extractPostTxBody(src: string): string {
    const postStart = src.indexOf('export async function POST');
    expect(postStart).toBeGreaterThan(-1);
    const txOpen = src.indexOf('prisma.$transaction(async (tx) => {', postStart);
    expect(txOpen, 'expected POST handler to wrap lift+create in $transaction').toBeGreaterThan(-1);
    const bodyStart = src.indexOf('{', txOpen) + 1;
    let depth = 1;
    let i = bodyStart;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      i += 1;
    }
    const bodyEnd = i - 1;
    return src.slice(bodyStart, bodyEnd);
  }

  it('the awaiting_evidence lift uses the tx client (not bare prisma)', () => {
    const src = fs.readFileSync(ROUTE_FILE, 'utf-8');
    const txBody = extractPostTxBody(src);

    // The R-192 lift updateMany must run on `tx`, not `prisma`.
    expect(txBody).toMatch(/tx\.task\.updateMany\(\s*\{\s*[\s\S]*?status:\s*'awaiting_evidence'/);
  });

  it('the todo→in_progress claim uses the tx client (not bare prisma)', () => {
    const src = fs.readFileSync(ROUTE_FILE, 'utf-8');
    const txBody = extractPostTxBody(src);
    expect(txBody).toMatch(/tx\.task\.updateMany\(\s*\{\s*[\s\S]*?status:\s*'todo'/);
  });

  it('the running run INSERT uses the tx client (not bare prisma)', () => {
    const src = fs.readFileSync(ROUTE_FILE, 'utf-8');
    const txBody = extractPostTxBody(src);
    expect(txBody).toMatch(/tx\.executionRun\.create\(/);
  });

  it('does not perform side-effecting prisma writes outside the tx in the lift+create window', () => {
    const src = fs.readFileSync(ROUTE_FILE, 'utf-8');
    const txBody = extractPostTxBody(src);
    // No bare `prisma.task.updateMany` or `prisma.executionRun.create`
    // inside the tx body — the spy/static guard breaks if either
    // sneaks back in (which is what the bug looked like pre-fix).
    expect(txBody).not.toMatch(/\bprisma\.task\.updateMany/);
    expect(txBody).not.toMatch(/\bprisma\.executionRun\.create/);
  });
});

describe('#1401 (end-to-end) — POST /runs lift + create commit atomically on awaiting_evidence', () => {
  const owner = 'r1401-owner';
  const agentName = 'r1401-agent';
  let projectId: string;
  let planVersion: number;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    const { version } = await createActivePlan(projectId, owner);
    planVersion = version;
    await testPrisma.projectMember.create({
      data: { projectId, name: agentName, role: 'developer', type: 'agent' },
    });
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  beforeEach(async () => {
    await testPrisma.executionRun.deleteMany({ where: { task: { projectId } } });
    await testPrisma.task.deleteMany({ where: { projectId } });
  });

  async function newAwaitingEvidenceTask() {
    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: `r1401-task-${Math.random().toString(36).slice(2, 8)}`,
        type: 'code',
        priority: 'p1',
        // The route reads task.status === 'awaiting_evidence' and
        // applies the lift in question; the prior completed run is
        // what the PATCH bypass would lean on outside the window.
        status: 'awaiting_evidence',
        assignee: agentName,
        assigneeType: 'agent',
        boundPlanVersion: planVersion,
        agentConstraints: [],
        planDeliverableRefs: [],
      },
    });
    await testPrisma.executionRun.create({
      data: {
        taskId: task.id,
        status: 'completed',
        executorType: 'agent',
        executorName: agentName,
        boundPlanVersion: planVersion,
        taskPackSnapshot: {},
        startedAt: new Date(Date.now() - 120_000),
        endedAt: new Date(Date.now() - 60_000),
      },
    });
    return task;
  }

  it('lifts task to in_progress AND makes the new running run the latest in one observable step', async () => {
    const task = await newAwaitingEvidenceTask();
    expect(task.status).toBe('awaiting_evidence');

    const res = await runsStartPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/runs`, {
        method: 'POST',
        userName: agentName,
        body: { executorName: agentName, executorType: 'agent' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(201);

    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('in_progress');

    const runs = await testPrisma.executionRun.findMany({
      where: { taskId: task.id },
      orderBy: { startedAt: 'asc' },
    });
    expect(runs).toHaveLength(2);
    // Latest run by startedAt is `running` — closes the PATCH bypass
    // shortcut because the PATCH /tasks/:id `hasCompletedRun` check
    // anchors on the latest run, and the lift commits atomically with
    // this insert per the static guards above.
    const latest = runs[runs.length - 1];
    expect(latest.status).toBe('running');

    // Cross-check: ordering by startedAt desc (the same ordering
    // PATCH uses for `hasCompletedRun`) also returns the running run
    // first. This is the exact query shape PATCH evaluates, so a
    // pass here means PATCH would no longer see an old completed
    // run as latest in the post-lift state.
    const latestByPatchOrder = await testPrisma.executionRun.findFirst({
      where: { taskId: task.id },
      orderBy: { startedAt: 'desc' },
      select: { status: true },
    });
    expect(latestByPatchOrder?.status).toBe('running');
  });
});
