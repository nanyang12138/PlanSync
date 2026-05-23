-- R-182 (supersedes R-144): ai_calls table + provider observability.
-- Every LLM call goes through aiClient.complete() and now records a row
-- here so the owner can audit cost / latency / model / dedup ratio and so
-- R-183 can implement caching keyed on input_hash. Without this table,
-- AI failures are only logger.warn'd and successful calls leave no trace.
--
-- Schema notes:
--   - All token counts are nullable: providers do not always echo them
--     back (the mock provider never does), and a failed call has no
--     token count to record at all.
--   - input_hash / output_hash are sha256 hex (64 chars). They live on
--     the row even when ok=false so R-183 can short-circuit subsequent
--     identical prompts that previously errored.
--   - cache_hit always defaults to false. R-183 will flip it true when
--     a cached completion is served instead of a fresh provider call.
--   - error_code is a coarse machine-readable label
--     (e.g. 'timeout', 'http_429', 'parse_error', 'unknown') for
--     bucketed dashboards. The full error message stays in logs.
--   - prompt_version is an opaque caller-provided string; today it
--     defaults to 'v1' so old prompt revisions can be diff'd against
--     new ones once R-184 starts versioning system prompts.

CREATE TABLE "ai_calls" (
  "id" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "prompt_hash" TEXT NOT NULL,
  "input_hash" TEXT NOT NULL,
  "output_hash" TEXT,
  "prompt_version" TEXT NOT NULL DEFAULT 'v1',
  "latency_ms" INTEGER NOT NULL,
  "input_tokens" INTEGER,
  "output_tokens" INTEGER,
  "ok" BOOLEAN NOT NULL,
  "error_code" TEXT,
  "cache_hit" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_calls_pkey" PRIMARY KEY ("id")
);

-- Hot paths:
--   * /api/ai-usage aggregates by purpose, ordered by created_at.
--   * R-183 cache lookup is keyed on (input_hash, purpose) within a
--     recent time window.
CREATE INDEX "ai_calls_purpose_created_at_idx"
  ON "ai_calls"("purpose", "created_at" DESC);
CREATE INDEX "ai_calls_input_hash_purpose_idx"
  ON "ai_calls"("input_hash", "purpose");
CREATE INDEX "ai_calls_created_at_idx"
  ON "ai_calls"("created_at" DESC);
