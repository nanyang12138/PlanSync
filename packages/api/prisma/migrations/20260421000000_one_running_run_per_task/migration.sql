-- Enforce: at most one ExecutionRun with status='running' per task.
-- Defends against race between concurrent plansync_execution_start callers.
CREATE UNIQUE INDEX "execution_runs_one_running_per_task"
  ON "execution_runs" ("task_id")
  WHERE "status" = 'running';
