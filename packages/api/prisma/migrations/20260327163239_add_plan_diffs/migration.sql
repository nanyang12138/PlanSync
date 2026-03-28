-- AlterTable
ALTER TABLE "drift_alerts" ADD COLUMN     "affected_areas" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "plan_diff_id" TEXT;

-- CreateTable
CREATE TABLE "plan_diffs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "fromPlanId" TEXT NOT NULL,
    "toPlanId" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_diffs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plan_diffs_fromPlanId_toPlanId_key" ON "plan_diffs"("fromPlanId", "toPlanId");

-- AddForeignKey
ALTER TABLE "plan_diffs" ADD CONSTRAINT "plan_diffs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
