/**
 * R-191: commit ↔ deliverable linker.
 *
 * Given a GitHub `push` payload (as emitted into the outbox by
 * `packages/api/src/app/api/integrations/github/webhook/route.ts`),
 * inspect every commit in the push and write a `commit_deliverable_links`
 * row for each (commit, deliverable) pair where either:
 *
 *   1. A file changed in the commit matches a `PlanDeliverable.refUri`
 *      glob (only when `refType = 'file_glob'`). Recorded with
 *      `matched_by = 'glob'`, `matched_ref` = the actual file path.
 *
 *   2. The commit message contains `[deliverable:<slug>]` and the slug
 *      resolves to one or more active deliverables for the same project.
 *      Recorded with `matched_by = 'message'`, `matched_ref` = the slug.
 *      Message links take priority in downstream consumers — when both
 *      reasons fire for the same (sha, deliverable) the message row is
 *      treated as the dominant signal — but both rows are persisted so
 *      the audit trail keeps every signal.
 *
 *      A bare slug is intentionally project-scoped, not plan-version-scoped:
 *      authors writing commit messages have no reasonable way to know which
 *      `PlanDeliverable.id` row a slug points at on each plan version, and
 *      the downstream R-192 evidence gate scopes its lookup by the task's
 *      `boundPlanVersion`. When the same slug exists on multiple plan
 *      versions (e.g. an `auth` deliverable carried v1→v2→v3) we therefore
 *      write one message row PER same-slug deliverable so that tasks on any
 *      of those versions can pick the evidence up. The unique key
 *      `(sha, deliverable_id, matched_by)` permits this — the dedupe is
 *      per `deliverable_id`, not per slug.
 *
 * The function is idempotent: re-delivery of the same GitHub event hits
 * the `(sha, deliverable_id, matched_by)` unique constraint and the
 * conflicting row is skipped via `skipDuplicates`.
 *
 * Consumers:
 *   - The worker (R-162) will dispatch `github_push` outbox rows to this
 *     function once the outbox→fan-out pipeline lands. Until then it is
 *     callable directly from the webhook route (or in tests) by handing
 *     it the parsed payload.
 *   - R-192 reads `commit_deliverable_links` to derive task completion
 *     state ("commit linked ∧ PR merged ∧ no drift → done").
 *
 * What this function does NOT do:
 *   - It does not look at PR file lists; only `push` payload commits.
 *     PRs are recorded by R-190 as their own outbox events (`github_pull_request`)
 *     and a separate (future) helper will link them via merge commit SHAs.
 *   - It does not consider commit author or branch. The link is a
 *     pure-content statement ("this sha touches these deliverables");
 *     R-192 layers branch/PR/state semantics on top.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../prisma';
import { logger } from '../logger';

/** Subset of a GitHub `push` payload commit object we rely on. */
export interface GithubPushCommit {
  id?: string;
  message?: string;
  added?: string[];
  removed?: string[];
  modified?: string[];
}

/** Subset of a GitHub `push` payload we rely on. */
export interface GithubPushPayload {
  ref?: string;
  commits?: GithubPushCommit[];
  head_commit?: GithubPushCommit | null;
}

export interface LinkCommitsInput {
  /** PlanSync project id (from the outbox row, NOT from the payload). */
  projectId: string;
  /** Parsed GitHub push payload. */
  payload: GithubPushPayload;
  /**
   * Optional Prisma client / transaction client for tests. Defaults to
   * the shared singleton so production callers don't have to thread it
   * through.
   */
  prismaClient?: Prisma.TransactionClient | PrismaClient;
}

export interface LinkCommitsResult {
  /** Number of (sha, deliverable, matchedBy) rows newly written. */
  created: number;
  /** Number of commits examined (head_commit + commits[]). */
  commitsExamined: number;
  /** Per-commit breakdown, useful for tests and logs. */
  byCommit: Array<{
    sha: string;
    globMatches: number;
    messageMatches: number;
  }>;
}

const DELIVERABLE_TAG_REGEX = /\[deliverable:([A-Za-z0-9_\-./]+)\]/g;

/**
 * Translate a glob like `src/**\u002F*.ts` or `docs/api/*.md` into an
 * anchored RegExp matching a single file path. Supports `*`, `**`, `?`
 * and treats every other regex meta-char as literal. Intentionally
 * minimal — full minimatch semantics (brace expansion, character
 * classes, `!` negation) are not needed for the deliverable.refUri
 * surface we control and would add a dependency for no current win.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      const isDouble = glob[i + 1] === '*';
      if (isDouble) {
        // `**/foo` matches `foo` and `a/b/foo`; `foo/**` matches `foo`
        // and `foo/bar`. `**` on its own matches anything (incl. `/`).
        const next = glob[i + 2];
        if (next === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^$|()[]{}\\'.indexOf(c) !== -1) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  re += '$';
  return new RegExp(re);
}

interface LoadedDeliverable {
  id: string;
  slug: string;
  refUri: string | null;
  globRe: RegExp | null;
}

/**
 * Load every deliverable visible to the project across plan versions
 * that have been ratified at some point — i.e. parent plan status ∈
 * ('active', 'superseded'). We deliberately do not restrict to just the
 * currently-active plan: a commit landing today may close out a
 * deliverable defined in plan v2 even if plan v3 is now active and
 * renamed/dropped it — the link is a statement about the commit, not
 * about the current plan version, and `PlanDeliverable.supersededById`
 * is the right place to walk the version chain at read time.
 *
 * Plans in `draft` or `proposed` status are excluded on purpose: they
 * represent unratified intent (a future plan version under review or
 * still being authored) and any deliverable rows attached to them must
 * not collect commit evidence. Without this filter, a `[deliverable:foo]`
 * tag in a commit message would fan out to every plan version that
 * happens to share the slug `foo`, including a draft plan v3 whose
 * deliverable card has not been agreed on yet — producing misleading
 * evidence the moment plan v3 is activated. See review finding for #1286.
 *
 * Deliverable rows with `status='deprecated'` are kept ONLY when they sit
 * inside a supersession chain — i.e. `supersededById IS NOT NULL`. When
 * `supersedeDeliverables` flips an old same-slug row to deprecated and
 * points its `supersededById` at the successor, R-192 still scopes its
 * evidence query by the task's `boundPlanVersion`. Tasks pinned to the
 * old version need the deprecated row's id to appear in
 * `commit_deliverable_links` to satisfy their gate — see #1326.
 *
 * Deprecated rows with `supersededById IS NULL` are excluded: these are
 * manually deprecated / descoped deliverables (e.g. retired mid-iteration
 * via the R-155 supersede route with no successor body). They have no
 * downstream task that can legitimately need new evidence, and including
 * them would let a `[deliverable:<slug>]` commit tag or a stale glob
 * write evidence against a retired row — letting tasks bound to that
 * `boundPlanVersion` erroneously satisfy R-192 even though the project
 * decided that scope is no longer being delivered. See review finding
 * for PR #1370 / #1417.
 */
async function loadProjectDeliverables(
  client: Prisma.TransactionClient | PrismaClient,
  projectId: string,
): Promise<LoadedDeliverable[]> {
  const rows = await client.planDeliverable.findMany({
    where: {
      plan: {
        projectId,
        status: { in: ['active', 'superseded'] },
      },
      // Keep all non-deprecated rows; for deprecated rows, require a
      // successor link so we only include in-chain ancestors and never
      // orphaned (manually-descoped) retirees.
      OR: [{ status: { not: 'deprecated' } }, { supersededById: { not: null } }],
    },
    select: { id: true, slug: true, refUri: true, refType: true },
  });
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    refUri: r.refUri,
    globRe: r.refType === 'file_glob' && r.refUri ? globToRegExp(r.refUri) : null,
  }));
}

function uniq(strs: Iterable<string>): string[] {
  return Array.from(new Set(strs));
}

function commitFiles(commit: GithubPushCommit): string[] {
  return uniq([...(commit.added ?? []), ...(commit.modified ?? []), ...(commit.removed ?? [])]);
}

function extractMessageSlugs(message: string | undefined | null): string[] {
  if (!message) return [];
  const out = new Set<string>();
  // `String.matchAll` requires the `g` flag; the regex above carries it.
  for (const m of message.matchAll(DELIVERABLE_TAG_REGEX)) {
    if (m[1]) out.add(m[1]);
  }
  return Array.from(out);
}

interface PendingRow {
  projectId: string;
  sha: string;
  deliverableId: string;
  matchedBy: 'glob' | 'message';
  matchedRef: string | null;
}

/**
 * Main entry point.
 *
 * Returns { created } so callers (worker, tests) can log a per-event
 * summary. The result also includes a per-commit breakdown so tests can
 * assert that a commit hit both a glob and a message rule without having
 * to re-query the DB.
 */
export async function linkCommitsFromPushPayload(
  input: LinkCommitsInput,
): Promise<LinkCommitsResult> {
  const client = input.prismaClient ?? defaultPrisma;
  const commits: GithubPushCommit[] = [];
  // `head_commit` is GitHub's pre-extracted top-of-push commit; `commits`
  // is the full list. They overlap, so we dedupe by sha below.
  if (input.payload.head_commit?.id) commits.push(input.payload.head_commit);
  if (Array.isArray(input.payload.commits)) commits.push(...input.payload.commits);

  const seenSha = new Set<string>();
  const dedupedCommits = commits.filter((c) => {
    if (!c.id) return false;
    if (seenSha.has(c.id)) return false;
    seenSha.add(c.id);
    return true;
  });

  if (dedupedCommits.length === 0) {
    return { created: 0, commitsExamined: 0, byCommit: [] };
  }

  const deliverables = await loadProjectDeliverables(client, input.projectId);
  // O(deliverables) lookup keyed by slug for the message-tag path.
  // Multi-valued: when the same slug exists on multiple plan versions
  // (e.g. an `auth` deliverable carried v1→v2→v3) we must fan the
  // message tag out to every same-slug deliverable. Otherwise tasks
  // bound to whichever version we did NOT pick would never see
  // `deliverable_evidence` (R-192 scopes its lookup by
  // `boundPlanVersion`, so only the deliverable_id on the task's bound
  // version satisfies that task's gate).
  const bySlug = new Map<string, LoadedDeliverable[]>();
  for (const d of deliverables) {
    const list = bySlug.get(d.slug);
    if (list) list.push(d);
    else bySlug.set(d.slug, [d]);
  }

  const pending: PendingRow[] = [];
  const byCommit: LinkCommitsResult['byCommit'] = [];

  for (const commit of dedupedCommits) {
    const sha = commit.id!;
    let globHits = 0;
    let messageHits = 0;

    // 1) Glob match — iterate (deliverables × files). Both lists are
    //    short in practice (single-digit deliverables, double-digit
    //    files per commit) so the nested loop is fine; if either side
    //    grows we can index files by extension first.
    const files = commitFiles(commit);
    for (const d of deliverables) {
      if (!d.globRe) continue;
      for (const file of files) {
        if (d.globRe.test(file)) {
          pending.push({
            projectId: input.projectId,
            sha,
            deliverableId: d.id,
            matchedBy: 'glob',
            matchedRef: file,
          });
          globHits += 1;
          // Don't break — different files might hit the same
          // deliverable; the unique constraint dedupes (sha, deliv,
          // 'glob') so only the first file's row survives. We still
          // record the count for the breakdown.
        }
      }
    }

    // 2) Message tag match — `[deliverable:<slug>]` wins over glob in
    //    downstream consumers, but we emit both rows so the audit trail
    //    keeps every signal. When the same slug resolves to multiple
    //    deliverables (cross-plan-version), emit a row for each so a
    //    task on any of those versions can find its evidence.
    for (const slug of extractMessageSlugs(commit.message)) {
      const matches = bySlug.get(slug);
      if (!matches || matches.length === 0) continue;
      for (const d of matches) {
        pending.push({
          projectId: input.projectId,
          sha,
          deliverableId: d.id,
          matchedBy: 'message',
          matchedRef: slug,
        });
        messageHits += 1;
      }
    }

    byCommit.push({ sha, globMatches: globHits, messageMatches: messageHits });
  }

  if (pending.length === 0) {
    return { created: 0, commitsExamined: dedupedCommits.length, byCommit };
  }

  // Deduplicate within this batch first so `createMany` doesn't reject
  // before it gets a chance to honour `skipDuplicates` (Postgres treats
  // intra-statement duplicates the same as cross-statement collisions).
  const seen = new Set<string>();
  const distinct = pending.filter((row) => {
    const key = `${row.sha}\u0000${row.deliverableId}\u0000${row.matchedBy}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const result = await client.commitDeliverableLink.createMany({
    data: distinct,
    skipDuplicates: true,
  });

  if (result.count > 0) {
    logger.info(
      {
        projectId: input.projectId,
        commits: dedupedCommits.length,
        linksCreated: result.count,
      },
      'R-191: linked commits to deliverables',
    );
  }

  return {
    created: result.count,
    commitsExamined: dedupedCommits.length,
    byCommit,
  };
}
