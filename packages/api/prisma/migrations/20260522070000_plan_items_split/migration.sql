-- R-150 (B13): Plan-as-code split tables.
--
-- Today plans store deliverables/constraints/standards as `text[]` columns on
-- `plans`. That representation cannot express stable IDs, status, history, or
-- typed references — drift v2's "ref-by-string" workaround is a patch on top.
-- This migration introduces three sibling tables that mirror the array
-- columns *without removing them*:
--
--   * `plan_deliverables` — typed, addressable deliverables with status and
--     a self-superseded-by link.
--   * `plan_constraints`  — value-typed constraints keyed by stable slug.
--   * `plan_standards`    — value-typed standards keyed by stable slug.
--
-- The legacy String[] columns on `plans` (`deliverables`, `constraints`,
-- `standards`) are intentionally *kept* as the canonical surface for now;
-- read paths (plan_show / plan_pack / Web responses) continue to read from
-- them. Later remediation items are responsible for:
--   * R-151: backfill + dual-write through `writeBoth`.
--   * R-152: switch the plan write path (update / propose / activate /
--             append) to write the typed tables first, then derive the
--             String[] mirror.
--   * R-153: introduce a Task ↔ PlanDeliverable link table.
--   * R-154: switch drift-engine to graph diff over deliverable.id.
--
-- Schema notes:
--   * Every column uses snake_case identifiers consistent with R-085.
--   * `slug` is unique within a plan via (plan_id, slug) so backfills can
--     pick a deterministic slug per array entry without colliding across
--     plan versions.
--   * `ref_type` enumerates how `ref_uri` should be interpreted by callers
--     (file_glob | api_spec | figma_frame | notion_page | free). The
--     enumeration is enforced at the application boundary (Zod schemas in
--     a future R-150 follow-up); we intentionally keep it as TEXT to stay
--     consistent with every other String-with-comment "enum" in the schema
--     (see Plan.status, Task.status, etc.).
--   * `status` on `plan_deliverables` enumerates the deliverable lifecycle
--     (draft | active | done | deprecated) — independent from `plan.status`.
--     Only the deliverable table carries a status; constraints and standards
--     are value-typed and supersede via plan version replacement.
--   * `superseded_by_id` is a self-FK with ON DELETE SET NULL so deleting a
--     replacement deliverable does not cascade-delete history.
--
-- Down migration: drop all three tables. Because these tables are not yet
-- read or written from anywhere in the application code (R-150 is purely
-- additive), `down` is a clean reversal.

CREATE TABLE "plan_deliverables" (
    "id"                TEXT      NOT NULL,
    "plan_id"           TEXT      NOT NULL,
    "slug"              TEXT      NOT NULL,
    "title"             TEXT      NOT NULL,
    "body"              TEXT      NOT NULL,
    "ref_type"          TEXT,
    "ref_uri"           TEXT,
    "status"            TEXT      NOT NULL DEFAULT 'draft',
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

ALTER TABLE "plan_deliverables"
    ADD CONSTRAINT "plan_deliverables_superseded_by_id_fkey"
    FOREIGN KEY ("superseded_by_id") REFERENCES "plan_deliverables" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;


CREATE TABLE "plan_constraints" (
    "id"          TEXT      NOT NULL,
    "plan_id"     TEXT      NOT NULL,
    "slug"        TEXT      NOT NULL,
    "body"        TEXT      NOT NULL,
    "kind"        TEXT      NOT NULL DEFAULT 'free',
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_constraints_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plan_constraints_plan_id_slug_key"
    ON "plan_constraints" ("plan_id", "slug");

ALTER TABLE "plan_constraints"
    ADD CONSTRAINT "plan_constraints_plan_id_fkey"
    FOREIGN KEY ("plan_id") REFERENCES "plans" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TABLE "plan_standards" (
    "id"          TEXT      NOT NULL,
    "plan_id"     TEXT      NOT NULL,
    "slug"        TEXT      NOT NULL,
    "body"        TEXT      NOT NULL,
    "kind"        TEXT      NOT NULL DEFAULT 'free',
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_standards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plan_standards_plan_id_slug_key"
    ON "plan_standards" ("plan_id", "slug");

ALTER TABLE "plan_standards"
    ADD CONSTRAINT "plan_standards_plan_id_fkey"
    FOREIGN KEY ("plan_id") REFERENCES "plans" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
