-- R-086: make the PlanComment self-relation onDelete behaviour explicit.
--
-- Before this migration the foreign key on plan_comments(parent_id) ->
-- plan_comments(id) used `ON DELETE SET NULL` (Prisma's implicit default for
-- an optional self-relation). That meant a hard delete of a parent comment
-- silently orphaned every reply in the thread, which is the opposite of the
-- product behaviour: comments are supposed to be soft-deleted via the
-- `is_deleted` flag, not removed from the database.
--
-- Switch the FK to `ON DELETE RESTRICT` so that any future hard delete of a
-- parent comment that still has replies fails loudly with a Postgres foreign
-- key violation (Prisma surfaces it as P2003) instead of corrupting the
-- thread structure. Plan deletion still cascades the entire comment subtree
-- away because plan_comments.plan_id -> plans.id is `ON DELETE CASCADE` and
-- Postgres evaluates the cascade for the whole subtree in a single statement
-- (children + parents are removed together, so the RESTRICT check on
-- parent_id is satisfied).

ALTER TABLE "plan_comments"
  DROP CONSTRAINT "plan_comments_parent_id_fkey";

ALTER TABLE "plan_comments"
  ADD CONSTRAINT "plan_comments_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "plan_comments"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
