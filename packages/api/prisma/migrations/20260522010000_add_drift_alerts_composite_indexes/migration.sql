-- R-076: Add composite indexes on drift_alerts(project_id, status) and
-- drift_alerts(task_id, status) so that the per-project drift list and
-- per-task drift lookups stop falling back to a sequential scan.

CREATE INDEX IF NOT EXISTS "drift_alerts_project_id_status_idx"
  ON "drift_alerts" ("project_id", "status");

CREATE INDEX IF NOT EXISTS "drift_alerts_task_id_status_idx"
  ON "drift_alerts" ("task_id", "status");
