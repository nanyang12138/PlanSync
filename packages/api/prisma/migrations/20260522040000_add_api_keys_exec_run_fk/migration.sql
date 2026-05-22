-- R-080: link api_keys.exec_run_id to execution_runs.id so deleting a run
-- nulls the back-reference instead of leaving a dangling pointer. Existing
-- rows that already point at a missing run are scrubbed first so the FK can
-- be created without violating referential integrity.

UPDATE "api_keys" AS k
SET "exec_run_id" = NULL
WHERE k."exec_run_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "execution_runs" r WHERE r."id" = k."exec_run_id"
  );

ALTER TABLE "api_keys"
ADD CONSTRAINT "api_keys_exec_run_id_fkey"
FOREIGN KEY ("exec_run_id") REFERENCES "execution_runs"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
