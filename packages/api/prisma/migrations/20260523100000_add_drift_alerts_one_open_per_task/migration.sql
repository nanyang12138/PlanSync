-- R-051: Enforce at most one DriftAlert with status='open' per task.
-- Repeated plan activations used to accumulate duplicate open alerts on the
-- same task (one per activation), inflating the drift queue and breaking
-- per-task counters in the UI/CLI.
--
-- Before creating new alerts, `persistDriftAlerts` now supersedes any
-- existing open alerts on the affected tasks (status='resolved',
-- resolvedAction='superseded', resolvedBy='system'). This partial unique
-- index is the database-level guarantee that the invariant holds even if a
-- racing transaction tried to bypass the application logic.
--
-- Prisma does not natively support partial unique indexes (as of the
-- version used here), so this is created via raw SQL. The corresponding
-- schema.prisma model carries a comment pointing here.
--
-- Idempotency: prior to creating the index we proactively supersede every
-- duplicate-open alert (keeping the most recent one per task). Without this
-- the index creation would fail on environments where pre-R-051 data
-- already has duplicate open rows for the same task.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "task_id"
      ORDER BY "created_at" DESC, "id" DESC
    ) AS rn
  FROM "drift_alerts"
  WHERE "status" = 'open'
)
UPDATE "drift_alerts" a
SET
  "status" = 'resolved',
  "resolved_action" = 'superseded',
  "resolved_by" = 'system',
  "resolved_at" = NOW()
FROM ranked r
WHERE a."id" = r."id"
  AND r.rn > 1;

CREATE UNIQUE INDEX "drift_alerts_one_open_per_task"
  ON "drift_alerts" ("task_id")
  WHERE "status" = 'open';
