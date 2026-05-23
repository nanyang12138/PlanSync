-- R-150: Land the structured Deliverable / Constraint / Standard tables that
-- supplement (not replace) the legacy `String[]` columns on `plans`.
--
-- Three sibling tables — `plan_deliverables`, `plan_constraints`,
-- `plan_standards` — share the same `(plan_id, slug)` uniqueness invariant
-- so a human-readable slug such as `auth/oidc-callback` can be cross-
-- referenced by Tasks, drift diffs, and verification rules without leaking
-- internal IDs into UI/CLI.
--
-- IMPORTANT: this migration is intentionally **additive only**. It does not
-- backfill rows from the existing `plans.deliverables` / `plans.constraints`
-- / `plans.standards` arrays, and it does not touch the arrays themselves.
-- That work lives in R-151 so that the schema can ship and be exercised by
-- contract tests well before the dual-write/backfill rollout begins.
--
-- Both ENUM-valued columns (`ref_type` and `status` on plan_deliverables)
-- are stored as TEXT plus a CHECK constraint so a new ref-kind can be added
-- with a one-line migration instead of a multi-step Postgres ENUM ALTER.

CREATE TABLE "plan_deliverables" (
  "id"               TEXT        NOT NULL,
  "plan_id"          TEXT        NOT NULL,
  "slug"             TEXT        NOT NULL,
  "title"            TEXT        NOT NULL,
  "body"             TEXT        NOT NULL,
  "ref_type"         TEXT,
  "ref_uri"          TEXT,
  "status"           TEXT        NOT NULL DEFAULT 'active',
  "superseded_by_id" TEXT,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "plan_deliverables_pkey" PRIMARY KEY ("id"),

  -- Enum-equivalent CHECK constraints. Kept as TEXT + CHECK rather than
  -- Postgres ENUMs because ALTERing an ENUM in Postgres is awkward (no
  -- in-place removal of values, separate ALTER TYPE statement, etc.) and we
  -- expect both lists to evolve as drift v3 and the verification-rules work
  -- discover new kinds.
  CONSTRAINT "plan_deliverables_ref_type_check" CHECK (
    "ref_type" IS NULL OR "ref_type" IN ('file_glob', 'api_spec', 'figma_frame', 'notion_page', 'free')
  ),
  CONSTRAINT "plan_deliverables_status_check" CHECK (
    "status" IN ('draft', 'active', 'done', 'deprecated')
  )
);

-- (plan_id, slug) is the stable, human-addressable identity for a deliverable
-- inside a plan version. Tasks reference deliverables by slug today, and the
-- drift engine v3 design (R-154) leans on the same slug for diff alignment.
CREATE UNIQUE INDEX "plan_deliverables_plan_id_slug_key"
  ON "plan_deliverables" ("plan_id", "slug");

-- (plan_id, status) is the hottest read path for the deliverable list view
-- (filter by active/done on a single plan version), so back it with a
-- composite B-tree index from day one.
CREATE INDEX "plan_deliverables_plan_id_status_idx"
  ON "plan_deliverables" ("plan_id", "status");

-- FKs:
--   - `plan_id` cascades when the surrounding plan row is removed (plans
--     themselves cascade from the project FK chain). Without this a deleted
--     plan would leave dangling deliverables.
--   - `superseded_by_id` is a self-reference used at activation time to link
--     a new-version row to the previous-version row it replaces. Use
--     SET NULL so removing the older plan does not propagate into the newer
--     one — the activation chain stays browsable but the pointer to the
--     removed predecessor is nulled out instead of cascading.
ALTER TABLE "plan_deliverables"
  ADD CONSTRAINT "plan_deliverables_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plans" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "plan_deliverables"
  ADD CONSTRAINT "plan_deliverables_superseded_by_id_fkey"
  FOREIGN KEY ("superseded_by_id") REFERENCES "plan_deliverables" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;


CREATE TABLE "plan_constraints" (
  "id"         TEXT        NOT NULL,
  "plan_id"    TEXT        NOT NULL,
  "slug"       TEXT        NOT NULL,
  "body"       TEXT        NOT NULL,
  "kind"       TEXT        NOT NULL DEFAULT 'free',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "plan_constraints_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plan_constraints_plan_id_slug_key"
  ON "plan_constraints" ("plan_id", "slug");

CREATE INDEX "plan_constraints_plan_id_kind_idx"
  ON "plan_constraints" ("plan_id", "kind");

ALTER TABLE "plan_constraints"
  ADD CONSTRAINT "plan_constraints_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plans" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TABLE "plan_standards" (
  "id"         TEXT        NOT NULL,
  "plan_id"    TEXT        NOT NULL,
  "slug"       TEXT        NOT NULL,
  "body"       TEXT        NOT NULL,
  "kind"       TEXT        NOT NULL DEFAULT 'free',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "plan_standards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plan_standards_plan_id_slug_key"
  ON "plan_standards" ("plan_id", "slug");

CREATE INDEX "plan_standards_plan_id_kind_idx"
  ON "plan_standards" ("plan_id", "kind");

ALTER TABLE "plan_standards"
  ADD CONSTRAINT "plan_standards_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plans" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
