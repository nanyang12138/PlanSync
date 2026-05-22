# Prisma migrations — partial unique index inventory

Prisma does not currently support partial unique indexes (`CREATE UNIQUE INDEX ... WHERE ...`)
in its schema DSL. Several invariants in PlanSync rely on partial unique
indexes, so the indexes are created by **raw-SQL migrations** and only
referenced (via `// R-084` comments) from `schema.prisma`.

This file is the single source of truth for which partial unique indexes are
expected to exist in a production database. If you add a new partial unique
index, append it here and add a vitest assertion in
`packages/api/tests/integration/schema-partial-indexes.test.ts` so a fresh
`prisma migrate deploy` run is verified to materialize it.

## Why partial unique indexes matter

A partial unique index lets us guarantee at most one row matches a predicate
without needing application-level locking. We use them for two correctness
invariants that would otherwise be racy under concurrent writes:

1. **"One active plan per project"** — defends against two `plan.activate`
   requests both flipping a plan to `active` at the same instant.
2. **"One running execution run per task"** — defends against two
   `plansync_execution_start` callers both creating a `running` run for the
   same task.

In both cases the Prisma client catches the `P2002` unique violation and the
API returns a structured `STATE_CONFLICT` (HTTP 409) instead of leaving the
DB in an inconsistent state.

## Current inventory

| Index name | Table | Columns | Predicate | Migration | Issue |
| --- | --- | --- | --- | --- | --- |
| `plans_one_active_per_project` | `plans` | `(project_id)` | `WHERE status = 'active'` | `20260521080000_one_active_plan_per_project` | R-048 |
| `execution_runs_one_running_per_task` | `execution_runs` | `(task_id)` | `WHERE status = 'running'` | `20260421000000_one_running_run_per_task` | — |

> Note: the second index pre-dates R-048 but follows the same pattern. R-084
> retroactively documents it so `schema.prisma` readers know it exists.

## How to verify after `prisma migrate deploy`

The integration test
`packages/api/tests/integration/schema-partial-indexes.test.ts` queries
`pg_indexes` to confirm both indexes exist and carry the expected `WHERE`
predicate after migrations run. To check by hand on a freshly reset database:

```bash
bash scripts/db-reset.sh
bash scripts/db-psql.sh -c "\\d+ plans" | grep one_active
bash scripts/db-psql.sh -c "\\d+ execution_runs" | grep one_running
```

Both lines should print the partial index with its `WHERE` clause.

## How to add a new partial unique index

1. Write a raw-SQL migration under `packages/api/prisma/migrations/`.
2. Add a `// R-084: see prisma/migrations/README.md` comment on the affected
   model in `schema.prisma` so future readers know the schema is incomplete
   on purpose.
3. Append a row to the inventory table above.
4. Extend `schema-partial-indexes.test.ts` with an assertion for the new
   index name + predicate.
