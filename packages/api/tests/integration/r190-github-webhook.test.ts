/**
 * R-190: GitHub webhook receiver.
 *
 * Acceptance from REMEDIATION_PLAN.md:
 *   "错 HMAC → 401；正确 push → domain_events 表新增一行 eventType='github_push'；
 *    payload 字段 schema-parse 通过"
 *
 * The route lives at packages/api/src/app/api/integrations/github/webhook/route.ts.
 * It looks up the project by `repository.full_name`, verifies an
 * `X-Hub-Signature-256` HMAC against `Project.githubWebhookSecret`, and
 * persists a single `github_push` / `github_pull_request` /
 * `github_pull_request_review` row in `domain_events` via the transactional
 * outbox writer.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { domainEventPayloadSchema } from '@plansync/shared';
import { POST as webhookPost } from '@/app/api/integrations/github/webhook/route';
import * as outboxModule from '@/lib/outbox';

const prisma = new PrismaClient();

function uniqueRepoSlug(): string {
  return `r190/${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function signBody(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function makeWebhookReq(opts: {
  body: unknown;
  signature: string | null;
  event: string;
  deliveryId?: string;
}): NextRequest {
  const raw = JSON.stringify(opts.body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': opts.event,
    'x-github-delivery': opts.deliveryId ?? `r190-delivery-${Math.random().toString(36).slice(2)}`,
  };
  if (opts.signature !== null) {
    headers['x-hub-signature-256'] = opts.signature;
  }
  return new NextRequest('http://localhost/api/integrations/github/webhook', {
    method: 'POST',
    headers,
    body: raw,
  });
}

describe('R-190 GitHub webhook receiver', () => {
  const secret = 's3cret-shhh';
  let projectId: string;
  let repoSlug: string;

  beforeAll(async () => {
    repoSlug = uniqueRepoSlug();
    const proj = await prisma.project.create({
      data: {
        name: `r190-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        phase: 'planning',
        createdBy: 'r190-owner',
        githubRepo: repoSlug,
        githubWebhookSecret: secret,
      },
    });
    projectId = proj.id;
  });

  afterAll(async () => {
    await prisma.domainEvent.deleteMany({ where: { projectId } });
    await prisma.project.delete({ where: { id: projectId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('rejects a request with an invalid HMAC signature with 401 and does not write to the outbox', async () => {
    const body = {
      ref: 'refs/heads/main',
      repository: { full_name: repoSlug },
      commits: [{ id: 'deadbeef', message: 'noop' }],
    };

    const res = await webhookPost(
      makeWebhookReq({
        body,
        signature: 'sha256=' + 'f'.repeat(64), // syntactically valid, but wrong
        event: 'push',
      }),
    );

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error?.code).toBe('UNAUTHORIZED');

    // No outbox row should be created for an unauthenticated request.
    const rows = await prisma.domainEvent.findMany({
      where: { projectId, eventType: 'github_push' },
    });
    expect(rows).toHaveLength(0);
  });

  it('accepts a valid push, writes one domain_events row with eventType=github_push, and the payload parses against the shared schema', async () => {
    const body = {
      ref: 'refs/heads/main',
      after: '0123456789abcdef0123456789abcdef01234567',
      repository: { full_name: repoSlug },
      commits: [{ id: '0123456789abcdef0123456789abcdef01234567', message: 'feat: add thing' }],
    };
    const raw = JSON.stringify(body);
    const signature = signBody(secret, raw);
    const deliveryId = `r190-good-${Date.now()}`;

    // We must hand-build the request so the signed `raw` string and the
    // body the route reads via `req.text()` are byte-identical.
    const req = new NextRequest('http://localhost/api/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': signature,
      },
      body: raw,
    });

    const res = await webhookPost(req);
    expect(res.status).toBe(200);

    const rows = await prisma.domainEvent.findMany({
      where: { projectId, eventType: 'github_push' },
      orderBy: { id: 'asc' },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.eventType).toBe('github_push');
    expect(row.projectId).toBe(projectId);
    expect(row.deliveredAt).toBeNull();

    // The stored payload must validate against the shared discriminated union.
    const parsed = domainEventPayloadSchema.safeParse(row.payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('github_push');
      const data = parsed.data.data as {
        deliveryId?: string;
        repository?: string;
        payload?: { ref?: string };
      };
      expect(data.deliveryId).toBe(deliveryId);
      expect(data.repository).toBe(repoSlug);
      expect(data.payload?.ref).toBe('refs/heads/main');
    }
  });

  it('returns 401 when the repo slug is not tracked by any project', async () => {
    const body = {
      repository: { full_name: 'never/seen-' + Math.random().toString(36).slice(2) },
    };
    const raw = JSON.stringify(body);
    const res = await webhookPost(
      new NextRequest('http://localhost/api/integrations/github/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-hub-signature-256': signBody(secret, raw),
        },
        body: raw,
      }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 202 (ignored) for an event type we do not yet handle', async () => {
    const body = { repository: { full_name: repoSlug } };
    const raw = JSON.stringify(body);
    const res = await webhookPost(
      new NextRequest('http://localhost/api/integrations/github/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues', // not in EVENT_TYPE_MAP
          'x-hub-signature-256': signBody(secret, raw),
        },
        body: raw,
      }),
    );
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.data?.ignored).toBe(true);
  });

  it('returns 200 for a `ping` event (GitHub initial handshake) without persisting a row', async () => {
    const body = {
      zen: 'Approachable is better than simple.',
      repository: { full_name: repoSlug },
    };
    const raw = JSON.stringify(body);
    const res = await webhookPost(
      new NextRequest('http://localhost/api/integrations/github/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'ping',
          'x-hub-signature-256': signBody(secret, raw),
        },
        body: raw,
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data?.ping).toBe(true);

    // Ping must not create a github_push row.
    const rows = await prisma.domainEvent.findMany({
      where: { projectId, eventType: 'github_push' },
    });
    // The earlier "valid push" test wrote exactly one row; ping must not
    // add another.
    expect(rows.length).toBe(1);
  });

  // Closes #781 #793 #797 #806: the receiver previously called
  // `outbox.emitOutOfTx`, which logs-and-swallows. A DB failure (validation,
  // FK, transient) therefore left the route returning 200 to GitHub, which
  // marks the delivery success and never retries → permanent silent loss.
  // The fix wraps emit() in an explicit prisma.$transaction and surfaces
  // a 5xx so GitHub re-delivers.
  //
  // R3 update (closes #932 #950): the route now uses a single
  // `prisma.$transaction(...)` covering ALL per-project emits, so we
  // spy on `outbox.emit` (the in-tx variant) rather than
  // `emitOutOfTxStrict`.
  it('returns 503 when outbox persistence fails so GitHub will redeliver (closes #781 #793 #797 #806)', async () => {
    const body = {
      ref: 'refs/heads/main',
      after: '0123456789abcdef0123456789abcdef01234567',
      repository: { full_name: repoSlug },
      commits: [{ id: '0123456789abcdef0123456789abcdef01234567', message: 'feat: x' }],
    };
    const raw = JSON.stringify(body);

    const spy = vi
      .spyOn(outboxModule.outbox, 'emit')
      .mockRejectedValueOnce(new Error('simulated DB failure'));

    try {
      const res = await webhookPost(
        new NextRequest('http://localhost/api/integrations/github/webhook', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-github-event': 'push',
            'x-github-delivery': `r190-fail-${Date.now()}`,
            'x-hub-signature-256': signBody(secret, raw),
          },
          body: raw,
        }),
      );

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.error?.code).toBe('OUTBOX_PERSIST_FAILED');
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // R3 (closes #932 #950): a multi-project repo (one slug → N projects)
  // must persist all rows in ONE transaction. If project N fails after
  // project 1 committed in its own tx, GitHub's redelivery on 503 would
  // make project 1 receive a duplicate. With one outer tx, the failed
  // emit aborts the whole batch — the redelivered request finds an
  // empty state and retries cleanly.
  it('persists multi-project rows atomically (closes #932 #950)', async () => {
    // Add a second project sharing the same repo slug.
    const proj2 = await prisma.project.create({
      data: {
        name: `r190-multi-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        phase: 'planning',
        createdBy: 'r190-owner',
        githubRepo: repoSlug,
        githubWebhookSecret: secret,
      },
    });

    const body = {
      ref: 'refs/heads/main',
      after: '0123456789abcdef0123456789abcdef01234567',
      repository: { full_name: repoSlug },
      commits: [{ id: '0123456789abcdef0123456789abcdef01234567', message: 'feat: multi' }],
    };
    const raw = JSON.stringify(body);
    const deliveryId = `r190-multi-fail-${Date.now()}`;

    // Make the SECOND emit call fail. The outer tx must roll back
    // the FIRST insert too.
    let callCount = 0;
    const spy = vi
      .spyOn(outboxModule.outbox, 'emit')
      .mockImplementation(async (tx, type, input) => {
        callCount += 1;
        if (callCount === 2) throw new Error('simulated mid-batch failure');
        // Forward to the original implementation so the first row exists
        // *inside the tx* — the rollback is what we're asserting.
        const original = vi.mocked(outboxModule.outbox.emit).getMockName();
        await (await import('@/lib/outbox')).emit(tx, type, input);
        void original;
      });

    try {
      const res = await webhookPost(
        new NextRequest('http://localhost/api/integrations/github/webhook', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-github-event': 'push',
            'x-github-delivery': deliveryId,
            'x-hub-signature-256': signBody(secret, raw),
          },
          body: raw,
        }),
      );

      expect(res.status).toBe(503);

      // Critical assertion: NO domain_events row was committed for
      // EITHER project. If the route had used per-project tx loops
      // pre-R3, the first project's row would still be here.
      const rowsForProj1 = await prisma.domainEvent.findMany({
        where: { projectId, eventType: 'github_push' },
      });
      const rowsForProj2 = await prisma.domainEvent.findMany({
        where: { projectId: proj2.id, eventType: 'github_push' },
      });
      // The earlier "valid push" test wrote one row for projectId; that
      // baseline is unchanged. proj2 must have ZERO rows for this
      // failed delivery.
      expect(
        rowsForProj1.find((r) => {
          const data = r.payload as { data?: { deliveryId?: string } } | null;
          return data?.data?.deliveryId === deliveryId;
        }),
      ).toBeUndefined();
      expect(rowsForProj2).toHaveLength(0);
    } finally {
      spy.mockRestore();
      await prisma.domainEvent.deleteMany({ where: { projectId: proj2.id } });
      await prisma.project.delete({ where: { id: proj2.id } }).catch(() => {});
    }
  });

  // R-new3 (closes #1005): GitHub redelivers a webhook on every non-2xx
  // response, AND on its own retry schedule for "uncertain" deliveries.
  // Without explicit dedup, each redelivery wrote a fresh outbox row
  // (same X-GitHub-Delivery → duplicate downstream events). The fix
  // inserts into inbound_webhook_deliveries inside the same tx; the
  // unique(source, deliveryId) constraint catches the redelivery and
  // we short-circuit with 200.
  it('dedupes a redelivered X-GitHub-Delivery (closes #1005)', async () => {
    const body = {
      ref: 'refs/heads/main',
      after: '0123456789abcdef0123456789abcdef01234567',
      repository: { full_name: repoSlug },
      commits: [{ id: '0123456789abcdef0123456789abcdef01234567', message: 'feat: dedup' }],
    };
    const raw = JSON.stringify(body);
    const deliveryId = `r190-dedup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sig = signBody(secret, raw);

    const fire = (): Promise<Response> =>
      webhookPost(
        new NextRequest('http://localhost/api/integrations/github/webhook', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-github-event': 'push',
            'x-github-delivery': deliveryId,
            'x-hub-signature-256': sig,
          },
          body: raw,
        }),
      );

    // First delivery — normal success path, 1 outbox row written.
    const first = await fire();
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(firstJson.data?.deduped).not.toBe(true);

    const rowsAfterFirst = await prisma.domainEvent.findMany({
      where: { projectId, eventType: 'github_push' },
    });
    const firstHits = rowsAfterFirst.filter((r) => {
      const data = r.payload as { data?: { deliveryId?: string } } | null;
      return data?.data?.deliveryId === deliveryId;
    });
    expect(firstHits).toHaveLength(1);

    // SECOND delivery — same delivery ID. Pre-fix this would write a
    // SECOND outbox row. Post-fix the unique(source, deliveryId)
    // constraint trips P2002, the route returns 200 + deduped=true,
    // and no new outbox row appears.
    const second = await fire();
    expect(second.status).toBe(200);
    const secondJson = await second.json();
    expect(secondJson.data?.deduped).toBe(true);

    const rowsAfterSecond = await prisma.domainEvent.findMany({
      where: { projectId, eventType: 'github_push' },
    });
    const secondHits = rowsAfterSecond.filter((r) => {
      const data = r.payload as { data?: { deliveryId?: string } } | null;
      return data?.data?.deliveryId === deliveryId;
    });
    expect(secondHits).toHaveLength(1);
  });
});
