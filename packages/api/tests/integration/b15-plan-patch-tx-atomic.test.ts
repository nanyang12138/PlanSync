/**
 * Closes #753 — owner-driven plan PATCH must commit the plan mutation
 * + the audit Activity row inside the SAME transaction. Pre-fix the
 * route ran createActivity() AFTER the $transaction returned, so a
 * post-tx blip on the activity insert would leave the plan mutated
 * but the audit log empty. With both writes inside one tx, an
 * activity-insert failure rolls the plan update back too.
 *
 * We can't easily inject a forced failure on the live activity table
 * (it would race other tests sharing the DB), so we exercise the
 * atomicity *contract* via a static-source guard plus the existing
 * R-104 happy-path coverage in r104-plan-patch-activity.test.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROUTE_FILE = path.resolve(
  __dirname,
  '../../src/app/api/projects/[projectId]/plans/[planId]/route.ts',
);
const ACTIVITY_FILE = path.resolve(__dirname, '../../src/lib/activity.ts');

describe('B15 / closes #753 — PATCH plan + activity in single tx', () => {
  it('createActivity accepts an optional Prisma.TransactionClient', () => {
    const src = fs.readFileSync(ACTIVITY_FILE, 'utf-8');
    // Signature must include `tx?: Prisma.TransactionClient` so the
    // caller can opt into transactional writes without breaking the
    // fire-and-forget call sites that don't care about atomicity.
    expect(src).toMatch(/tx\?:\s*Prisma\.TransactionClient/);
    // Body must dispatch on the optional tx. `client = tx ?? prisma`
    // is the pattern; we accept either that exact form or any other
    // ternary that uses both `tx` and `prisma`.
    expect(src).toMatch(/(tx\s*\?\?\s*prisma|tx\s*\?\s*tx\s*:\s*prisma)/);
    expect(src).toMatch(/client\.activity\.create/);
  });

  // Helper — locate the PATCH handler body and split it into the
  // `$transaction` callback body and the post-tx tail. We can't do
  // this with a single greedy regex because the route file has a
  // separate DELETE handler that also touches `prisma`; instead we
  // walk balanced braces from the `$transaction(async (tx) => {`
  // marker.
  function splitPatchTx(src: string): { txBody: string; postTx: string } {
    const patchStart = src.indexOf('export async function PATCH');
    expect(patchStart).toBeGreaterThan(-1);
    const txOpen = src.indexOf('prisma.$transaction(async (tx) => {', patchStart);
    expect(txOpen).toBeGreaterThan(-1);
    // Walk braces from after the opening `{`.
    const bodyStart = src.indexOf('{', txOpen) + 1;
    let depth = 1;
    let i = bodyStart;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      i += 1;
    }
    const bodyEnd = i - 1; // points at the matching `}`
    // Find the end of the call expression (`});`).
    const callEnd = src.indexOf(';', bodyEnd) + 1;
    return {
      txBody: src.slice(bodyStart, bodyEnd),
      postTx: src.slice(callEnd, src.indexOf('export async function DELETE', callEnd)),
    };
  }

  it('PATCH route invokes createActivity with the tx client (inside $transaction)', () => {
    const src = fs.readFileSync(ROUTE_FILE, 'utf-8');
    const { txBody, postTx } = splitPatchTx(src);

    expect(txBody).toMatch(/Closes #753/);
    expect(txBody).toMatch(/createActivity\(/);
    // The createActivity call must pass the tx as second argument.
    expect(txBody).toMatch(/createActivity\([\s\S]*?\n\s*tx,?/);

    // And the bare-`prisma` createActivity call from the legacy
    // post-tx position must be gone.
    expect(postTx).not.toMatch(/await\s+createActivity\(/);
  });

  it('SSE + webhook dispatch still happens AFTER tx commit (no in-tx side effects)', () => {
    const src = fs.readFileSync(ROUTE_FILE, 'utf-8');
    const { txBody, postTx } = splitPatchTx(src);

    // R-007 invariant — no SSE / webhook / sendMail inside the tx,
    // because a rolled-back tx must not produce ghost notifications.
    expect(txBody).not.toMatch(/eventBus\.publish/);
    expect(txBody).not.toMatch(/dispatchWebhooks/);

    // And the post-tx surface still contains them.
    expect(postTx).toMatch(/eventBus\.publish/);
    expect(postTx).toMatch(/dispatchWebhooks/);
  });
});
