-- R-139: persistent webhook retry queue.
--
-- Before this migration `deliverWithRetry` performed all retries via
-- in-memory `setTimeout` schedules. An API restart between the first
-- 1s/5s/30s back-off and the final attempt silently dropped every
-- pending retry: no DB row existed to replay from. The user-facing
-- call to `dispatchWebhooks` had already returned (it is fire-and-
-- forget) so receivers stayed permanently silent.
--
-- This table replaces that in-memory schedule with one durable row per
-- webhook subscription per event. A dedicated worker (started by
-- `scripts/run-worker.ts` from R-138, gated by `PLANSYNC_WEBHOOK_QUEUE=true`)
-- is the only thing that performs HTTP — a process restart loses at
-- most the in-flight HTTP request, not the retry schedule.
--
-- Status is a narrow TEXT (not an enum) so the column stays additive:
-- the worker can grow new states (`paused`, `cancelled`, ...) without
-- another migration. Indexes target the worker's hot query
-- (`status='pending' AND next_attempt_at <= now()`).
CREATE TABLE "webhook_jobs" (
    "id" TEXT NOT NULL,
    "webhook_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhook_jobs_status_next_attempt_at_idx" ON "webhook_jobs"("status", "next_attempt_at");
CREATE INDEX "webhook_jobs_webhook_id_idx" ON "webhook_jobs"("webhook_id");

ALTER TABLE "webhook_jobs"
    ADD CONSTRAINT "webhook_jobs_webhook_id_fkey"
    FOREIGN KEY ("webhook_id") REFERENCES "webhooks"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
