-- R-075: Add composite indexes on tasks(project_id, status) and tasks(project_id, assignee)
-- to back the most common task-list queries (status filter, my-work lookup).

CREATE INDEX IF NOT EXISTS "tasks_project_id_status_idx"
  ON "tasks" ("project_id", "status");

CREATE INDEX IF NOT EXISTS "tasks_project_id_assignee_idx"
  ON "tasks" ("project_id", "assignee");
