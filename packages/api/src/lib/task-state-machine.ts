/**
 * R-192: derive task completion state from git + verification rule
 * signals so the agent's `action=complete` call is no longer a unilateral
 * status flip.
 *
 * Previously, an agent that satisfied the R-181 declarative rules and
 * the drift gate was free to mark the task `done` regardless of whether
 * any real-world git evidence had landed. With R-190 (webhook ingest)
 * and R-191 (commit↔deliverable link) in place we can now require that:
 *
 *   1. `pr_merged`            — the task's `prUrl` resolves to a merged
 *                               GitHub pull request event in the outbox.
 *   2. `deliverable_evidence` — every deliverable the task is bound to
 *                               (`task.planDeliverableRefs`) has at
 *                               least one row in `commit_deliverable_links`
 *                               for this project (via the commit linker).
 *   3. `drift_open`           — defense-in-depth check. The route's
 *                               existing drift gate (R-006) already 409s
 *                               on open drift before we get here, but if
 *                               that ever moves we don't want a silent
 *                               regression to auto-advance.
 *
 * Behaviour:
 *   - If every applicable check passes, the route flips `task.status =
 *     'done'` exactly as before.
 *   - If any check is missing, the task transitions to the new
 *     `awaiting_evidence` status and the API response carries a
 *     `missing: [...]` array enumerating what blocked auto-done. The
 *     agent (or owner) can satisfy the missing signal and re-call
 *     complete — the route will re-derive the state and finish the
 *     transition once everything lines up.
 *
 * Backwards compatibility:
 *   - The gate is OFF when neither the task nor the project carries any
 *     git wiring (no `task.prUrl`, no `project.githubRepo`). Tasks that
 *     pre-date the git-integration era keep their pre-R-192 behaviour
 *     so the change is safe to land before every project has opted in.
 *   - The gate is also OFF when the task has no `planDeliverableRefs`,
 *     because there is nothing for the commit-linker to anchor on. A
 *     project can therefore migrate one task at a time by populating
 *     refs + PRs incrementally.
 *
 * The state machine is intentionally a pure function over a snapshot of
 * the task, the request body, and a few Prisma helpers. Tests can call
 * `deriveTaskCompletionState` directly without spinning up the full
 * complete route, which keeps the verification surface (`vitest: PR 未
 * 合并 → status='awaiting_evidence'`) small and focused.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from './prisma';

export type TaskCompletionMissingCode = 'pr_merged' | 'deliverable_evidence' | 'drift_open';

export interface TaskCompletionMissing {
  /** Stable machine-readable code; matches the verification fixture. */
  code: TaskCompletionMissingCode;
  /** Human-readable explanation for CLI / UI consumption. */
  message: string;
  /** Optional structured payload to help the owner triage. */
  details?: Record<string, unknown>;
}

export type DerivedTaskStatus = 'done' | 'awaiting_evidence';

export interface DeriveTaskCompletionStateInput {
  projectId: string;
  task: {
    id: string;
    prUrl?: string | null;
    planDeliverableRefs?: string[] | null;
    /**
     * The plan version the task is currently bound to. Used to scope the
     * deliverable-evidence lookup so a same-slug deliverable on a
     * superseded plan version cannot satisfy the gate for this task.
     * Optional for backwards compatibility — callers that don't supply
     * it fall back to the legacy project-scoped lookup, which is
     * pre-fix behaviour (still correct for projects that never
     * renamed/re-keyed a deliverable across versions).
     */
    boundPlanVersion?: number | null;
  };
  prismaClient?: Prisma.TransactionClient | PrismaClient;
}

export interface DeriveTaskCompletionStateResult {
  /** Resolved status to write back to `Task.status`. */
  status: DerivedTaskStatus;
  /**
   * When `status === 'awaiting_evidence'`, the list of signals the
   * caller must produce before the next complete attempt will flip the
   * task to `done`. Empty when `status === 'done'`.
   */
  missing: TaskCompletionMissing[];
  /**
   * True iff the R-192 gate evaluated any check at all. When false (no
   * git wiring on the task or project) the caller is expected to fall
   * back to the legacy "always done" behaviour so projects that have
   * not opted into git integration are not silently broken.
   */
  gateApplied: boolean;
}

/**
 * Walks the (task + project) wiring and decides whether enough git
 * evidence exists to auto-advance the task to `done`. Returns the
 * resolved status plus the list of missing signals so the route can
 * echo them back to the caller.
 *
 * The helper does NOT mutate any rows; the caller owns the
 * `task.update({ status })` write so the same transaction can stitch
 * the status flip in next to the existing run finalize.
 */
export async function deriveTaskCompletionState(
  input: DeriveTaskCompletionStateInput,
): Promise<DeriveTaskCompletionStateResult> {
  const client = input.prismaClient ?? defaultPrisma;
  const { task, projectId } = input;

  // Pre-flight: is git integration applicable to this task at all?
  // We check both the task-level signal (prUrl was set by the agent or
  // a prior PATCH) and the project-level signal (the owner registered
  // a githubRepo). When neither is present, the gate stays silent and
  // the caller falls back to legacy "always done".
  const project = await client.project.findUnique({
    where: { id: projectId },
    select: { githubRepo: true },
  });
  const hasTaskPrUrl = typeof task.prUrl === 'string' && task.prUrl.length > 0;
  const hasProjectRepo = typeof project?.githubRepo === 'string' && project.githubRepo.length > 0;
  if (!hasTaskPrUrl && !hasProjectRepo) {
    return { status: 'done', missing: [], gateApplied: false };
  }

  const missing: TaskCompletionMissing[] = [];

  // ---- Check 1: PR merged --------------------------------------
  // We require a `prUrl` to even attempt the check — without one we
  // have nothing to match against, and the gate falls back to the
  // looser "git integration not wired for this task yet" branch by
  // declaring the PR signal missing. This way an opt-in project that
  // registers a repo cannot accidentally auto-done tasks that never
  // attached a PR.
  if (!hasTaskPrUrl) {
    missing.push({
      code: 'pr_merged',
      message:
        'Task has no pr_url. Attach the pull request URL to the task before completing so the system can verify it merged.',
    });
  } else {
    const merged = await prUrlIsMerged(client, projectId, task.prUrl!);
    if (!merged) {
      missing.push({
        code: 'pr_merged',
        message: `Pull request ${task.prUrl} has not been observed as merged. Wait for the GitHub webhook to deliver the close+merged event.`,
        details: { prUrl: task.prUrl },
      });
    }
  }

  // ---- Check 2: deliverable evidence ---------------------------
  // Every deliverable the task is bound to (via the legacy
  // `planDeliverableRefs` String[] of slugs, which is kept in sync with
  // the R-153 `TaskDeliverableLink` table by the plan-items writer)
  // must have at least one CommitDeliverableLink row visible to this
  // project. A task with no refs at all is treated as "no evidence
  // requirement" — the constraint is opt-in per task.
  const refs = (task.planDeliverableRefs ?? []).filter(
    (r) => typeof r === 'string' && r.length > 0,
  );
  if (refs.length > 0) {
    const missingRefs = await deliverableRefsWithoutEvidence(
      client,
      projectId,
      refs,
      task.boundPlanVersion ?? null,
    );
    if (missingRefs.length > 0) {
      missing.push({
        code: 'deliverable_evidence',
        message: `No commit linked to ${missingRefs.length} deliverable(s): ${missingRefs.join(', ')}. Tag the commit message with [deliverable:<slug>] or update the deliverable's file_glob so the linker picks it up.`,
        details: { missingDeliverableRefs: missingRefs },
      });
    }
  }

  // ---- Check 3: drift open (defense-in-depth) ------------------
  // The upstream route gate already 409s on open drift, but if that
  // gate is ever loosened (or a future code path skips it), we'd
  // rather block the auto-done than silently advance into the unsafe
  // state. The check is cheap and the duplication is intentional.
  const openDriftCount = await client.driftAlert.count({
    where: { taskId: task.id, status: 'open' },
  });
  if (openDriftCount > 0) {
    missing.push({
      code: 'drift_open',
      message: `${openDriftCount} drift alert(s) are still open on this task. Resolve them before completing.`,
      details: { openDriftCount },
    });
  }

  if (missing.length === 0) {
    return { status: 'done', missing: [], gateApplied: true };
  }
  return { status: 'awaiting_evidence', missing, gateApplied: true };
}

/**
 * Returns true iff a `github_pull_request` event matching `prUrl` was
 * observed with `action ∈ {closed}` AND `pull_request.merged === true`.
 *
 * We search the `domain_events` table directly because R-160 writes
 * every GitHub webhook into it (see R-190). The query is a small index
 * scan keyed by `(eventType, projectId)`; the JSON containment filter
 * (`@>`) lets Postgres push the merged + html_url comparison down to
 * the row level rather than streaming every PR event back to Node.
 */
async function prUrlIsMerged(
  client: Prisma.TransactionClient | PrismaClient,
  projectId: string,
  prUrl: string,
): Promise<boolean> {
  // We compare against the raw GitHub payload at
  // `data.payload.pull_request.html_url`, which is the canonical URL
  // GitHub puts in webhook events. Some teams paste the `/files`
  // variant into the task — strip trailing extras so the comparison is
  // robust without doing a full URL canonicalisation pass.
  const normalized = normalizePrUrl(prUrl);
  type Row = { id: bigint };
  // We can't use Prisma's typed query here because `payload` is a free
  // Json column; a raw query keeps the Postgres-side JSON walk while
  // staying parameterised against SQL injection.
  const rows = await client.$queryRaw<Row[]>`
    SELECT id
    FROM domain_events
    WHERE event_type = 'github_pull_request'
      AND project_id = ${projectId}
      AND payload -> 'data' -> 'payload' ->> 'action' = 'closed'
      AND (payload -> 'data' -> 'payload' -> 'pull_request' ->> 'merged')::boolean = true
      AND payload -> 'data' -> 'payload' -> 'pull_request' ->> 'html_url' = ${normalized}
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * GitHub's `html_url` for a PR is the canonical
 * `https://github.com/<owner>/<repo>/pull/<n>` shape. Strip any
 * fragment / trailing slash / `/files` suffix that teams sometimes
 * paste so the equality check above lines up. We intentionally do NOT
 * downcase the path: GitHub repo names are case-sensitive on the
 * filesystem side.
 */
export function normalizePrUrl(raw: string): string {
  let url = raw.trim();
  // Strip URL fragments (#issuecomment-...) and query strings.
  const hashAt = url.indexOf('#');
  if (hashAt !== -1) url = url.slice(0, hashAt);
  const queryAt = url.indexOf('?');
  if (queryAt !== -1) url = url.slice(0, queryAt);
  // Strip trailing slashes and `/files`/`/commits` tab suffixes.
  url = url.replace(/\/(files|commits)\/?$/, '');
  url = url.replace(/\/+$/, '');
  return url;
}

/**
 * Returns the subset of `refs` that have NO matching
 * commit_deliverable_links row for this project. We resolve refs by
 * slug → PlanDeliverable.id first (the link table is keyed by id, not
 * slug), then count rows per deliverable in a single grouped query so
 * the gate is O(1) DB round-trip regardless of how many refs the task
 * declares.
 *
 * Refs that don't resolve to any PlanDeliverable (e.g. an older task
 * that pre-dates the R-150 split tables) are treated as "missing
 * evidence" so a stale ref doesn't silently pass the gate.
 *
 * Closes #1212 #1190 #1182 #1178 #1174 #1160 #1137 — when a project
 * has multiple plan versions with the same deliverable slug (the
 * common case: an `auth` deliverable kept across v1 → v2 → v3 of the
 * plan, possibly with a different `refUri`/`refType`), the pre-fix
 * lookup `{ slug: { in: refs }, plan: { projectId } }` matched the
 * deliverable row on EVERY version of the plan. A commit linked to
 * the v1 deliverable could then satisfy the gate for a task bound to
 * v3, even though the v3 deliverable spec might require completely
 * different work. We scope the lookup to the task's bound plan
 * version so cross-version evidence cannot leak.
 *
 * When `boundPlanVersion` is null/undefined (legacy callers) we fall
 * back to the previous project-wide lookup so projects that never
 * renamed a slug across versions keep working unchanged.
 */
async function deliverableRefsWithoutEvidence(
  client: Prisma.TransactionClient | PrismaClient,
  projectId: string,
  refs: string[],
  boundPlanVersion: number | null,
): Promise<string[]> {
  const planFilter =
    typeof boundPlanVersion === 'number' ? { projectId, version: boundPlanVersion } : { projectId };
  const deliverables = await client.planDeliverable.findMany({
    where: { slug: { in: refs }, plan: planFilter },
    select: { id: true, slug: true },
  });

  // Refs that didn't resolve to any deliverable row are unknown → block.
  const knownBySlug = new Map<string, string>();
  for (const d of deliverables) knownBySlug.set(d.slug, d.id);
  const unresolved = refs.filter((r) => !knownBySlug.has(r));

  if (deliverables.length === 0) {
    return unresolved;
  }

  // Count links per resolved deliverable in a single query.
  const linkCounts = await client.commitDeliverableLink.groupBy({
    by: ['deliverableId'],
    where: {
      projectId,
      deliverableId: { in: deliverables.map((d) => d.id) },
    },
    _count: { _all: true },
  });
  const withEvidence = new Set(linkCounts.map((row) => row.deliverableId));

  const missingResolved = deliverables.filter((d) => !withEvidence.has(d.id)).map((d) => d.slug);

  return [...unresolved, ...missingResolved];
}
