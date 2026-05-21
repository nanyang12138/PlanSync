-- R-048: Enforce at most one Plan with status='active' per project.
-- Defends against the race where two concurrent activate requests both flip a
-- plan to status='active' before the prior "set previous active to superseded"
-- update in the other transaction can be observed.
--
-- Prisma does not natively support partial unique indexes (as of the version
-- used here), so this is created via raw SQL. The corresponding schema.prisma
-- model carries a comment pointing here.
CREATE UNIQUE INDEX "plans_one_active_per_project"
  ON "plans" ("project_id")
  WHERE "status" = 'active';
