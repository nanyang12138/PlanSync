-- R-143: completion-verify observability. Add four columns to execution_runs
-- so each AI completion verification persists its score/breakdown/feedback
-- and provider model. Without these, a 422 COMPLETION_VERIFICATION_FAILED
-- response leaves no DB trail and the owner cannot audit why the gate fired.
--
-- All four are nullable: legacy runs predate this column set, and human
-- executors / AI-unavailable code paths intentionally leave them blank.

ALTER TABLE "execution_runs"
  ADD COLUMN "ai_verify_score" DOUBLE PRECISION,
  ADD COLUMN "ai_verify_breakdown" JSONB,
  ADD COLUMN "ai_verify_feedback" TEXT,
  ADD COLUMN "ai_verify_model" TEXT;
