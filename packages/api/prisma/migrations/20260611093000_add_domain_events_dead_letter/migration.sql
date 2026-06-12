-- R-208: dead-letter for the R-162 outbox consumer.
--
-- Before this, a handler that threw bumped `attempt` but left
-- `delivered_at` NULL forever, so the consumer retried the same row on
-- every 1s tick with no cap and no terminal state. A permanently-broken
-- event (e.g. a malformed github_push, R-192) would retry indefinitely and,
-- because it never leaves the pending working set, sit at the head of the
-- id-ASC scan window. This mirrors the R-139 webhook-worker terminal-state
-- pattern (`status='failed'` + `last_error` after WEBHOOK_MAX_ATTEMPTS):
-- after OUTBOX_MAX_ATTEMPTS the consumer marks the row failed (dead-letter)
-- with the last error, and stops retrying it.
--
-- We deliberately add two nullable columns rather than a status enum to keep
-- the change minimal and preserve the existing `delivered_at IS NULL`
-- success-signal semantics. A row is:
--   pending   : delivered_at IS NULL AND failed_at IS NULL
--   delivered : delivered_at IS NOT NULL
--   dead-letter: failed_at IS NOT NULL
ALTER TABLE "domain_events" ADD COLUMN "failed_at" TIMESTAMP(3);
ALTER TABLE "domain_events" ADD COLUMN "last_error" TEXT;

-- Replace the pending partial index so dead-lettered rows also drop out of
-- the consumer's working set (the consumer now scans
-- `WHERE delivered_at IS NULL AND failed_at IS NULL`). Without this the
-- failed rows would stay in the index and the consumer would keep paying to
-- skip them on every scan.
DROP INDEX IF EXISTS "domain_events_pending_idx";
CREATE INDEX "domain_events_pending_idx"
  ON "domain_events" ("id")
  WHERE "delivered_at" IS NULL AND "failed_at" IS NULL;

-- Partial index for the dead-letter queue view ("show me events that gave up")
-- so operators / a future DLQ admin endpoint can list them without a full scan.
CREATE INDEX "domain_events_dead_letter_idx"
  ON "domain_events" ("id")
  WHERE "failed_at" IS NOT NULL;
