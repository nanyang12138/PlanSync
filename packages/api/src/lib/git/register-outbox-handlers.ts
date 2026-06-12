/**
 * R-192 / P0-0: wire the outbox `github_push` event onto the R-191
 * commit→deliverable linker.
 *
 * This is the missing seam. The pipeline was built end-to-end but never
 * connected:
 *
 *   webhook receiver ──▶ domain_events(github_push)   (R-190, live)
 *        ──▶ outbox consumer                            (R-162, live, opt-in)
 *        ──▶ [github_push handler]                      ◀── THIS FILE
 *        ──▶ linkCommitsFromPushPayload                 (R-191, live)
 *        ──▶ commit_deliverable_links
 *        ──▶ deriveTaskCompletionState                  (R-192, live)
 *        ──▶ task → done / awaiting_evidence
 *
 * Without a registered handler the consumer's dispatch loop treats every
 * `github_push` row as `skipped` (see outbox-consumer.ts) — the row sits
 * undelivered forever, no `commit_deliverable_links` are ever written, and
 * R-192 keeps every gated task parked in `awaiting_evidence` because the
 * evidence it reads is never produced. The link function had ZERO
 * production callers before this; it was reachable only from tests.
 *
 * Registration is adopt-once (the consumer rejects a double registration
 * for the same event type), so `registerGithubOutboxHandlers()` is called
 * exactly once from the dedicated worker entry point (`scripts/run-worker.ts`)
 * before `startOutboxConsumer()`. It is safe to call even when the consumer
 * is disabled (`PLANSYNC_OUTBOX_CONSUMER != "true"`): the handler simply
 * sits in the map and is never invoked.
 */
import { registerOutboxHandler, type OutboxDispatch } from '../outbox-consumer';
import { linkCommitsFromPushPayload, type GithubPushPayload } from './link-commits';
import { logger } from '../logger';

/**
 * Dispatch handler for `github_push` outbox rows.
 *
 * The outbox envelope is `{ type, projectId, userName, data }` (R-160);
 * the GitHub receiver (R-190) stores the raw push body at
 * `data.payload` and the PlanSync project id on the envelope's
 * `projectId` (one outbox row is fanned out per matching project, so the
 * project id MUST come from the row, not from the GitHub payload — the
 * payload has no notion of a PlanSync project).
 *
 * On a malformed row (no `projectId` or no `data.payload`) we THROW
 * rather than return. This is deliberate: the consumer marks a row
 * `delivered` the instant the handler returns normally, so a
 * warn-and-return would silently swallow a real push event and re-break
 * the very evidence chain this file exists to connect. Throwing leaves
 * the row undelivered, bumps its attempt counter, and logs an error —
 * the failure is loud and recoverable, not invisible. In practice a
 * legitimately-emitted row always carries `data.payload` (the receiver
 * writes it unconditionally), so this branch should never fire for real
 * traffic; if it ever does, that is a bug we want screaming, not hidden.
 */
export async function handleGithubPushEvent(dispatch: OutboxDispatch): Promise<void> {
  const { payload } = dispatch;
  const projectId = payload.projectId;
  const data = payload.data as Record<string, unknown> | undefined;
  const githubPayload = data?.payload as GithubPushPayload | undefined;

  if (!projectId || !githubPayload) {
    throw new Error(
      `R-192: malformed github_push outbox row (id=${dispatch.id.toString()}): ` +
        `missing ${!projectId ? 'projectId' : 'data.payload'}. Leaving the row ` +
        `undelivered so the bad event is loud rather than silently marked delivered.`,
    );
  }

  const result = await linkCommitsFromPushPayload({ projectId, payload: githubPayload });
  logger.info(
    {
      eventId: dispatch.id.toString(),
      projectId,
      commitsExamined: result.commitsExamined,
      linksCreated: result.created,
    },
    'R-192: github_push dispatched to commit→deliverable linker',
  );
}

/**
 * Register every git-related outbox handler. Called once at worker
 * startup before `startOutboxConsumer()`. Idempotency is enforced by the
 * consumer's own adopt-once guard (a second registration for the same
 * event type throws), so this must not be invoked more than once per
 * process — tests reset the handler map via `_resetOutboxHandlersForTests`
 * between cases.
 */
export function registerGithubOutboxHandlers(): void {
  registerOutboxHandler('github_push', handleGithubPushEvent);
}
