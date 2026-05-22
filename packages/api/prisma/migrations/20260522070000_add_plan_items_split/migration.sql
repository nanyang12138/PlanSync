-- R-150: split the legacy `plans.deliverables / .constraints / .standards`
-- String[] columns into three sibling tables. This migration is purely
-- additive: it does NOT drop any existing column. The String[] columns stay
-- as the read source of truth until R-151 backfills the new tables and
-- R-152 switches the read path over. That way every existing API consumer
-- (plan_show, drift-engine text-hash diff, MCP tools, web UI) keeps
-- behaving exactly as before after this migration runs.
--
-- Schema rationale (see also schema.prisma comments on each model):
--   * `slug` is a stable, human-readable identifier scoped to (plan_id),
--     so a task can carry a deliverable reference like `auth/oidc-callback`
--     across plan versions even when the title is rewritten.
--   * Each table has a (plan_id, slug) UNIQUE so callers can upsert by
--     slug without an explicit lookup.
--   * `plan_deliverables` adds a (plan_id, status) index because the
--     hot read in R-152 will be "all active deliverables for this plan".
--   * `plan_constraints` and `plan_standards` index (plan_id, kind) for
--     the equivalent owner-facing filters.
--   * Cascading from `plans.id` matches the rest of the schema: deleting
--     a plan (only drafts can be hard-deleted today) wipes its items.
--   * `superseded_by_id` on `plan_deliverables` is a self-FK with
--     ON DELETE SET NULL so hard-deleting a successor row does not also
--     wipe the history pointer; the regular plan/project cascade still
--     cleans the entire subtree when the plan itself is removed.

CREATE TABLE "plan_deliverables" (
  "id"                TEXT         NOT NULL,
  "plan_id"           TEXT         NOT NULL,
  "slug"              TEXT         NOT NULL,
  "title"             TEXT         NOT NULL,
  "body"              TEXT         NOT NULL,
  "ref_type"          TEXT,
  "ref_uri"           TEXT,
  "status"            TEXT         NOT NULL DEFAULT 'active',
  "superseded_by_id"  TEXT,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "plan_deliverables_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plan_deliverables_plan_id_slug_key"
  ON "plan_deliverables" ("plan_id", "slug");

CREATE INDEX "plan_deliverables_plan_id_status_idx"
  ON "plan_deliverables" ("plan_id", "status");

ALTER TABLE "plan_deliverables"
  ADD CONSTRAINT "plan_deliverables_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "plan_deliverables"
  ADD CONSTRAINT "plan_deliverables_superseded_by_id_fkey"
  FOREIGN KEY ("superseded_by_id") REFERENCES "plan_deliverables"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;


CREATE TABLE "plan_constraints" (
  "id"         TEXT         NOT NULL,
  "plan_id"    TEXT         NOT NULL,
  "slug"       TEXT         NOT NULL,
  "body"       TEXT         NOT NULL,
  "kind"       TEXT         NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "plan_constraints_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plan_constraints_plan_id_slug_key"
  ON "plan_constraints" ("plan_id", "slug");

CREATE INDEX "plan_constraints_plan_id_kind_idx"
  ON "plan_constraints" ("plan_id", "kind");

ALTER TABLE "plan_constraints"
  ADD CONSTRAINT "plan_constraints_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TABLE "plan_standards" (
  "id"         TEXT         NOT NULL,
  "plan_id"    TEXT         NOT NULL,
  "slug"       TEXT         NOT NULL,
  "body"       TEXT         NOT NULL,
  "kind"       TEXT         NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "plan_standards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plan_standards_plan_id_slug_key"
  ON "plan_standards" ("plan_id", "slug");

CREATE INDEX "plan_standards_plan_id_kind_idx"
  ON "plan_standards" ("plan_id", "kind");

ALTER TABLE "plan_standards"
  ADD CONSTRAINT "plan_standards_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
