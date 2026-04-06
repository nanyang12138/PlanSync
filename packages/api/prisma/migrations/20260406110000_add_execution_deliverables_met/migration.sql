-- AlterTable
ALTER TABLE "execution_runs" ADD COLUMN "deliverables_met" TEXT[] NOT NULL DEFAULT '{}';
