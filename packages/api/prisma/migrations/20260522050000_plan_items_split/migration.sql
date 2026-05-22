-- R-150: Split Plan.constraints / Plan.standards / Plan.deliverables (TEXT[])
-- into three same-shape side tables so each item gets a stable id, slug,
-- status state machine, optional external reference (file glob, API spec,
-- Figma frame, etc.), and independent edit history. The legacy String[]
-- columns on plans remain canonical for now; R-151 backfills these tables
-- via dual-write and R-152 switches every write path off the arrays.
--
-- All FKs cascade on plan delete so the rows disappear with their parent.
-- supersededById is a self-FK on plan_deliverables that records "this row
-- has been replaced by a later version"; SetNull keeps the historical row
-- visible if the successor is removed.

-- CreateTable
CREATE TABLE "plan_deliverables" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "ref_type" TEXT,
    "ref_uri" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "superseded_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_deliverables_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plan_deliverables_plan_id_slug_key" ON "plan_deliverables"("plan_id", "slug");

-- CreateIndex
CREATE INDEX "plan_deliverables_plan_id_status_idx" ON "plan_deliverables"("plan_id", "status");

-- CHECK constraints mirror the documented state machine. We use CHECK rather
-- than Postgres enums to stay consistent with the rest of the schema (B8 is
-- where every status column gets promoted to a real enum, in one pass).
ALTER TABLE "plan_deliverables"
  ADD CONSTRAINT "plan_deliverables_status_check"
  CHECK ("status" IN ('draft', 'active', 'done', 'deprecated'));

ALTER TABLE "plan_deliverables"
  ADD CONSTRAINT "plan_deliverables_ref_type_check"
  CHECK ("ref_type" IS NULL OR "ref_type" IN ('file_glob', 'api_spec', 'figma_frame', 'notion_page', 'free'));

-- AddForeignKey
ALTER TABLE "plan_deliverables"
  ADD CONSTRAINT "plan_deliverables_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Self FK: supersededById -> plan_deliverables.id
ALTER TABLE "plan_deliverables"
  ADD CONSTRAINT "plan_deliverables_superseded_by_id_fkey"
  FOREIGN KEY ("superseded_by_id") REFERENCES "plan_deliverables"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "plan_constraints" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "kind" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_constraints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plan_constraints_plan_id_slug_key" ON "plan_constraints"("plan_id", "slug");

-- CreateIndex
CREATE INDEX "plan_constraints_plan_id_kind_idx" ON "plan_constraints"("plan_id", "kind");

-- AddForeignKey
ALTER TABLE "plan_constraints"
  ADD CONSTRAINT "plan_constraints_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "plan_standards" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "kind" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_standards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plan_standards_plan_id_slug_key" ON "plan_standards"("plan_id", "slug");

-- CreateIndex
CREATE INDEX "plan_standards_plan_id_kind_idx" ON "plan_standards"("plan_id", "kind");

-- AddForeignKey
ALTER TABLE "plan_standards"
  ADD CONSTRAINT "plan_standards_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
