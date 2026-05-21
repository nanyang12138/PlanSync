-- R-008: introduce `superseded` status for ExecutionRun.
-- Used when a newer plan version is activated and supersedes a running execution.
-- We enforce the full status set via a CHECK constraint instead of a Postgres enum
-- to keep the migration backward-compatible (enum migration is tracked in B8).

ALTER TABLE "execution_runs"
  ADD CONSTRAINT "execution_runs_status_check"
  CHECK (
    "status" IN (
      'running',
      'completed',
      'failed',
      'cancelled',
      'stale',
      'superseded'
    )
  );
