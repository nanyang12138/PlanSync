-- Drift v2: per-task references to the plan items the task depends on.
--
-- Today only `plan_deliverable_refs` exists. The structural severity
-- classifier (packages/shared/src/drift/severity.ts) treats a null/empty ref
-- list as "depends on all" — so before these columns are added every task
-- conservatively counts any constraint or standard change as breaking. Once
-- owners narrow per task via the new columns, the classifier sharpens and
-- only changes to the explicitly-referenced items pause that task's run.
--
-- Additive — DEFAULT '{}' (Postgres empty array) preserves the existing
-- "depends on all" semantics for every existing row, so this migration is
-- safe to deploy before or after the API/MCP code that writes the columns.

ALTER TABLE "tasks"
  ADD COLUMN "plan_constraint_refs" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "plan_standard_refs"  TEXT[] NOT NULL DEFAULT '{}';
