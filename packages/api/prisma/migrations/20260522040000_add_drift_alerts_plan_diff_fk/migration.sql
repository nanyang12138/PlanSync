-- R-081: Add a foreign key from drift_alerts.plan_diff_id to plan_diffs(id).
-- Before this migration the column was an untyped string reference that
-- could outlive (or never match) a real plan_diff row. Adding the FK with
-- ON DELETE SET NULL keeps drift history intact when a PlanDiff is
-- removed, instead of silently leaving dangling pointers.
--
-- First null out any planDiffId values that do not point to an existing
-- PlanDiff so the new constraint can be created without errors on
-- pre-existing rows.

UPDATE "drift_alerts"
   SET "plan_diff_id" = NULL
 WHERE "plan_diff_id" IS NOT NULL
   AND "plan_diff_id" NOT IN (SELECT "id" FROM "plan_diffs");

ALTER TABLE "drift_alerts"
  ADD CONSTRAINT "drift_alerts_plan_diff_id_fkey"
  FOREIGN KEY ("plan_diff_id") REFERENCES "plan_diffs"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
