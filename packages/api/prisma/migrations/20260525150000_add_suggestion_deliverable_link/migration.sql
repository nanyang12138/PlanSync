-- R-155: Add optional `deliverable_id` FK on `plan_suggestions` so a
-- suggestion can target a specific PlanDeliverable row (used when an agent
-- proposes a change against one deliverable, e.g. "rename slug" or "swap
-- refUri"). SetNull on delete: if the deliverable row goes away the
-- suggestion stays as historical context but its pointer is cleared.
--
-- Additive migration. No data backfill needed: existing suggestions have
-- a NULL deliverable_id and continue to behave as plain field-level
-- suggestions ("append to deliverables array", "set goal", …).

ALTER TABLE "plan_suggestions"
  ADD COLUMN "deliverable_id" TEXT;

ALTER TABLE "plan_suggestions"
  ADD CONSTRAINT "plan_suggestions_deliverable_id_fkey"
    FOREIGN KEY ("deliverable_id") REFERENCES "plan_deliverables" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "plan_suggestions_deliverable_id_idx"
  ON "plan_suggestions" ("deliverable_id");
