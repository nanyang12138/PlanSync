// R-090: SSE per-client backpressure / slow-client handling.
//
// A slow consumer must not block the dispatch path for other clients. We
// achieve that by giving every SSE connection a bounded per-client queue
// and force-closing the connection (so the client reconnects with a fresh
// state) when the queue overflows.
//
// Verification:
//   1) Slow client whose pending queue overflows receives a final
//      `backpressure_disconnect` frame and the stream closes.
//   2) A second, healthy client connected to the same project (and being
//      drained in parallel) keeps receiving events and never sees the
//      disconnect frame.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { GET as eventsGet } from '@/app/api/projects/[projectId]/events/route';
import { eventBus } from '@/lib/event-bus';
import { makeReq, createTestProject, createActivePlan, cleanupProject } from '../helpers/request';

describe('R-090: SSE per-client backpressure', () => {
  const owner = 'r090-owner';
  let projectId: string;
  const originalLimit = process.env.PLANSYNC_SSE_BUFFER_PER_CLIENT;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await createActivePlan(projectId, owner);
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  afterEach(() => {
    if (originalLimit === undefined) {
      delete process.env.PLANSYNC_SSE_BUFFER_PER_CLIENT;
    } else {
      process.env.PLANSYNC_SSE_BUFFER_PER_CLIENT = originalLimit;
    }
  });

  async function openStream() {
    const res = await eventsGet(makeReq(`/api/projects/${projectId}/events`, { userName: owner }), {
      params: { projectId },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    // Drain the initial `: connected\n\n` so subsequent reads correspond
    // to real events.
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe(': connected\n\n');
    return { reader, res };
  }

  it('slow client whose buffer overflows is force-closed; healthy peers keep receiving events', async () => {
    // Open the healthy client first with a generous buffer so a long
    // event burst cannot accidentally trip its overflow path. The route
    // re-reads PLANSYNC_SSE_BUFFER_PER_CLIENT on every connection.
    process.env.PLANSYNC_SSE_BUFFER_PER_CLIENT = '1024';
    const healthy = await openStream();

    // Drain the healthy stream concurrently — this models a real, fast
    // browser/CLI consumer and is the regression-relevant fixture: if
    // backpressure were shared across clients, the slow peer's overflow
    // would also stop *these* reads.
    const decoder = new TextDecoder();
    const healthyChunks: string[] = [];
    let healthyDone = false;
    const drainHealthy = (async () => {
      try {
        while (!healthyDone) {
          const { value, done } = await healthy.reader.read();
          if (done) return;
          healthyChunks.push(decoder.decode(value));
        }
      } catch {
        // Reader cancelled — ignore.
      }
    })();

    // Now open the slow client with a small buffer so we can trip
    // overflow on a handful of events.
    const slowLimit = 4;
    process.env.PLANSYNC_SSE_BUFFER_PER_CLIENT = String(slowLimit);
    const slow = await openStream();

    // Flood project events. The slow client never reads, so its pending
    // queue saturates almost immediately; the healthy drain loop keeps
    // pace.
    const total = slowLimit + 8;
    for (let i = 0; i < total; i++) {
      eventBus.publish(projectId, 'comment_added', { i });
    }

    // Drain the slow stream until EOF. Bounded loop so vitest times out
    // rather than hanging if the close path is broken.
    let sawDisconnect = false;
    for (let i = 0; i < 200; i++) {
      const { value, done } = await slow.reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      if (chunk.includes('event: backpressure_disconnect')) {
        sawDisconnect = true;
      }
    }
    expect(sawDisconnect).toBe(true);

    // Healthy client must still be receiving — publish one more event
    // *after* the slow stream collapsed and confirm it lands.
    eventBus.publish(projectId, 'comment_added', { tag: 'post-disconnect' });

    let postDisconnectReceived = false;
    for (let i = 0; i < 200; i++) {
      if (healthyChunks.some((c) => c.includes('"tag":"post-disconnect"'))) {
        postDisconnectReceived = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(postDisconnectReceived).toBe(true);

    // And the healthy client must never have been force-disconnected by
    // the slow peer's overflow.
    expect(healthyChunks.some((c) => c.includes('backpressure_disconnect'))).toBe(false);

    healthyDone = true;
    await healthy.reader.cancel();
    await drainHealthy;
  });
});
