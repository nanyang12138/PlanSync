-- R-153: Task → PlanDeliverable middle table + slug→id backfill.
--
-- Why a separate link table when `tasks.plan_deliverable_refs` already
-- stores the deliverable slugs?
--   1. **Rename survives.** `PlanDeliverable.slug` can be renamed by the
--      owner or moved to a new plan version. The link is anchored on
--      `deliverable_id`, so the slug rename does not silently break the
--      drift attribution. The legacy slug array stays around as a
--      derived/human-readable mirror.
--   2. **Drift severity precision.** R-154 will compute drift severity on
--      "is the linked deliverable still present in the new plan version?".
--      That needs a row-id link, not a free-text slug.
--   3. **FK + cascade.** Hard-deleting a deliverable evicts its stale links
--      without manual cleanup.
--
-- IMPORTANT: this migration is **idempotent and additive**. It does NOT
-- drop the legacy `tasks.plan_deliverable_refs` column. Read paths will
-- start joining through the link table, and write paths will sync both
-- representations so existing callers keep working.

CREATE TABLE "task_deliverable_links" (
  "task_id"        TEXT NOT NULL,
  "deliverable_id" TEXT NOT NULL,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "task_deliverable_links_pkey" PRIMARY KEY ("task_id", "deliverable_id"),

  CONSTRAINT "task_deliverable_links_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "task_deliverable_links_deliverable_id_fkey"
    FOREIGN KEY ("deliverable_id") REFERENCES "plan_deliverables" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- Reverse lookup: "what tasks reference this deliverable?" — used by
-- `runDriftScan` to score severity per linked task.
CREATE INDEX "task_deliverable_links_deliverable_id_idx"
  ON "task_deliverable_links" ("deliverable_id");

-- Backfill: for every task whose `plan_deliverable_refs` slug array
-- contains a slug that exists on the task's bound plan, insert one link
-- row. Tasks bound to plan versions that pre-date R-150 (no rows in
-- `plan_deliverables`) simply produce zero matches and stay slug-only;
-- the read path treats an empty `deliverableLinks` array the same way
-- the classifier already treats an empty `planDeliverableRefs` (the
-- conservative "depends on all" sentinel).
INSERT INTO "task_deliverable_links" ("task_id", "deliverable_id", "created_at")
SELECT t."id", pd."id", CURRENT_TIMESTAMP
FROM "tasks" t
JOIN "plans" p
  ON p."project_id" = t."project_id"
 AND p."version" = t."bound_plan_version"
JOIN "plan_deliverables" pd
  ON pd."plan_id" = p."id"
 AND pd."slug" = ANY(t."plan_deliverable_refs")
WHERE COALESCE(array_length(t."plan_deliverable_refs", 1), 0) > 0
ON CONFLICT ("task_id", "deliverable_id") DO NOTHING;
