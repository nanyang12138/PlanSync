-- R-078: Add a composite index on webhook_deliveries(webhookId, createdAt DESC)
-- so that paginating a webhook's delivery history newest-first can use an
-- index scan instead of falling back to a sequential scan + sort as the
-- table grows. Mirrors the access pattern documented in
-- docs/REMEDIATION_PLAN.md (B8) and matches the column casing used by
-- the prior webhook_deliveries migration ("webhookId", "createdAt").

CREATE INDEX IF NOT EXISTS "webhook_deliveries_webhookId_createdAt_idx"
  ON "webhook_deliveries" ("webhookId", "createdAt" DESC);
