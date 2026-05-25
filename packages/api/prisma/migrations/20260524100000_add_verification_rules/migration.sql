-- R-181: declarative verification rules table + index.
--
-- Replaces the implicit, hard-coded "AI score ≥ 75" gate (demoted to
-- advisory in R-180) with an owner-configurable, deterministic gate. The
-- complete route evaluates every enabled rule for the run's project and
-- returns 422 with `{ gate: 'rule', failedRules: [...] }` when any of
-- them fail. Owners CRUD the rows via the new
-- `/api/projects/[projectId]/verification-rules` endpoints.
--
-- `kind` is intentionally a TEXT (not a Postgres enum) so adding a new
-- rule kind is a one-file evaluator change — no schema migration required.
-- `params` is a JSONB bag so per-kind config (e.g. `{ "min": 40 }`) does
-- not need a wide-table schema.

CREATE TABLE "verification_rules" (
    "id"          TEXT         NOT NULL,
    "project_id"  TEXT         NOT NULL,
    "scope"       TEXT         NOT NULL DEFAULT 'project',
    "scope_value" TEXT,
    "kind"        TEXT         NOT NULL,
    "params"      JSONB        NOT NULL DEFAULT '{}'::jsonb,
    "enabled"     BOOLEAN      NOT NULL DEFAULT true,
    "created_by"  TEXT         NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_rules_pkey" PRIMARY KEY ("id")
);

-- Hot read path on every `complete`: load all enabled rules for one project.
-- Owners typically configure < 20 rules per project so we do not bother
-- pushing scope/scopeValue filtering into SQL — the evaluator filters in
-- memory after this lookup.
CREATE INDEX "verification_rules_project_id_enabled_idx"
    ON "verification_rules" ("project_id", "enabled");

ALTER TABLE "verification_rules"
    ADD CONSTRAINT "verification_rules_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Defensive CHECK: scope must be one of the known buckets. Keeping it as a
-- CHECK (instead of a Postgres enum) means adding a new scope is a single-
-- statement migration without an ALTER TYPE that locks every reader.
ALTER TABLE "verification_rules"
    ADD CONSTRAINT "verification_rules_scope_check"
    CHECK ("scope" IN ('project', 'task_type', 'task'));
