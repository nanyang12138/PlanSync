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
 *   - The gate is two-stage opt-in:
 *
 *     1. **Project-level master switch**: the project must have
 *        `project.githubRepo` configured. Without it the webhook
 *        ingest (R-190) and commit-link plumbing (R-191) aren't
 *        wired at all, so neither `pr_merged` nor
 *        `deliverable_evidence` can ever be produced. Firing the
 *        gate in that state would trap any task that happens to
 *        carry `planDeliverableRefs` (set by the plan author for
 *        normal scope tracking) in `awaiting_evidence` with no
 *        recovery path. So the gate stays silent on
 *        non-GitHub-integrated projects (fixes #1331).
 *
 *     2. **Per-task opt-in** (within a GitHub-integrated project):
 *        the gate only fires when the task itself carries some git
 *        wiring, i.e. `task.prUrl` is non-empty OR
 *        `task.planDeliverableRefs` has at least one slug. Otherwise
 *        the task keeps its pre-R-192 "always done" behaviour even
 *        when the project has set `project.githubRepo`. This
 *        matters for the legacy migration story (fixes #1197): an
 *        owner that flips on GitHub integration must NOT
 *        retroactively trap every old task in `awaiting_evidence`.
 *        Each task can be migrated incrementally as the owner
 *        populates `prUrl` + refs.
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

  // Pre-flight stage 0: defense-in-depth drift guard.
  //
  // An open drift alert means the task is bound to a stale plan
  // version, so even a "no git wiring" task must NOT auto-flip to
  // `done` — the drift might invalidate the work entirely. The
  // route's R-006 gate is the primary 409 on open drift, but if
  // that gate is ever loosened (or a future code path skips it),
  // surfacing `drift_open` here keeps the helper fail-closed.
  //
  // CRITICAL: this check happens BEFORE the project-level
  // (`githubRepo`) and per-task (`prUrl` / `planDeliverableRefs`)
  // short-circuits below. Those branches return `status='done'`
  // with `gateApplied=false`, and pre-fix the helper would happily
  // flip a drifted task to `done` without ever consulting the
  // drift table — bypassing the very defense-in-depth check this
  // function advertises (closes #1422 / PR #1353 review finding).
  //
  // Drift overrides the legacy "always done" fallback intentionally:
  // the `gateApplied=false` contract exists so projects that never
  // opted into git integration are not silently broken by R-192's
  // evidence requirements, NOT so they can dodge drift correctness.
  const openDriftCount = await client.driftAlert.count({
    where: { taskId: task.id, status: 'open' },
  });
  if (openDriftCount > 0) {
    return {
      status: 'awaiting_evidence',
      missing: [
        {
          code: 'drift_open',
          message: `${openDriftCount} drift alert(s) are still open on this task. Resolve them before completing.`,
          details: { openDriftCount },
        },
      ],
      gateApplied: true,
    };
  }

  // Pre-flight stage 1: is git integration enabled at the *project*
  // level at all?
  //
  // `project.githubRepo` is the master switch for the R-190 webhook
  // ingest + R-191 commit→deliverable linker. Without it, no
  // GitHub event will ever land in `domain_events` and no row will
  // ever appear in `commit_deliverable_links` for this project — so
  // both the `pr_merged` and `deliverable_evidence` checks below are
  // guaranteed to fail forever. Firing the gate in that state would
  // trap any task that merely carries `planDeliverableRefs` (which
  // plan authors set for scope/coverage tracking, independent of any
  // GitHub wiring) in `awaiting_evidence` with no way out.
  //
  // Closes #1331: the previous revision used `planDeliverableRefs`
  // as an *independent* gate enable signal, which was wrong on
  // non-GitHub-integrated projects.
  const project = await client.project.findUnique({
    where: { id: projectId },
    select: { githubRepo: true },
  });
  const hasProjectGithubRepo =
    typeof project?.githubRepo === 'string' && project.githubRepo.length > 0;
  if (!hasProjectGithubRepo) {
    return { status: 'done', missing: [], gateApplied: false };
  }

  // Pre-flight stage 2: is git integration applicable to *this task*?
  //
  // Within a GitHub-integrated project the gate is still per-task
  // opt-in. A task opts in by carrying its own git wiring — either
  // `prUrl` (the agent attached a PR) or at least one entry in
  // `planDeliverableRefs` (the plan binds the task to a deliverable
  // the commit-linker can anchor on). When the task has neither, the
  // gate stays silent so legacy / pre-R-192 tasks keep flipping
  // straight to `done` (fixes #1197 — owner that flips on GitHub
  // integration must not retroactively trap every old task).
  const hasTaskPrUrl = typeof task.prUrl === 'string' && task.prUrl.length > 0;
  const refsList = (task.planDeliverableRefs ?? []).filter(
    (r) => typeof r === 'string' && r.length > 0,
  );
  const hasTaskDeliverableRefs = refsList.length > 0;
  if (!hasTaskPrUrl && !hasTaskDeliverableRefs) {
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
  //
  // We resolve the PR's merge info up-front (not just a boolean) so
  // Check 2 below can constrain deliverable evidence to commits that
  // actually belong to *this task's* PR. Without that constraint a
  // commit on an unrelated PR (or any historical commit that ever
  // touched the deliverable's file_glob in this project) would
  // silently satisfy the gate — see #1189 / PR #1076 review finding.
  let prShas: string[] = [];
  if (!hasTaskPrUrl) {
    missing.push({
      code: 'pr_merged',
      message:
        'Task has no pr_url. Attach the pull request URL to the task before completing so the system can verify it merged.',
    });
  } else {
    const prInfo = await findPrMergeInfo(client, projectId, task.prUrl!);
    if (!prInfo.merged) {
      missing.push({
        code: 'pr_merged',
        message: `Pull request ${task.prUrl} has not been observed as merged. Wait for the GitHub webhook to deliver the close+merged event.`,
        details: { prUrl: task.prUrl },
      });
    } else {
      prShas = prInfo.shas;
    }
  }

  // ---- Check 2: deliverable evidence ---------------------------
  // Every deliverable the task is bound to (via the legacy
  // `planDeliverableRefs` String[] of slugs, which is kept in sync with
  // the R-153 `TaskDeliverableLink` table by the plan-items writer)
  // must have at least one CommitDeliverableLink row whose SHA is
  // attributable to *this task's* merged PR. A task with no refs at
  // all is treated as "no evidence requirement" — the constraint is
  // opt-in per task.
  //
  // The SHA filter (closes #1189) is what binds evidence to the task.
  // Pre-fix, the lookup accepted any commit linked to the deliverable
  // anywhere in the project, so a stray historical commit (e.g. an
  // earlier PR that incidentally touched a file matching the
  // deliverable's `file_glob`) could mark a brand-new task `done`.
  // We now restrict to the SHAs we extracted from the PR's
  // pull_request webhook + the github_push that delivered its merge
  // commit. When the task has no merged PR (`prShas` empty), every
  // ref is reported as missing — fail-closed is the safe default for
  // an opt-in correctness gate.
  //
  // `refsList` was computed during the pre-flight above; we re-use it
  // here instead of re-filtering so the two branches stay in lock-step.
  if (hasTaskDeliverableRefs) {
    const missingRefs = await deliverableRefsWithoutEvidence(
      client,
      projectId,
      refsList,
      task.boundPlanVersion ?? null,
      prShas,
    );
    if (missingRefs.length > 0) {
      missing.push({
        code: 'deliverable_evidence',
        message: `No commit from this PR linked to ${missingRefs.length} deliverable(s): ${missingRefs.join(', ')}. Push a commit on the PR that touches the deliverable's file_glob, or tag the commit message with [deliverable:<slug>] so the linker picks it up.`,
        details: { missingDeliverableRefs: missingRefs },
      });
    }
  }

  // (drift_open is handled at pre-flight stage 0 above so the
  // defense-in-depth check cannot be bypassed by the short-circuit
  // branches that return `gateApplied=false`. Keeping it here would
  // be dead code on a fail-closed path.)

  if (missing.length === 0) {
    return { status: 'done', missing: [], gateApplied: true };
  }
  return { status: 'awaiting_evidence', missing, gateApplied: true };
}

/**
 * Result of looking up a PR's merge state in the domain-event outbox.
 *
 * `merged` mirrors the historical `prUrlIsMerged` boolean. `shas` is
 * the list of commit SHAs we attribute to this PR — used by the
 * deliverable-evidence check to bind evidence to *this task's* PR
 * rather than to any commit in the project (closes #1189):
 *
 *   1. `pull_request.merge_commit_sha` from the merged PR event — the
 *      canonical "this is what GitHub committed to the base branch"
 *      SHA. For squash merges this is the only commit; for merge
 *      commits it's the merge commit itself; for rebase merges it's
 *      the topmost rebased commit.
 *   2. `pull_request.head.sha` — the PR head at merge time. Useful
 *      when the linker has indexed the head commit of a feature
 *      branch (e.g. a `push` event arrived before the PR closed).
 *   3. Every commit in any `github_push` event whose `head_commit.id`
 *      equals `merge_commit_sha`. That push is what GitHub sent to
 *      the base branch when the PR merged, so its `commits[]` are
 *      precisely the constituent commits of this PR (covers the
 *      "merge commit" case where only the constituents carry file
 *      changes — the merge commit itself is empty).
 *
 * When the PR is closed-without-merge (or never merged), `merged` is
 * false and `shas` is empty; the caller treats this the same as
 * "no PR observed".
 */
interface PrMergeInfo {
  merged: boolean;
  shas: string[];
}

async function findPrMergeInfo(
  client: Prisma.TransactionClient | PrismaClient,
  projectId: string,
  prUrl: string,
): Promise<PrMergeInfo> {
  // We compare against the raw GitHub payload at
  // `data.payload.pull_request.html_url`, which is the canonical URL
  // GitHub puts in webhook events. Some teams paste the `/files`
  // variant into the task — strip trailing extras so the comparison is
  // robust without doing a full URL canonicalisation pass.
  const normalized = normalizePrUrl(prUrl);
  type PrRow = { merge_sha: string | null; head_sha: string | null };
  // We can't use Prisma's typed query here because `payload` is a free
  // Json column; a raw query keeps the Postgres-side JSON walk while
  // staying parameterised against SQL injection.
  const prRows = await client.$queryRaw<PrRow[]>`
    SELECT
      payload -> 'data' -> 'payload' -> 'pull_request' ->> 'merge_commit_sha' AS merge_sha,
      payload -> 'data' -> 'payload' -> 'pull_request' -> 'head' ->> 'sha'    AS head_sha
    FROM domain_events
    WHERE event_type = 'github_pull_request'
      AND project_id = ${projectId}
      AND payload -> 'data' -> 'payload' ->> 'action' = 'closed'
      AND (payload -> 'data' -> 'payload' -> 'pull_request' ->> 'merged')::boolean = true
      AND payload -> 'data' -> 'payload' -> 'pull_request' ->> 'html_url' = ${normalized}
    LIMIT 1
  `;
  if (prRows.length === 0) {
    return { merged: false, shas: [] };
  }

  const shas = new Set<string>();
  const mergeSha = prRows[0].merge_sha?.trim() || null;
  const headSha = prRows[0].head_sha?.trim() || null;
  if (mergeSha) shas.add(mergeSha);
  if (headSha) shas.add(headSha);

  // Pull every commit from the `github_push` event(s) that carried
  // this merge commit to the base branch. The push payload's
  // `head_commit.id` is the SHA of the latest commit in the push, so
  // matching on it gives us the exact push that landed the PR. The
  // `commits[]` array on that push is the list of commits added to
  // the base branch — i.e. the PR's commits (after squash / rebase /
  // merge, depending on the merge strategy).
  if (mergeSha) {
    type PushRow = { commits: unknown };
    const pushRows = await client.$queryRaw<PushRow[]>`
      SELECT payload -> 'data' -> 'payload' -> 'commits' AS commits
      FROM domain_events
      WHERE event_type = 'github_push'
        AND project_id = ${projectId}
        AND payload -> 'data' -> 'payload' -> 'head_commit' ->> 'id' = ${mergeSha}
    `;
    for (const row of pushRows) {
      if (Array.isArray(row.commits)) {
        for (const c of row.commits) {
          if (c && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string') {
            const id = (c as { id: string }).id.trim();
            if (id) shas.add(id);
          }
        }
      }
    }
  }

  return { merged: true, shas: Array.from(shas) };
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
 * commit_deliverable_links row for this project AND for one of the
 * SHAs that belong to the task's merged PR (`allowedShas`). We resolve
 * refs by slug → PlanDeliverable.id first (the link table is keyed by
 * id, not slug), then count rows per deliverable in a single grouped
 * query so the gate is O(1) DB round-trip regardless of how many refs
 * the task declares.
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
 * Closes #1189 — pre-fix the lookup also accepted commits from any
 * unrelated PR (or any historical commit that ever touched the
 * deliverable's `file_glob`) as evidence. We now restrict to SHAs
 * that originate from the task's merged PR (`allowedShas`); when that
 * list is empty (no merged PR observed) every resolved ref is
 * reported as missing — fail closed for an opt-in correctness gate.
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
  allowedShas: string[],
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

  // No SHAs to bind to → no commit can possibly satisfy the gate.
  // Skip the link-count query entirely: every resolved ref is
  // missing.
  if (allowedShas.length === 0) {
    return [...unresolved, ...deliverables.map((d) => d.slug)];
  }

  // Count links per resolved deliverable in a single query, restricted
  // to SHAs from the task's merged PR. This is the binding that the
  // #1189 finding requires: a deliverable is only "covered" if a
  // commit on *this PR* touched it.
  const linkCounts = await client.commitDeliverableLink.groupBy({
    by: ['deliverableId'],
    where: {
      projectId,
      deliverableId: { in: deliverables.map((d) => d.id) },
      sha: { in: allowedShas },
    },
    _count: { _all: true },
  });
  const withEvidence = new Set(linkCounts.map((row) => row.deliverableId));

  const missingResolved = deliverables.filter((d) => !withEvidence.has(d.id)).map((d) => d.slug);

  return [...unresolved, ...missingResolved];
}
