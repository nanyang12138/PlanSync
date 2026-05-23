-- R-151: Backfill the split per-item tables from the legacy String[] columns
-- on `plans`. This migration is one-shot; new writes after deploy go through
-- packages/api/src/lib/plan-items.ts writeBoth() which keeps the two
-- representations in lockstep.
--
-- Rules:
--   1. For each row in `plans`, walk each of the three legacy arrays
--      (deliverables, constraints, standards) in order and INSERT the
--      corresponding plan_deliverables / plan_constraints / plan_standards
--      row. The 4th legacy array, open_questions, is NOT included — R-150
--      deliberately did not add a split table for it (open questions are
--      ephemeral; they get answered into deliverables/constraints rather
--      than living forever as their own structured records).
--
--   2. slug shape: `<field-prefix>-<idx>` where idx is the zero-based
--      ordinal of the item in the source array. Concrete choices:
--        deliverables → 'deliverable-N'
--        constraints  → 'constraint-N'
--        standards    → 'standard-N'
--      Pros: trivially unique-within-plan (so no collision math), trivially
--            deterministic (idempotent re-run produces same slugs), and
--            grep-able as 'this row came from R-151 backfill'.
--      Cons: not human-meaningful. That's fine because R-152's writeBoth
--            will run a proper slugify on new writes; backfilled rows can
--            be re-slugged in a future migration if anyone cares.
--
--   3. Per-table extra columns get sensible defaults:
--        plan_deliverables: title = body = item text, status = 'active',
--                           ref_type = 'free', ref_uri = NULL,
--                           superseded_by_id = NULL.
--        plan_constraints / plan_standards: kind = 'free', body = item text.
--
--   4. Idempotency: the INSERT uses ON CONFLICT DO NOTHING against the
--      (plan_id, slug) unique index so re-running the migration (e.g. on
--      a database that was partially backfilled by hand) is safe — no
--      duplicate rows, no errors.
--
--   5. id generation: use a stable-but-unique pattern combining the plan id
--      and the slug. Format: 'r151_' || substr(md5(plan_id || '|' || slug), 1, 20)
--      — 20 hex chars of MD5 namespaced under the 'r151_' prefix. Why not
--      cuid()/uuid_generate_v4(): both require an extension or extra setup
--      (cuid is a TS-side concept; pgcrypto is fine but adds a dep). The
--      MD5 namespace is collision-safe at the scales we'll ever see
--      (max ~50k plans × ~50 items × 3 fields = 7.5M rows, MD5 space is
--      16^20 = 1.4e24 — no realistic collision risk) and re-running
--      produces the same ids, which the ON CONFLICT path then no-ops on.
--
-- Rollback story: this migration is data-only (no schema change). Reverting
-- it means TRUNCATE on the three split tables. Production rollback would
-- pair with disabling writeBoth() so subsequent writes don't re-populate.

-- ---- plan_deliverables ----
INSERT INTO "plan_deliverables"
  ("id", "plan_id", "slug", "title", "body", "ref_type", "status", "created_at")
SELECT
  'r151_' || substr(md5(p.id || '|deliverable-' || (idx - 1)::text), 1, 20),
  p.id,
  'deliverable-' || (idx - 1)::text,
  item,
  item,
  'free',
  'active',
  CURRENT_TIMESTAMP
FROM "plans" p
CROSS JOIN LATERAL unnest(p.deliverables) WITH ORDINALITY AS arr(item, idx)
WHERE p.deliverables IS NOT NULL
  AND array_length(p.deliverables, 1) > 0
ON CONFLICT ("plan_id", "slug") DO NOTHING;

-- ---- plan_constraints ----
INSERT INTO "plan_constraints"
  ("id", "plan_id", "slug", "body", "kind", "created_at")
SELECT
  'r151_' || substr(md5(p.id || '|constraint-' || (idx - 1)::text), 1, 20),
  p.id,
  'constraint-' || (idx - 1)::text,
  item,
  'free',
  CURRENT_TIMESTAMP
FROM "plans" p
CROSS JOIN LATERAL unnest(p.constraints) WITH ORDINALITY AS arr(item, idx)
WHERE p.constraints IS NOT NULL
  AND array_length(p.constraints, 1) > 0
ON CONFLICT ("plan_id", "slug") DO NOTHING;

-- ---- plan_standards ----
INSERT INTO "plan_standards"
  ("id", "plan_id", "slug", "body", "kind", "created_at")
SELECT
  'r151_' || substr(md5(p.id || '|standard-' || (idx - 1)::text), 1, 20),
  p.id,
  'standard-' || (idx - 1)::text,
  item,
  'free',
  CURRENT_TIMESTAMP
FROM "plans" p
CROSS JOIN LATERAL unnest(p.standards) WITH ORDINALITY AS arr(item, idx)
WHERE p.standards IS NOT NULL
  AND array_length(p.standards, 1) > 0
ON CONFLICT ("plan_id", "slug") DO NOTHING;
