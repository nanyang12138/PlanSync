-- Fix: projectId was created NOT NULL in some environments due to a historical
-- migration file edit. Make it nullable to allow global (non-project) API keys.
-- ALTER TABLE ... DROP NOT NULL is a no-op if the column is already nullable.
ALTER TABLE "api_keys" ALTER COLUMN "projectId" DROP NOT NULL;
