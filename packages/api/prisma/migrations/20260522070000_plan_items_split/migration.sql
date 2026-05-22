-- R-150: split plan deliverables / constraints / standards out of the
-- existing String[] columns on `plans` into their own tables. This migration
-- only ADDS the new tables; the original String[] columns on `plans` are
-- preserved untouched as the source of truth until R-151 backfills the new
-- tables and switches readers/writers. This keeps the change additive and
-- trivially rollbackable (just drop the three tables in down migration).
--
-- The schema mirrors the spec in docs/REMEDIATION_PLAN.md (R-150 fix_steps):
--   * (plan_id, slug) unique on every table
--   * deliverables get refType / refUri / status / superseded_by_id columns
--   * deliverables get a (plan_id, status) hot-list index
--   * constraints/standards get a (plan_id, kind) classifier index
--
-- All FKs cascade on plan delete to match the existing project→plan cascade
-- chain (a plan deletion already wipes its reviews, suggestions, comments,
-- so wiping its split items keeps the behaviour consistent).

-- CreateTable
CREATE TABLE "plan_deliverables" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "ref_type" TEXT,
    "ref_uri" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "superseded_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_deliverables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_constraints" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'general',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_constraints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_standards" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'general',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_standards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plan_deliverables_plan_id_slug_key" ON "plan_deliverables"("plan_id", "slug");

-- CreateIndex
CREATE INDEX "plan_deliverables_plan_id_status_idx" ON "plan_deliverables"("plan_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "plan_constraints_plan_id_slug_key" ON "plan_constraints"("plan_id", "slug");

-- CreateIndex
CREATE INDEX "plan_constraints_plan_id_kind_idx" ON "plan_constraints"("plan_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "plan_standards_plan_id_slug_key" ON "plan_standards"("plan_id", "slug");

-- CreateIndex
CREATE INDEX "plan_standards_plan_id_kind_idx" ON "plan_standards"("plan_id", "kind");

-- AddForeignKey
ALTER TABLE "plan_deliverables"
    ADD CONSTRAINT "plan_deliverables_plan_id_fkey"
    FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_deliverables"
    ADD CONSTRAINT "plan_deliverables_superseded_by_id_fkey"
    FOREIGN KEY ("superseded_by_id") REFERENCES "plan_deliverables"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_constraints"
    ADD CONSTRAINT "plan_constraints_plan_id_fkey"
    FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_standards"
    ADD CONSTRAINT "plan_standards_plan_id_fkey"
    FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
