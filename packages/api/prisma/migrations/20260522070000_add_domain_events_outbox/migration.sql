-- R-160: transactional outbox table. Every state-changing event (plan
-- activated, drift detected, task started, ...) is written into this table
-- inside the same DB transaction that performed the change. A separate
-- worker process (R-162) drains rows where delivered_at IS NULL and fans
-- them out to the existing SSE / webhook / email / activity sinks. This
-- closes the gap where an in-memory eventBus.publish() could be lost on
-- API restart or where a webhook dispatcher could fire even though the
-- producing transaction rolled back.
--
-- The id is bigserial so the worker has a monotonic cursor for
-- lastEventId-style replay (R-163 SSE).
CREATE TABLE "domain_events" (
  "id"           BIGSERIAL    PRIMARY KEY,
  "event_type"   TEXT         NOT NULL,
  "project_id"   TEXT,
  "user_name"    TEXT,
  "payload"      JSONB        NOT NULL,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "delivered_at" TIMESTAMP(3),
  "attempt"      INTEGER      NOT NULL DEFAULT 0
);

-- Partial index that backs the consumer's hot path:
--   SELECT ... WHERE delivered_at IS NULL ORDER BY id ASC FOR UPDATE SKIP LOCKED
-- A partial index keeps only the unpicked rows (the working set), so the
-- index stays tiny even after millions of delivered events accumulate. Prisma
-- cannot express partial indexes today, so we create it as raw SQL here and
-- intentionally accept that `prisma db pull` would re-emit it as a plain
-- `@@index([deliveredAt, id])`.
CREATE INDEX "domain_events_pending_idx"
  ON "domain_events" ("id")
  WHERE "delivered_at" IS NULL;

-- Secondary index for ad-hoc audit queries scoped to a project ("show me the
-- last 50 events for project X"). Kept non-partial so it works for both
-- delivered and pending rows.
CREATE INDEX "domain_events_project_id_id_idx"
  ON "domain_events" ("project_id", "id" DESC);
