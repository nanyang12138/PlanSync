-- R-155: optional `deliverable_id` on `plan_suggestions` so a member proposing
-- a plan change can scope it to one PlanDeliverable instead of an entire array
-- field. The column is nullable for full backwards compatibility — existing
-- suggestions (and the legacy free-text `plansync_plan_suggest` path) never
-- carry a deliverable id and continue to apply at the array-field level.
--
-- ON DELETE SET NULL: deleting a deliverable (only possible while the
-- enclosing plan is still `draft` per R-155 owner-only CRUD rules) leaves
-- the suggestion row in place with a NULL deliverableId so the audit trail
-- survives. The suggestion still records `field`/`value`/`reason`; only the
-- pointer to the now-deleted item is cleared.
ALTER TABLE "plan_suggestions"
  ADD COLUMN "deliverable_id" TEXT;

ALTER TABLE "plan_suggestions"
  ADD CONSTRAINT "plan_suggestions_deliverable_id_fkey"
  FOREIGN KEY ("deliverable_id") REFERENCES "plan_deliverables"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "plan_suggestions_deliverable_id_idx"
  ON "plan_suggestions"("deliverable_id");
