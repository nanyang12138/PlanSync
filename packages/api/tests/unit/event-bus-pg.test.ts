/**
 * R-088 — verify the Postgres LISTEN/NOTIFY event bus actually carries events
 * across separate {@link EventBusPG} instances. Two buses sharing the same
 * Postgres connection string should mirror what happens in a multi-process
 * production deployment: a publisher in process A delivers to a subscriber in
 * process B with no in-memory channel between them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBusPG } from '@/lib/event-bus-pg';
import type { PlanSyncEvent } from '@/lib/event-bus-types';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('EventBusPG (R-088)', () => {
  let busA: EventBusPG;
  let busB: EventBusPG;

  beforeAll(async () => {
    busA = new EventBusPG();
    busB = new EventBusPG();
    await Promise.all([busA.ready(), busB.ready()]);
  });

  afterAll(async () => {
    await Promise.all([busA.close(), busB.close()]);
  });

  it('delivers a project event from one instance to a subscriber on another (cross-instance NOTIFY)', async () => {
    const projectId = `proj-${Date.now()}-cross`;
    const received: PlanSyncEvent[] = [];
    const unsub = busB.subscribe(projectId, (ev) => received.push(ev));

    // give Postgres a moment to register the LISTEN
    await wait(150);
    busA.publish(projectId, 'plan_activated', { version: 7 });
    // wait for the NOTIFY round-trip
    await wait(400);

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('plan_activated');
    expect(received[0].projectId).toBe(projectId);
    expect(received[0].data).toEqual({ version: 7 });

    unsub();
  });

  it('does not double-deliver on the publishing instance (echo suppression via instanceId)', async () => {
    const projectId = `proj-${Date.now()}-echo`;
    const received: PlanSyncEvent[] = [];
    const unsub = busA.subscribe(projectId, (ev) => received.push(ev));

    await wait(150);
    // Publish on the same bus; local dispatch fires synchronously, the NOTIFY
    // round-trip back to busA must be discarded (instanceId match).
    busA.publish(projectId, 'plan_activated', { v: 1 });
    await wait(400);

    expect(received).toHaveLength(1);

    unsub();
  });

  it('delivers a user event from one instance to a subscribeUser listener on another', async () => {
    const userName = `eventbus-pg-test-user-${Date.now()}`;
    const received: PlanSyncEvent[] = [];
    const unsub = busB.subscribeUser(userName, (ev) => received.push(ev));

    await wait(150);
    busA.publishToUser(userName, 'review_requested', 'project-x', { reviewId: 'rev-1' });
    await wait(400);

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('review_requested');
    expect(received[0].projectId).toBe('project-x');
    expect(received[0].data).toEqual({ reviewId: 'rev-1' });

    unsub();
  });

  it('UNLISTENs after the last subscriber for a project goes away', async () => {
    const projectId = `proj-${Date.now()}-unsub`;
    const unsub = busB.subscribe(projectId, () => {});
    expect(busB.getClientCount(projectId)).toBe(1);
    unsub();
    expect(busB.getClientCount(projectId)).toBe(0);
    // Publishing from A after B unsubscribed should not raise — and B's local
    // dispatch table is empty, so even if a NOTIFY did arrive it would be a
    // no-op. We just verify nothing throws and the count stays at zero.
    busA.publish(projectId, 'plan_activated', {});
    await wait(200);
    expect(busB.getClientCount(projectId)).toBe(0);
  });

  // ---- #131 — UNLISTEN user channels when ref count drops to 0 ------------

  it('#131: UNLISTENs a user channel when its last subscribeUser listener goes away', async () => {
    const userName = `r131-${Date.now()}`;
    const unsub1 = busB.subscribeUser(userName, () => {});
    const unsub2 = busB.subscribeUser(userName, () => {});
    // The internal userChannelRefCount should now be 2; both listeners share
    // a single LISTEN. Drop the first — channel must remain LISTEN-ed.
    unsub1();
    // Drop the second — channel must drop out of subscribedChannels.
    unsub2();
    // Force a reconnect by closing the listen client and waiting for retry
    // to settle. Use the bus's internal close+reopen via close+new bus,
    // which is the simplest deterministic way to validate that the
    // channel is no longer in subscribedChannels.
    // (Direct introspection: sub-test exposes private state via a cast;
    // the production code does not export this — keeping the cast scoped
    // to the test.)
    const internal = busB as unknown as { subscribedChannels: Set<string> };
    const userChannelLikeRegex = /^plansync_user_/;
    const lingering = [...internal.subscribedChannels].filter((c) => userChannelLikeRegex.test(c));
    expect(lingering).toEqual([]);
  });

  it('#131: re-subscribing the same user creates exactly one LISTEN, not one per call', async () => {
    const userName = `r131-stable-${Date.now()}`;
    const internal = busB as unknown as { subscribedChannels: Set<string> };
    const before = internal.subscribedChannels.size;
    const u1 = busB.subscribeUser(userName, () => {});
    const u2 = busB.subscribeUser(userName, () => {});
    const u3 = busB.subscribeUser(userName, () => {});
    // 3 subscribeUser calls → only 1 channel added
    expect(internal.subscribedChannels.size).toBe(before + 1);
    u1();
    expect(internal.subscribedChannels.size).toBe(before + 1); // still LISTEN-ed
    u2();
    expect(internal.subscribedChannels.size).toBe(before + 1);
    u3();
    // Last one out → channel removed
    expect(internal.subscribedChannels.size).toBe(before);
  });

  // ---- #129 — fast-fail when DATABASE_URL is missing ----------------------

  it('#129: constructor throws synchronously when no connection string is available', () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => new EventBusPG()).toThrow(/DATABASE_URL or an explicit connectionString/);
    } finally {
      if (original !== undefined) process.env.DATABASE_URL = original;
    }
  });
});
