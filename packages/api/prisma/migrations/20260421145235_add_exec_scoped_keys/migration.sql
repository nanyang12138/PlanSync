-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "exec_run_id" TEXT,
ADD COLUMN     "expires_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "api_keys_exec_run_id_idx" ON "api_keys"("exec_run_id");
