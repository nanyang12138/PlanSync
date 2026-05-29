/**
 * Closes #1467 — POST /tasks/:taskId/runs must (a) decide based on a
 * task.status read INSIDE the same `$transaction` that creates the new
 * running run, and (b) check `count` on every conditional updateMany
 * used as an atomic status guard.
 *
 * Pre-fix the handler made decisions on the upfront `task` row read
 * outside any transaction, and the `awaiting_evidence` branch's
 * `updateMany` did not inspect `count`. A concurrent
 * `PATCH /tasks/:taskId` that flipped task.status to a terminal value
 * between the read and the write would silently fall through to a
 * `executionRun.create({ status: 'running' })` on a task that is no
 * longer in a legal source state — violating the R-054 state-machine
 * invariant.
 *
 * We can't easily race a real PATCH against a real POST /runs in a
 * shared-DB test without flakiness, so we exercise the atomicity
 * *contract* via static-source guards (the same pattern used by
 * `b15-plan-patch-tx-atomic.test.ts` and PR #1455's
 * r1401-runs-lift-tx-atomic guards).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROUTE_FILE = path.resolve(
  __dirname,
  '../../src/app/api/projects/[projectId]/tasks/[taskId]/runs/route.ts',
);

/** Locate the POST handler body. */
function postHandlerSource(src: string): string {
  const postStart = src.indexOf('export async function POST');
  expect(postStart).toBeGreaterThan(-1);
  // POST is the last handler in the file; slice from POST to EOF.
  return src.slice(postStart);
}

/**
 * Slice out the `$transaction(async (tx) => { ... })` body inside POST.
 * We balance braces from the `{` immediately following the arrow.
 */
function txCallbackBody(src: string): string {
  const post = postHandlerSource(src);
  const arrow = post.indexOf('prisma.$transaction(async (tx) => {');
  expect(arrow).toBeGreaterThan(-1);
  const bodyStart = post.indexOf('{', arrow) + 1;
  let depth = 1;
  let i = bodyStart;
  while (i < post.length && depth > 0) {
    const c = post[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    i += 1;
  }
  const bodyEnd = i - 1;
  return post.slice(bodyStart, bodyEnd);
}

describe('#1467 — POST /runs status decisions inside tx + count-checked guards', () => {
  it('POST handler wraps the state-decision + run-create in a single $transaction', () => {
    const src = fs.readFileSync(ROUTE_FILE, 'utf-8');
    const post = postHandlerSource(src);
    // The only $transaction call in POST owns both the state writes and the
    // executionRun.create. Match `prisma.$transaction(async (tx) => {`.
    expect(post).toMatch(/prisma\.\$transaction\(\s*async\s*\(tx\)\s*=>\s*\{/);

    // And the run create is inside that tx, using the tx client.
    const body = txCallbackBody(src);
    expect(body).toMatch(/tx\.executionRun\.create/);
    // No bare `prisma.executionRun.create` left in POST.
    expect(post.replace(body, '')).not.toMatch(/prisma\.executionRun\.create/);
  });

  it('tx re-reads task.status with tx.task.findUnique before branching', () => {
    const body = txCallbackBody(fs.readFileSync(ROUTE_FILE, 'utf-8'));
    // We must re-evaluate status inside the tx (not trust the upfront read).
    expect(body).toMatch(/tx\.task\.findUnique\(/);
    // And the subsequent branches must read off the LIVE task, not the
    // outer `task` variable. Allow either a `liveTask.status` or any
    // freshly-named local — but specifically forbid the outer `task.status`
    // being used to drive a branch INSIDE the tx (that was the #1467 bug).
    expect(body).not.toMatch(/if\s*\(\s*task\.status\s*===/);
  });

  it('awaiting_evidence lift updateMany checks count and throws STATE_CONFLICT on 0', () => {
    const body = txCallbackBody(fs.readFileSync(ROUTE_FILE, 'utf-8'));

    // Locate the awaiting_evidence updateMany call. R-206 added an
    // additional `executionGate: null` field to the WHERE clause, so
    // match the `status: 'awaiting_evidence'` substring rather than the
    // exact pre-R-206 closing-brace form. The intent is unchanged:
    // find the lift call and assert count-check + STATE_CONFLICT follow.
    const liftIdx = body.indexOf("status: 'awaiting_evidence'");
    expect(liftIdx).toBeGreaterThan(-1);
    // Within ~800 chars after the lift, we must see a count check that
    // throws STATE_CONFLICT — guards against a regression that drops the
    // count inspection again.
    const after = body.slice(liftIdx, liftIdx + 800);
    expect(after).toMatch(/\.count\s*===\s*0/);
    expect(after).toMatch(/STATE_CONFLICT/);
  });

  it('in_progress branch also performs a count-checked atomic re-verify (no-op self-set)', () => {
    const body = txCallbackBody(fs.readFileSync(ROUTE_FILE, 'utf-8'));
    // The in_progress branch must include a `tx.task.updateMany` guarded by
    // `status: 'in_progress'` with a count check — this is what locks the
    // row for the rest of the tx and detects a racing PATCH that flipped
    // the task out of in_progress.
    // Match: updateMany({ where: { id: ..., status: 'in_progress' }, data: { status: 'in_progress' } })
    expect(body).toMatch(
      /tx\.task\.updateMany\(\{[\s\S]{0,200}status:\s*'in_progress'[\s\S]{0,200}data:\s*\{[\s\S]{0,80}status:\s*'in_progress'/,
    );
    // And the count check + STATE_CONFLICT must follow shortly after.
    const inProgIdx = body.indexOf("data: { status: 'in_progress' }");
    expect(inProgIdx).toBeGreaterThan(-1);
    const after = body.slice(inProgIdx, inProgIdx + 600);
    expect(after).toMatch(/\.count\s*===\s*0/);
    expect(after).toMatch(/STATE_CONFLICT/);
  });

  it('tx rejects when liveTask.status is no longer in the allowed source set', () => {
    const body = txCallbackBody(fs.readFileSync(ROUTE_FILE, 'utf-8'));
    // Fallback `else` branch must throw STATE_CONFLICT mentioning the
    // observed live status — otherwise the handler would silently
    // fall through to executionRun.create on a now-illegal source state.
    expect(body).toMatch(/Task status changed[^"`']*during execution start/);
    expect(body).toMatch(/STATE_CONFLICT/);
  });

  it('no bare `prisma.task.updateMany` remains in POST (all status writes go through tx)', () => {
    const post = postHandlerSource(fs.readFileSync(ROUTE_FILE, 'utf-8'));
    // The pre-fix code had two bare `prisma.task.updateMany` calls (the
    // todo claim and the awaiting_evidence lift). All status mutations
    // must now flow through `tx.task.updateMany`.
    expect(post).not.toMatch(/prisma\.task\.updateMany/);
  });
});
