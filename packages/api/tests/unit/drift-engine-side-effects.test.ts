/**
 * R-007 — complementary coverage for `dispatchDriftNotifications`.
 *
 * The companion file `drift-engine-notifications.test.ts` (added in PR #11)
 * verifies the core invariants:
 *   - `persistDriftAlerts` has no in-tx SSE/email side effects
 *   - a thrown tx write suppresses any dispatch
 *   - the happy path emits mail + per-user SSE for a single human assignee
 *
 * This file adds the cases that file did not cover:
 *   1. Multi-assignee fan-out (alerts spanning two humans → two distinct
 *      emails, two distinct per-user SSE publishes)
 *   2. Multiple alerts owned by the same assignee bundled into ONE email
 *      and ONE per-user publish (the body lists every affected task)
 *   3. The email body format (bullet lines containing `"<title>": <reason>`)
 *   4. The project-channel `eventBus.publish` is intentionally NOT touched
 *      by `dispatchDriftNotifications` — the route owns that event, so the
 *      helper must not double-publish it.
 *   5. `dispatchDriftNotifications` is robust when an alert's taskId has no
 *      matching task row (e.g. a concurrent task delete after the drift was
 *      persisted but before dispatch ran).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  prisma: {
    task: { findMany: vi.fn() },
    projectMember: { findMany: vi.fn() },
    plan: { findMany: vi.fn() },
    driftAlert: { update: vi.fn() },
    planDiff: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/event-bus', () => ({
  eventBus: {
    publish: vi.fn(),
    publishToUser: vi.fn(),
  },
}));

vi.mock('@/lib/email', () => ({
  sendMail: vi.fn().mockReturnValue(true),
  userEmail: (name: string) => `${name}@example.test`,
}));

vi.mock('@/lib/ai/client', () => ({ aiClient: { isAvailable: false } }));
vi.mock('@/lib/ai/plan-diff', () => ({ getOrCreatePlanDiff: vi.fn() }));
vi.mock('@/lib/ai/impact-analysis', () => ({ analyzeTaskImpact: vi.fn() }));

import { dispatchDriftNotifications } from '@/lib/drift-engine';
import { eventBus } from '@/lib/event-bus';
import { sendMail } from '@/lib/email';
import { prisma } from '@/lib/prisma';

const PROJECT = 'p1';

function alert(taskId: string, severity: 'high' | 'medium' | 'low', reason: string) {
  return {
    taskId,
    severity,
    reason,
    currentPlanVersion: 2,
    taskBoundVersion: 1,
  };
}

describe('R-007 (complementary): multi-assignee fan-out', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (sendMail as unknown as { mockReturnValue: (v: boolean) => void }).mockReturnValue(true);
  });

  it('sends one email and one per-user publish per distinct human assignee', async () => {
    (prisma.task.findMany as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      { id: 't1', title: 'Alice task 1', assignee: 'alice' },
      { id: 't2', title: 'Bob task 1', assignee: 'bob' },
    ]);
    (prisma.projectMember.findMany as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      { name: 'alice' },
      { name: 'bob' },
    ]);

    await dispatchDriftNotifications(PROJECT, [
      alert('t1', 'high', 'plan v1 → v2 broke alice task'),
      alert('t2', 'medium', 'plan v1 → v2 changed bob scope'),
    ]);

    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(eventBus.publishToUser).toHaveBeenCalledTimes(2);

    const recipients = (sendMail as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => (c[0] as string[])[0])
      .sort();
    expect(recipients).toEqual(['alice@example.test', 'bob@example.test']);

    const publishUsers = (eventBus.publishToUser as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => c[0] as string)
      .sort();
    expect(publishUsers).toEqual(['alice', 'bob']);
  });
});

describe('R-007 (complementary): multi-alert bundling per assignee', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (sendMail as unknown as { mockReturnValue: (v: boolean) => void }).mockReturnValue(true);
  });

  it('bundles two alerts owned by the same human into a single email/publish carrying both', async () => {
    (prisma.task.findMany as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      { id: 't1', title: 'Refactor auth', assignee: 'alice' },
      { id: 't2', title: 'Migrate schema', assignee: 'alice' },
    ]);
    (prisma.projectMember.findMany as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      { name: 'alice' },
    ]);

    await dispatchDriftNotifications(PROJECT, [
      alert('t1', 'high', 'auth contract changed'),
      alert('t2', 'medium', 'columns renamed'),
    ]);

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(eventBus.publishToUser).toHaveBeenCalledTimes(1);

    const publishCall = (eventBus.publishToUser as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(publishCall[0]).toBe('alice');
    expect(publishCall[1]).toBe('drift_detected');
    expect(publishCall[2]).toBe(PROJECT);
    const payload = publishCall[3] as { alerts: Array<{ title: string; severity: string }> };
    expect(payload.alerts).toHaveLength(2);
    expect(payload.alerts.map((a) => a.title).sort()).toEqual(['Migrate schema', 'Refactor auth']);
    expect(new Set(payload.alerts.map((a) => a.severity))).toEqual(new Set(['high', 'medium']));
  });

  it("the bundled email body lists every affected task as a bullet line of '<title>': <reason>", async () => {
    (prisma.task.findMany as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      { id: 't1', title: 'Refactor auth', assignee: 'alice' },
      { id: 't2', title: 'Migrate schema', assignee: 'alice' },
    ]);
    (prisma.projectMember.findMany as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      { name: 'alice' },
    ]);

    await dispatchDriftNotifications(PROJECT, [
      alert('t1', 'high', 'auth contract changed'),
      alert('t2', 'medium', 'columns renamed'),
    ]);

    const mailCall = (sendMail as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    const body = mailCall[2] as string;
    expect(body).toContain('"Refactor auth": auth contract changed');
    expect(body).toContain('"Migrate schema": columns renamed');
    // Sanity check that the framing copy is present.
    expect(body).toContain('drift alerts that require your attention');
    expect(body).toContain('log in to PlanSync');
  });
});

describe('R-007 (complementary): boundary between helper and route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (sendMail as unknown as { mockReturnValue: (v: boolean) => void }).mockReturnValue(true);
  });

  it('does NOT publish to the project channel — that is the calling route\'s job', async () => {
    (prisma.task.findMany as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      { id: 't1', title: 'T1', assignee: 'alice' },
    ]);
    (prisma.projectMember.findMany as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      { name: 'alice' },
    ]);

    await dispatchDriftNotifications(PROJECT, [alert('t1', 'high', 'r')]);

    // Per-user SSE: yes; project-level SSE: must not be called from here.
    // The activate/reactivate routes own the project-channel emit so we don't
    // accidentally double-publish drift_detected.
    expect(eventBus.publishToUser).toHaveBeenCalledTimes(1);
    expect(eventBus.publish).not.toHaveBeenCalled();
  });
});

describe('R-007 (complementary): robustness against stale alert→task references', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (sendMail as unknown as { mockReturnValue: (v: boolean) => void }).mockReturnValue(true);
  });

  it('skips alerts whose task row no longer exists / has no assignee (no crash, no mail)', async () => {
    // Alert references t-missing but the task query returns nothing for it
    // (e.g. task was deleted concurrently between persist and dispatch).
    (prisma.task.findMany as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([]);
    (prisma.projectMember.findMany as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([]);

    await expect(
      dispatchDriftNotifications(PROJECT, [alert('t-missing', 'high', 'r')]),
    ).resolves.toBeUndefined();

    expect(sendMail).not.toHaveBeenCalled();
    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(eventBus.publishToUser).not.toHaveBeenCalled();
  });

  it('mixed batch — one assignee resolvable, one not — only dispatches the resolvable one', async () => {
    (prisma.task.findMany as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      { id: 't-known', title: 'Known task', assignee: 'alice' },
      // t-unknown intentionally absent from the result set
    ]);
    (prisma.projectMember.findMany as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      { name: 'alice' },
    ]);

    await dispatchDriftNotifications(PROJECT, [
      alert('t-known', 'high', 'known reason'),
      alert('t-unknown', 'medium', 'task gone'),
    ]);

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(eventBus.publishToUser).toHaveBeenCalledTimes(1);
    const publishCall = (eventBus.publishToUser as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    const payload = publishCall[3] as { alerts: Array<{ title: string }> };
    expect(payload.alerts).toEqual([
      expect.objectContaining({ title: 'Known task', severity: 'high' }),
    ]);
  });
});
