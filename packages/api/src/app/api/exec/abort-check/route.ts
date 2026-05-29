/**
 * R-206 L2: lightweight endpoint for Claude Code (or any other IDE that
 * exposes a pre-tool-call hook) to query whether the current
 * exec-scoped session has been aborted by the API (drift detected, run
 * paused, task gated). Designed to be invoked from a `PreToolUse` hook
 * before every tool call, so latency budget is < 50 ms end-to-end.
 *
 * Wire contract:
 *   - HTTP 200 + `{ aborted: false, ... }` → tool may proceed
 *   - HTTP 409 + `{ aborted: true, reason, ... }` → hook returns non-zero,
 *     IDE interrupts the ai-loop, no further tool calls are issued
 *   - HTTP 401 / 500 / network → CLI fails closed (exit 1) so a broken
 *     API can't silently bypass the gate
 *
 * Auth: reuses `authenticate(req)` which already understands exec-scoped
 * `ps_key_*` API keys. We do NOT call `requireProjectRole` because the
 * exec-scoped key is already bound to (projectId, taskId, runId) — the
 * authentic key proves the caller is the agent executing that specific
 * run. A non-exec session (e.g. an interactive developer) calling this
 * endpoint gets `{ aborted: false, reason: 'no_exec_context' }` so the
 * hook is a harmless no-op outside of `/exec` sessions.
 *
 * No new error envelope — handleApiError formats the rare 4xx/5xx
 * paths uniformly with the rest of the API. The hot path is the simple
 * NextResponse.json call below.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';

export async function GET(req: NextRequest) {
  try {
    const auth = await authenticate(req);
    const runId = auth.execRunId;

    // Caller is not exec-scoped (regular developer session, or a
    // password-bearer in dev). The hook should treat this as
    // "nothing to gate" and let the tool through.
    if (!runId) {
      return NextResponse.json({ aborted: false, reason: 'no_exec_context' });
    }

    const row = await prisma.executionRun.findUnique({
      where: { id: runId },
      select: {
        status: true,
        task: { select: { executionGate: true } },
      },
    });

    if (!row) {
      // The exec-scoped key is bound to a runId that no longer exists
      // (run finished + row cleaned up, or DB was reset). Treat as
      // aborted so the IDE stops issuing tool calls under a stale
      // session.
      return NextResponse.json({ aborted: true, reason: 'run_not_found' }, { status: 409 });
    }

    const gateActive = !!row.task.executionGate;
    const paused = row.status === 'paused';
    const aborted = paused || gateActive;

    if (aborted) {
      return NextResponse.json(
        {
          aborted: true,
          reason: paused ? 'run_paused' : 'task_gated',
          status: row.status,
          executionGate: row.task.executionGate,
        },
        { status: 409 },
      );
    }

    return NextResponse.json({
      aborted: false,
      status: row.status,
      executionGate: null,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
