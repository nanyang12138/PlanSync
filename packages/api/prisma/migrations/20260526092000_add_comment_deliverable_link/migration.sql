-- R-156: Add optional `deliverable_id` FK on `plan_comments` so a plan
-- comment can be anchored to a specific PlanDeliverable row. The Web UI
-- ("Deliverable timeline + per-deliverable evaluations") renders these as
-- a thread next to the deliverable card; when null the comment continues
-- to behave as a plan-level comment in the existing thread.
--
-- Additive migration. No backfill needed: existing comments default to
-- a NULL `deliverable_id` and stay visible on the plan-level thread.
--
-- SetNull on delete keeps comment history intact when an owner removes
-- the underlying deliverable row (matches the rule we use for
-- `plan_suggestions.deliverable_id` from R-155). Index supports the
-- common access pattern "list comments for one deliverable" used by the
-- new `/projects/[id]/plans/deliverables` page.

ALTER TABLE "plan_comments"
  ADD COLUMN "deliverable_id" TEXT;

ALTER TABLE "plan_comments"
  ADD CONSTRAINT "plan_comments_deliverable_id_fkey"
    FOREIGN KEY ("deliverable_id") REFERENCES "plan_deliverables" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "plan_comments_deliverable_id_idx"
  ON "plan_comments" ("deliverable_id");
