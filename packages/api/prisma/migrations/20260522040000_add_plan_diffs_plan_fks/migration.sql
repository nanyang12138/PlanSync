-- R-082: Add FK constraints from plan_diffs.fromPlanId / toPlanId to plans(id).
-- Until now these were plain text columns with no referential integrity, so a
-- dangling diff could reference a vanished plan. Cascade matches the existing
-- projectId FK and the Plan -> Project cascade chain: when a plan is deleted
-- (only drafts can be deleted in the application today), any cached diffs
-- referencing it are removed automatically.
--
-- Defensive cleanup first: drop any rows whose fromPlanId or toPlanId no
-- longer points at a real plans.id. Without this the ALTER TABLE ... ADD
-- CONSTRAINT statements below would fail on databases that already
-- accumulated orphan diff rows.

DELETE FROM "plan_diffs"
  WHERE "fromPlanId" NOT IN (SELECT "id" FROM "plans");

DELETE FROM "plan_diffs"
  WHERE "toPlanId" NOT IN (SELECT "id" FROM "plans");

-- Composite indexes that back the new FKs (Postgres does not auto-index the
-- referencing side of an FK, and we want delete-on-cascade lookups to use an
-- index).
CREATE INDEX IF NOT EXISTS "plan_diffs_fromPlanId_idx"
  ON "plan_diffs" ("fromPlanId");

CREATE INDEX IF NOT EXISTS "plan_diffs_toPlanId_idx"
  ON "plan_diffs" ("toPlanId");

ALTER TABLE "plan_diffs"
  ADD CONSTRAINT "plan_diffs_fromPlanId_fkey"
  FOREIGN KEY ("fromPlanId") REFERENCES "plans"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "plan_diffs"
  ADD CONSTRAINT "plan_diffs_toPlanId_fkey"
  FOREIGN KEY ("toPlanId") REFERENCES "plans"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
