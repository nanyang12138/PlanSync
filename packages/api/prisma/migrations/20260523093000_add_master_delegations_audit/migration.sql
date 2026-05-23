-- R-136: Audit trail for master-delegation (PLANSYNC_SECRET) usage.
--
-- Until this lands, presenting PLANSYNC_SECRET as the Bearer token + any
-- X-User-Name lets the caller act as that user with zero record. That's
-- fine in dev but unsafe in production where the env var represents the
-- entire blast radius of a single secret leak. This migration adds the
-- write-once audit table that R-136 lib code populates on every master
-- hit, plus indexes for the two access patterns:
--
--   1. "show me everything that happened to user X since timestamp T"
--      → owner-facing audit query (covered by target_user, occurred_at DESC)
--   2. "garbage-collect rows older than retention window"
--      → 10-min scanner (covered by expires_at)
--
-- The table is intentionally append-mostly. The only writes outside INSERT
-- are: (a) the 5-min reuse window in `master-audit.ts` does NOT update the
-- row (it just decides whether to insert a new one), and (b) the 7-day GC
-- scanner deletes by expires_at < now() - interval '7 days'.
--
-- Timestamp columns use TIMESTAMP(3) (not TIMESTAMPTZ) so Prisma's `DateTime`
-- maps cleanly without per-column @db.Timestamptz annotations — matches the
-- convention of every other timestamp column in this schema.

CREATE TABLE "master_delegations" (
  "id"           TEXT          NOT NULL,
  "caller_ip"    TEXT          NOT NULL,
  "caller_ua"    TEXT          NOT NULL,
  "target_user"  TEXT          NOT NULL,
  "route_method" TEXT          NOT NULL,
  "route_path"   TEXT          NOT NULL,
  "occurred_at"  TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"   TIMESTAMP(3)  NOT NULL,

  CONSTRAINT "master_delegations_pkey" PRIMARY KEY ("id")
);

-- Audit query path: most recent rows for a given impersonation target.
CREATE INDEX "master_delegations_target_user_occurred_at_idx"
  ON "master_delegations" ("target_user", "occurred_at" DESC);

-- GC scanner path: range-scan by retention boundary.
CREATE INDEX "master_delegations_expires_at_idx"
  ON "master_delegations" ("expires_at");

-- 5-min reuse window lookup: most recent unexpired row for (caller_ip,
-- target_user) used by recordMasterDelegation to decide insert-vs-reuse.
CREATE INDEX "master_delegations_caller_target_occurred_idx"
  ON "master_delegations" ("caller_ip", "target_user", "occurred_at" DESC);
