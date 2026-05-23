-- R-180: advisory verification reviews.
--
-- Before R-180 the completion-verify gate hard-failed with HTTP 422 when the
-- AI verifier scored a run below the 75 threshold. The new contract is:
--   * completion always succeeds (the hard gate moves to R-181 rule eval),
--   * the AI score / feedback / breakdown are persisted as an advisory review.
--
-- Owner-facing UI surfaces these rows so a low score is visible-but-overridable
-- instead of the previous "complete blocked, agent retries forever" loop.
--
-- `kind` is a free-form String so R-181 can add rule-based advisory kinds
-- without a schema migration. `metadata` JSONB carries kind-specific structured
-- data (for `ai_verification` it stores `{ breakdown, model }`).
--
-- ON DELETE CASCADE on the runId FK matches every other ExecutionRun child
-- table — when a run row is removed (project cascade, manual cleanup) the
-- advisory rows go with it.

CREATE TABLE "run_reviews" (
    "id"         TEXT             NOT NULL,
    "run_id"     TEXT             NOT NULL,
    "kind"       TEXT             NOT NULL,
    "score"      DOUBLE PRECISION,
    "feedback"   TEXT,
    "metadata"   JSONB,
    "created_at" TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_reviews_pkey" PRIMARY KEY ("id")
);

-- The hot read path is "list reviews for a run, newest first" (owner UI deep
-- link). A composite index on (run_id, created_at DESC) keeps that query on a
-- B-tree scan even as the table grows.
CREATE INDEX "run_reviews_run_id_created_at_idx"
    ON "run_reviews" ("run_id", "created_at" DESC);

ALTER TABLE "run_reviews"
    ADD CONSTRAINT "run_reviews_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "execution_runs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
