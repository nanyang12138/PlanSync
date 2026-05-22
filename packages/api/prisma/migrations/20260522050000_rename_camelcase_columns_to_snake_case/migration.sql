-- R-085: bring the late-comer tables (api_keys, webhooks, webhook_deliveries,
-- plan_diffs) in line with the snake_case column convention used by every
-- other table in the schema. Older migrations created these tables with
-- bare camelCase identifiers, which left raw SQL queries and ad-hoc psql
-- inspection inconsistent. Prisma now declares an explicit `@map` for each
-- of these columns, and this migration renames the underlying columns,
-- indexes, and FK constraints to match.

-- ----------------------------------------------------------------------------
-- api_keys
-- ----------------------------------------------------------------------------
ALTER TABLE "api_keys" RENAME COLUMN "projectId" TO "project_id";
ALTER TABLE "api_keys" RENAME COLUMN "keyHash" TO "key_hash";
ALTER TABLE "api_keys" RENAME COLUMN "keyPrefix" TO "key_prefix";
ALTER TABLE "api_keys" RENAME COLUMN "createdBy" TO "created_by";
ALTER TABLE "api_keys" RENAME COLUMN "lastUsedAt" TO "last_used_at";
ALTER TABLE "api_keys" RENAME COLUMN "createdAt" TO "created_at";

ALTER INDEX "api_keys_keyPrefix_idx" RENAME TO "api_keys_key_prefix_idx";

ALTER TABLE "api_keys" RENAME CONSTRAINT "api_keys_projectId_fkey"
  TO "api_keys_project_id_fkey";

-- ----------------------------------------------------------------------------
-- webhooks
-- ----------------------------------------------------------------------------
ALTER TABLE "webhooks" RENAME COLUMN "projectId" TO "project_id";
ALTER TABLE "webhooks" RENAME COLUMN "createdBy" TO "created_by";
ALTER TABLE "webhooks" RENAME COLUMN "createdAt" TO "created_at";

ALTER TABLE "webhooks" RENAME CONSTRAINT "webhooks_projectId_fkey"
  TO "webhooks_project_id_fkey";

-- ----------------------------------------------------------------------------
-- webhook_deliveries
-- ----------------------------------------------------------------------------
ALTER TABLE "webhook_deliveries" RENAME COLUMN "webhookId" TO "webhook_id";
ALTER TABLE "webhook_deliveries" RENAME COLUMN "requestBody" TO "request_body";
ALTER TABLE "webhook_deliveries" RENAME COLUMN "responseCode" TO "response_code";
ALTER TABLE "webhook_deliveries" RENAME COLUMN "errorMessage" TO "error_message";
ALTER TABLE "webhook_deliveries" RENAME COLUMN "createdAt" TO "created_at";

ALTER INDEX "webhook_deliveries_webhookId_createdAt_idx"
  RENAME TO "webhook_deliveries_webhook_id_created_at_idx";

ALTER TABLE "webhook_deliveries" RENAME CONSTRAINT "webhook_deliveries_webhookId_fkey"
  TO "webhook_deliveries_webhook_id_fkey";

-- ----------------------------------------------------------------------------
-- plan_diffs
-- ----------------------------------------------------------------------------
ALTER TABLE "plan_diffs" RENAME COLUMN "projectId" TO "project_id";
ALTER TABLE "plan_diffs" RENAME COLUMN "fromPlanId" TO "from_plan_id";
ALTER TABLE "plan_diffs" RENAME COLUMN "toPlanId" TO "to_plan_id";
ALTER TABLE "plan_diffs" RENAME COLUMN "generatedAt" TO "generated_at";

ALTER INDEX "plan_diffs_fromPlanId_toPlanId_key"
  RENAME TO "plan_diffs_from_plan_id_to_plan_id_key";
ALTER INDEX "plan_diffs_fromPlanId_idx"
  RENAME TO "plan_diffs_from_plan_id_idx";
ALTER INDEX "plan_diffs_toPlanId_idx"
  RENAME TO "plan_diffs_to_plan_id_idx";

ALTER TABLE "plan_diffs" RENAME CONSTRAINT "plan_diffs_projectId_fkey"
  TO "plan_diffs_project_id_fkey";
ALTER TABLE "plan_diffs" RENAME CONSTRAINT "plan_diffs_fromPlanId_fkey"
  TO "plan_diffs_from_plan_id_fkey";
ALTER TABLE "plan_diffs" RENAME CONSTRAINT "plan_diffs_toPlanId_fkey"
  TO "plan_diffs_to_plan_id_fkey";
