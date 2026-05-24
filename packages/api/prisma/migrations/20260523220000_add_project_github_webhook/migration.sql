-- R-190: per-project GitHub webhook configuration. `github_repo` is the
-- `owner/repo` slug used to route an incoming webhook to a single project,
-- and `github_webhook_secret` is the HMAC SHA-256 shared secret configured
-- in the GitHub webhook UI. Both are nullable so projects without GitHub
-- integration continue to work unchanged.
ALTER TABLE "projects"
  ADD COLUMN "github_repo" TEXT,
  ADD COLUMN "github_webhook_secret" TEXT;

-- Routing lookup path: the webhook receiver finds the target project by the
-- `owner/repo` slug carried in the GitHub payload's `repository.full_name`
-- field. Keep this a regular (non-unique) index because in principle two
-- different projects might track the same repo (different scopes, monorepo
-- subtrees, ...). The receiver fans out to all matching projects.
CREATE INDEX "projects_github_repo_idx" ON "projects" ("github_repo")
  WHERE "github_repo" IS NOT NULL;
