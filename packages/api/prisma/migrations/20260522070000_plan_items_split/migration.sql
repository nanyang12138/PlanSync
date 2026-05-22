-- R-150: Deliverable / Constraint / Standard 分表 schema.
--
-- Today `plans.constraints`, `plans.standards`, `plans.deliverables` are
-- plain `text[]` columns. They cannot express:
--   * per-item lifecycle (draft / active / done / deprecated)
--   * supersession history (which deliverable replaced which)
--   * typed external references (file glob, API spec, design frame, …)
--   * stable, human-readable IDs that drift v2 can point at by slug
--
-- This migration introduces three structurally-identical tables that do.
-- The old `text[]` columns are intentionally **not removed** — `plan_show`
-- and every existing read path keep returning the legacy shape, and the
-- new tables stay empty until R-151 backfills them. That makes this
-- migration purely additive and safe to deploy independently of any code
-- change.
--
-- The trio mirrors what other models in this schema already do: cuid PK,
-- snake_case columns, cascade-on-plan-delete, composite (plan_id, slug)
-- uniqueness, and a per-plan index for the most common filter column.

CREATE TABLE "plan_deliverables" (
    "id"                TEXT NOT NULL,
    "plan_id"           TEXT NOT NULL,
    "slug"              TEXT NOT NULL,
    "title"             TEXT NOT NULL,
    "body"              TEXT NOT NULL,
    "ref_type"          TEXT,
    "ref_uri"           TEXT,
    "status"            TEXT NOT NULL DEFAULT 'draft',
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
    FOREIGN KEY ("plan_id") REFERENCES "plans" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Self-referential FK for supersession. Restrict so the chain cannot be
-- silently broken by deleting an intermediate item; the parent plan's
-- cascade still removes the entire subtree in a single statement.
ALTER TABLE "plan_deliverables"
    ADD CONSTRAINT "plan_deliverables_superseded_by_id_fkey"
    FOREIGN KEY ("superseded_by_id") REFERENCES "plan_deliverables" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE TABLE "plan_constraints" (
    "id"         TEXT NOT NULL,
    "plan_id"    TEXT NOT NULL,
    "slug"       TEXT NOT NULL,
    "body"       TEXT NOT NULL,
    "kind"       TEXT NOT NULL,
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
    "id"         TEXT NOT NULL,
    "plan_id"    TEXT NOT NULL,
    "slug"       TEXT NOT NULL,
    "body"       TEXT NOT NULL,
    "kind"       TEXT NOT NULL,
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
