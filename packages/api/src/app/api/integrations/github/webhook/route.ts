import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { outbox } from '@/lib/outbox';
import { logger } from '@/lib/logger';
import type { DomainEventType } from '@plansync/shared';

/**
 * R-190: receive GitHub webhook events (`push`, `pull_request`,
 * `pull_request_review`) and persist them to the transactional outbox so
 * downstream consumers (R-191 commit↔deliverable linker, R-192 task
 * auto-state, ...) can fan them out without coupling to the HTTP receiver.
 *
 * Routing model: the receiver looks up the project(s) by
 * `repository.full_name` (the `owner/repo` slug stored in
 * `projects.github_repo`) and verifies the request HMAC against the
 * matching project's `github_webhook_secret`. A single GitHub webhook
 * configured at the repo level may therefore feed multiple PlanSync
 * projects (different scopes / monorepo subtrees) — each project gets its
 * own outbox row.
 *
 * Security: every request **must** carry a valid
 * `X-Hub-Signature-256: sha256=<hex>` header. Mismatch / missing → 401.
 * GitHub computes the signature over the **raw request body**, so we read
 * `req.text()` once and feed that exact string into both the HMAC verifier
 * and `JSON.parse`. Reading `req.json()` first and re-stringifying would
 * silently drop whitespace and fail validation.
 *
 * Unsupported events return 202 (accepted, ignored) so GitHub does not mark
 * the delivery as failed and start retrying.
 */

const HMAC_HEADER = 'x-hub-signature-256';
const EVENT_HEADER = 'x-github-event';
const DELIVERY_HEADER = 'x-github-delivery';

const EVENT_TYPE_MAP: Record<string, DomainEventType> = {
  push: 'github_push',
  pull_request: 'github_pull_request',
  pull_request_review: 'github_pull_request_review',
};

function timingSafeEqualHex(a: string, b: string): boolean {
  // crypto.timingSafeEqual throws if lengths differ — guard up-front so an
  // attacker cannot use the exception to distinguish "wrong length" from
  // "wrong bytes".
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

function verifySignature(secret: string, body: string, header: string | null): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  return timingSafeEqualHex(expected, header);
}

interface GithubRepository {
  full_name?: unknown;
}

interface GithubEnvelope {
  repository?: GithubRepository;
}

function extractRepoSlug(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const repo = (payload as GithubEnvelope).repository;
  if (!repo || typeof repo.full_name !== 'string') return null;
  return repo.full_name;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const deliveryId = req.headers.get(DELIVERY_HEADER) ?? null;
  const eventName = req.headers.get(EVENT_HEADER) ?? '';
  const signature = req.headers.get(HMAC_HEADER);

  // GitHub sends a one-shot `ping` event when a webhook is first
  // configured. Reply 200 without persisting so the GitHub UI shows the
  // hook as healthy, but only after we've verified the signature against
  // *some* project's secret — otherwise an attacker could probe the
  // endpoint freely with `X-GitHub-Event: ping`.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    logger.warn({ err, deliveryId }, 'github webhook: failed to read body');
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Unable to read request body' } },
      { status: 400 },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Invalid JSON payload' } },
      { status: 400 },
    );
  }

  const repoSlug = extractRepoSlug(payload);
  if (!repoSlug) {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Missing repository.full_name' } },
      { status: 400 },
    );
  }

  // Look up every project subscribed to this repo. We grab the secret
  // column for each so we can verify the HMAC project-by-project; the
  // first project whose secret validates the signature is the authority.
  // Returning 401 on no-match means a misconfigured repo cannot accidentally
  // succeed with a forged signature.
  const projects = await prisma.project.findMany({
    where: { githubRepo: repoSlug },
    select: { id: true, githubWebhookSecret: true },
  });
  if (projects.length === 0) {
    // No project owns this repo — refuse cleanly. We return 401 (not 404)
    // because exposing "this repo is not tracked" leaks project topology
    // to anyone who can hit the endpoint.
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Signature verification failed' } },
      { status: 401 },
    );
  }

  const verified = projects.filter(
    (p) =>
      typeof p.githubWebhookSecret === 'string' &&
      p.githubWebhookSecret.length > 0 &&
      verifySignature(p.githubWebhookSecret, rawBody, signature),
  );
  if (verified.length === 0) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Signature verification failed' } },
      { status: 401 },
    );
  }

  if (eventName === 'ping') {
    return NextResponse.json({ data: { ok: true, ping: true } }, { status: 200 });
  }

  const eventType = EVENT_TYPE_MAP[eventName];
  if (!eventType) {
    // Accepted-but-ignored: keep GitHub happy without persisting a noise row.
    return NextResponse.json(
      { data: { ok: true, ignored: true, event: eventName } },
      { status: 202 },
    );
  }

  // Persist one outbox row per matching project so downstream consumers
  // can fan out independently. We use `outbox.emit` inside an explicit
  // tx (NOT the best-effort `emitOutOfTx`) because we're an HTTP
  // receiver and the outbox row is the *only* durable record of the
  // event. If persistence fails we MUST surface a 5xx so GitHub
  // re-delivers — the previous best-effort helper swallowed errors and
  // let GitHub mark the delivery as success, dropping the event
  // permanently (closes #781 #793 #797 #806).
  //
  // R3 (closes #932 #950): single-tx covers all per-project rows so a
  // partial commit can't leave one project with a duplicated row when
  // GitHub redelivers on 503.
  //
  // R-new3 (closes #1005): GitHub will redeliver a webhook on ANY non-
  // 2xx response (transient network blip, our own 5xx, ...). Without
  // explicit dedup, each redelivery wrote a fresh outbox row per
  // matching project even on success — same X-GitHub-Delivery,
  // duplicate downstream events. The fix: in the same tx, INSERT a row
  // into inbound_webhook_deliveries with UNIQUE(source, delivery_id).
  // A repeat delivery hits the unique constraint, the tx rolls back,
  // and we short-circuit with 200 (no fan-out, no retry).
  if (!deliveryId) {
    // GitHub always sends X-GitHub-Delivery; a missing header means the
    // request didn't come from GitHub's infrastructure. We refuse to fan
    // out without it because we have no way to dedupe.
    logger.warn({ eventName, repoSlug }, 'github webhook: missing X-GitHub-Delivery header');
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'X-GitHub-Delivery header is required' } },
      { status: 400 },
    );
  }
  try {
    await prisma.$transaction(async (tx) => {
      // The dedup row goes FIRST so a duplicate fails fast before any
      // outbox write happens. The unique constraint
      // (source, delivery_id) is what makes this race-free.
      await tx.inboundWebhookDelivery.create({
        data: { source: 'github', deliveryId },
      });
      for (const project of verified) {
        await outbox.emit(tx, eventType, {
          projectId: project.id,
          data: {
            deliveryId,
            repository: repoSlug,
            payload,
          },
        });
      }
    });
  } catch (err) {
    // R-new3 — Prisma surfaces unique-violation as P2002. That means
    // we've already processed this delivery; tell GitHub all-good so
    // it stops retrying.
    const code = (err as { code?: string } | null)?.code;
    if (code === 'P2002') {
      logger.info(
        { deliveryId, eventName, repoSlug },
        'github webhook: dedup hit, this delivery was already processed; returning 200',
      );
      return NextResponse.json({ data: { ok: true, deduped: true, deliveryId } }, { status: 200 });
    }
    logger.error(
      {
        err,
        deliveryId,
        eventName,
        repoSlug,
        projects: verified.map((p) => p.id),
      },
      'github webhook: outbox persistence failed, returning 503 so GitHub will retry',
    );
    return NextResponse.json(
      {
        error: {
          code: 'OUTBOX_PERSIST_FAILED',
          message: 'Webhook receiver failed to persist event; please retry',
        },
      },
      { status: 503 },
    );
  }

  return NextResponse.json(
    {
      data: {
        ok: true,
        event: eventName,
        projects: verified.map((p) => p.id),
      },
    },
    { status: 200 },
  );
}
