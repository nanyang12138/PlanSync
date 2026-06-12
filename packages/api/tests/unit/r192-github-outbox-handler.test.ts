/**
 * R-192 / P0-0: github_push outbox handler.
 *
 * The handler is the seam that connects the (live) outbox consumer to the
 * (live) commit→deliverable linker. These unit tests mock prisma and the
 * linker so they need no live Postgres; the full end-to-end seam against a
 * real DB lives in tests/integration/r192-outbox-pipeline-e2e.test.ts.
 *
 * The load-bearing assertion is the malformed-payload case: a malformed
 * row MUST throw (leaving it undelivered for retry), NOT return (which the
 * consumer treats as "delivered" and would silently swallow a real push
 * event). This file is the regression guard against anyone "tidying" the
 * handler back into a warn-and-return.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  domainEventFindMany: vi.fn(),
  domainEventUpdateMany: vi.fn(),
  domainEventUpdate: vi.fn(),
  linkCommitsFromPushPayload: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    domainEvent: {
      findMany: mocks.domainEventFindMany,
      updateMany: mocks.domainEventUpdateMany,
      update: mocks.domainEventUpdate,
    },
  },
}));

vi.mock('@/lib/git/link-commits', () => ({
  linkCommitsFromPushPayload: mocks.linkCommitsFromPushPayload,
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { processPendingOutboxEvents, _resetOutboxHandlersForTests } from '@/lib/outbox-consumer';
import {
  registerGithubOutboxHandlers,
  handleGithubPushEvent,
} from '@/lib/git/register-outbox-handlers';

const VALID_PUSH = {
  ref: 'refs/heads/main',
  head_commit: { id: 'a'.repeat(40) },
  commits: [{ id: 'a'.repeat(40), message: 'feat: x', added: ['src/x.ts'] }],
};

function pushRow(
  id: bigint,
  opts: { projectId?: string | null; data?: Record<string, unknown> } = {},
) {
  const projectId = opts.projectId === undefined ? 'p1' : opts.projectId;
  return {
    id,
    eventType: 'github_push',
    projectId,
    userName: null,
    payload: {
      type: 'github_push',
      projectId,
      userName: null,
      data: opts.data ?? { repository: 'o/r', payload: VALID_PUSH },
    },
    createdAt: new Date('2026-06-11T00:00:00Z'),
    deliveredAt: null,
    attempt: 0,
  };
}

beforeEach(() => {
  mocks.domainEventFindMany.mockReset();
  mocks.domainEventUpdateMany.mockReset();
  mocks.domainEventUpdate.mockReset();
  mocks.linkCommitsFromPushPayload.mockReset();
  _resetOutboxHandlersForTests();
});

describe('R-192: registerGithubOutboxHandlers', () => {
  it('registers a github_push handler (double registration is rejected by the consumer)', () => {
    registerGithubOutboxHandlers();
    // The consumer enforces adopt-once: a second registration for the
    // same event type throws. This proves the handler was registered for
    // exactly `github_push`.
    expect(() => registerGithubOutboxHandlers()).toThrow(/already registered/);
  });
});

describe('R-192: handleGithubPushEvent (direct)', () => {
  it('calls the linker with the row projectId and the raw github payload, then resolves', async () => {
    mocks.linkCommitsFromPushPayload.mockResolvedValue({
      created: 1,
      commitsExamined: 1,
      byCommit: [],
    });
    await handleGithubPushEvent({
      id: 5n,
      payload: {
        type: 'github_push',
        projectId: 'proj-123',
        userName: null,
        data: { repository: 'o/r', payload: VALID_PUSH },
      },
      priorAttempts: 0,
    });
    expect(mocks.linkCommitsFromPushPayload).toHaveBeenCalledWith({
      projectId: 'proj-123',
      payload: VALID_PUSH,
    });
  });

  it('THROWS (does not return) when data.payload is missing', async () => {
    await expect(
      handleGithubPushEvent({
        id: 6n,
        payload: { type: 'github_push', projectId: 'proj-123', userName: null, data: {} },
        priorAttempts: 0,
      }),
    ).rejects.toThrow(/malformed github_push/);
    expect(mocks.linkCommitsFromPushPayload).not.toHaveBeenCalled();
  });

  it('THROWS when projectId is missing (the row, not the github payload, owns it)', async () => {
    await expect(
      handleGithubPushEvent({
        id: 7n,
        payload: {
          type: 'github_push',
          projectId: null,
          userName: null,
          data: { payload: VALID_PUSH },
        },
        priorAttempts: 0,
      }),
    ).rejects.toThrow(/malformed github_push/);
    expect(mocks.linkCommitsFromPushPayload).not.toHaveBeenCalled();
  });
});

describe('R-192: github_push through the outbox consumer dispatch loop', () => {
  it('happy path: links commits and marks the row delivered', async () => {
    registerGithubOutboxHandlers();
    mocks.linkCommitsFromPushPayload.mockResolvedValue({
      created: 1,
      commitsExamined: 1,
      byCommit: [],
    });
    mocks.domainEventFindMany.mockResolvedValue([pushRow(10n)]);
    mocks.domainEventUpdateMany.mockResolvedValue({ count: 1 });
    mocks.domainEventUpdate.mockResolvedValue({});

    const now = new Date('2026-06-11T12:00:00Z');
    const res = await processPendingOutboxEvents({ now });

    expect(res).toEqual({
      processed: 1,
      delivered: 1,
      failed: 0,
      deadLettered: 0,
      skipped: 0,
      scannedTypes: ['github_push'],
    });
    expect(mocks.linkCommitsFromPushPayload).toHaveBeenCalledWith({
      projectId: 'p1',
      payload: VALID_PUSH,
    });
    // Marked delivered via the guarded updateMany (deliveredAt set, lastError
    // cleared, only if not already terminal).
    expect(mocks.domainEventUpdateMany).toHaveBeenCalledWith({
      where: { id: 10n, deliveredAt: null, failedAt: null },
      data: { deliveredAt: now, lastError: null },
    });
    expect(mocks.domainEventUpdate).not.toHaveBeenCalled();
  });

  it('malformed row: handler throws → row is NOT marked delivered (stays for retry)', async () => {
    registerGithubOutboxHandlers();
    // data.payload missing → the handler throws.
    mocks.domainEventFindMany.mockResolvedValue([pushRow(11n, { data: { repository: 'o/r' } })]);
    mocks.domainEventUpdateMany.mockResolvedValue({ count: 1 });

    const res = await processPendingOutboxEvents();

    expect(res).toEqual({
      processed: 1,
      delivered: 0,
      failed: 1,
      deadLettered: 0,
      skipped: 0,
      scannedTypes: ['github_push'],
    });
    // The attempt was bumped via the claim (updateMany), but deliveredAt
    // was NEVER set — this is the whole point of throwing instead of
    // returning. If this assertion ever flips, someone turned the
    // malformed-payload throw back into a silent warn-and-return.
    expect(mocks.domainEventUpdate).not.toHaveBeenCalled();
    expect(mocks.linkCommitsFromPushPayload).not.toHaveBeenCalled();
  });
});
