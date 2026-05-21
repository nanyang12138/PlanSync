-- R-002 (drift v2): introduce `paused` status for ExecutionRun.
--
-- A run becomes 'paused' the moment a newer plan version is activated and
-- the drift engine identifies it as bound to the now-superseded version.
-- 'paused' is non-terminal — endedAt stays null — until the agent ack-pauses
-- (→ superseded) or the pause-ack-timeout scanner sweeps it (also →
-- superseded with reason='pause_timeout'). The runs/[runId] route hard-
-- rejects heartbeat and complete in this state via code='RUN_PAUSED'.
--
-- We extend the existing CHECK constraint by dropping and re-creating it.
-- Postgres can't ADD to an existing CHECK in place, but this is safe and
-- forward-compatible: while the constraint is briefly absent (between DROP
-- and ADD inside the same statement-block), the table is still locked
-- because both statements run in the migration's implicit transaction.

ALTER TABLE "execution_runs"
  DROP CONSTRAINT IF EXISTS "execution_runs_status_check";

ALTER TABLE "execution_runs"
  ADD CONSTRAINT "execution_runs_status_check"
  CHECK (
    "status" IN (
      'running',
      'paused',
      'completed',
      'failed',
      'cancelled',
      'stale',
      'superseded'
    )
  );
