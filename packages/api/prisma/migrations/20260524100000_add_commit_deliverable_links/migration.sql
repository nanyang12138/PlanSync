-- R-191: commit ↔ deliverable links derived from GitHub `push` events.
--
-- Populated by `linkCommitsFromPushPayload` (packages/api/src/lib/git/link-commits.ts)
-- whenever a `github_push` outbox row is processed (worker R-162 in the
-- final pipeline; the function is also unit-testable in isolation).
--
-- Each row records one match reason between a single commit `sha` and one
-- `plan_deliverables.id`. The two supported reasons are:
--   * 'glob'    — a file changed in the push matched the deliverable's
--                 `ref_uri` glob (only applies when `ref_type = 'file_glob'`).
--   * 'message' — the commit message contained `[deliverable:<slug>]` and
--                 that slug resolved to this deliverable.
-- The CHECK constraint pins the enum so a typo at the application layer
-- becomes a 500 instead of silently writing nonsense; downstream queries
-- (R-192 task auto-state, R-193 PR template) can scan the index by
-- `matched_by` without worrying about freeform values.
--
-- The unique key (sha, deliverable_id, matched_by) makes re-delivery of the
-- same GitHub event a no-op: the second insert hits the unique constraint
-- and we treat it as "already linked". Keeping `matched_by` in the key
-- (rather than ignoring it) means the same commit can carry both a glob row
-- and a message row for the same deliverable — that is intentional, so the
-- audit trail records both signals when both apply.
--
-- `project_id` is denormalised onto the row (rather than joined through
-- plan_deliverables → plans → projects) so the worker can scope its fan-out
-- and the (project_id, sha) index can answer "what touched this commit?"
-- in one B-tree hop without three joins.

CREATE TABLE "commit_deliverable_links" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "deliverable_id" TEXT NOT NULL,
    "matched_by" TEXT NOT NULL,
    "matched_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commit_deliverable_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "commit_deliverable_links_sha_deliverable_id_matched_by_key"
  ON "commit_deliverable_links"("sha", "deliverable_id", "matched_by");

CREATE INDEX "commit_deliverable_links_project_id_sha_idx"
  ON "commit_deliverable_links"("project_id", "sha");

CREATE INDEX "commit_deliverable_links_deliverable_id_idx"
  ON "commit_deliverable_links"("deliverable_id");

ALTER TABLE "commit_deliverable_links"
  ADD CONSTRAINT "commit_deliverable_links_matched_by_check"
  CHECK ("matched_by" IN ('glob', 'message'));

ALTER TABLE "commit_deliverable_links"
  ADD CONSTRAINT "commit_deliverable_links_deliverable_id_fkey"
  FOREIGN KEY ("deliverable_id") REFERENCES "plan_deliverables"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
