-- R-083: Add a composite foreign key from tasks(project_id, bound_plan_version)
-- to plans(project_id, version) so that Postgres enforces "every task is bound
-- to a real plan version". Until this remediation the column was a plain
-- integer with no referential integrity, so a typo or buggy code path could
-- leave a task pointing at a plan version that never existed (or was deleted).
--
-- The plans.(project_id, version) tuple already has a unique index
-- (`plans_project_id_version_key`, created in the initial migration), so it is
-- a valid FK target.
--
-- Defensive cleanup first: drop any task rows whose (project_id,
-- bound_plan_version) does not match a real plan. Without this the
-- ALTER TABLE ... ADD CONSTRAINT below would fail on databases that
-- accumulated orphan tasks while no FK was in place. In healthy data this
-- DELETE is a no-op.
DELETE FROM "tasks" t
  WHERE NOT EXISTS (
    SELECT 1 FROM "plans" p
     WHERE p."project_id" = t."project_id"
       AND p."version" = t."bound_plan_version"
  );

-- Index that backs the new FK. Postgres does not auto-index the referencing
-- side of a foreign key, and we want delete-on-cascade lookups (when a plan
-- is removed via the project cascade chain) to stay on a B-tree path rather
-- than fall back to a sequential scan of `tasks`.
CREATE INDEX IF NOT EXISTS "tasks_project_id_bound_plan_version_idx"
  ON "tasks" ("project_id", "bound_plan_version");

-- The composite FK. ON DELETE CASCADE matches the project-level cascade chain:
-- when a project is deleted, both `plans` and `tasks` are cascade-deleted via
-- their respective FKs to `projects`. Postgres evaluates the two cascades
-- within the same statement and the order between them is undefined, so we
-- make the plan-side cascade explicit here. If the plan side fires first, the
-- tasks for that (project_id, version) tuple are removed via this cascade
-- instead of being left dangling momentarily and tripping the FK check.
--
-- ON UPDATE CASCADE is mostly a defensive default — in practice
-- plans.version is never updated in production (versions are only assigned at
-- insert time), but keeping the cascade behaviour aligned with the other
-- composite FK style in this schema avoids surprises.
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_project_id_bound_plan_version_fkey"
  FOREIGN KEY ("project_id", "bound_plan_version")
  REFERENCES "plans" ("project_id", "version")
  ON DELETE CASCADE ON UPDATE CASCADE;
