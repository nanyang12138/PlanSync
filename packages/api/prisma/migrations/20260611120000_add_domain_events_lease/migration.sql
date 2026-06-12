-- R-209: lease / ownership for the R-162 outbox consumer.
--
-- R-208 made the per-row claim a compare-and-swap on `attempt`, which stops
-- two workers that race the SAME read from both dispatching. It does NOT stop
-- a second worker from re-reading the row on a LATER tick while the first
-- worker's handler is still running (the row is still pending —
-- delivered_at IS NULL AND failed_at IS NULL — so it stays in the scan window).
-- Under >1 worker that produces a double dispatch, and a slow handler can be
-- re-claimed and retried all the way to dead-letter while its first run is
-- still in flight.
--
-- The fix is a visibility lease with an owner token:
--   * On claim the worker stamps `locked_until = now + lease` and a fresh
--     `claim_token`. The consumer's scan adds
--     `AND (locked_until IS NULL OR locked_until < now)`, so an in-flight row
--     is invisible to other workers until its lease expires.
--   * If the claiming worker crashes, the lease lapses and the row re-enters
--     the scan window — recoverable, unlike webhook-worker's permanent
--     `in_flight` flag (R-139).
--   * Every terminal write (deliver / dead-letter / retry) is guarded by
--     `claim_token`, so a slow worker whose lease expired and was taken over
--     by another worker cannot write a stale `delivered_at`/`failed_at` after
--     the new owner has already settled the row.
--
-- Two nullable columns, no enum — same minimalist posture as R-208.
ALTER TABLE "domain_events" ADD COLUMN "locked_until" TIMESTAMP(3);
ALTER TABLE "domain_events" ADD COLUMN "claim_token" TEXT;

-- The pending partial index predicate is unchanged
-- (delivered_at IS NULL AND failed_at IS NULL): the lease check is an
-- additional range filter over that same pending set, and the set is small,
-- so the existing index still backs the scan. Recreated here only so a fresh
-- database that runs migrations in order ends up with an identical index
-- definition regardless of which migrations are present.
DROP INDEX IF EXISTS "domain_events_pending_idx";
CREATE INDEX "domain_events_pending_idx"
  ON "domain_events" ("id")
  WHERE "delivered_at" IS NULL AND "failed_at" IS NULL;
