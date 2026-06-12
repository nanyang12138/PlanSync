# Deployment

This directory contains deployment scaffolding for PlanSync. See the top-level
`README.md` for the recommended developer workflow (`./bin/ps-admin start` +
`./bin/plansync`), which boots a local Postgres + Next.js without containers.

## Topology

PlanSync runs as three logical components today, mapped onto **two processes**:

| Component         | Process today                                | After R-202 split            |
| ----------------- | -------------------------------------------- | ---------------------------- |
| `plansync-api`    | Next.js (`packages/api`) — REST + SSE        | same                         |
| `plansync-web`    | served by the same Next.js process           | own Next.js / static service |
| `plansync-worker` | `packages/api/scripts/run-worker.ts` (R-138) | same                         |

The worker owns the heartbeat scanner (R-138), the persistent webhook
retry queue (R-139, opt-in via `PLANSYNC_WEBHOOK_QUEUE=true`), and the
transactional-outbox consumer (R-162, opt-in via
`PLANSYNC_OUTBOX_CONSUMER=true`). It is the single writer for those
subsystems — running multiple worker replicas is safe (advisory lock +
`SKIP LOCKED`).

**R-192 evidence pipeline:** the outbox consumer is what dispatches
`github_push` events to the R-191 commit→deliverable linker, producing the
`commit_deliverable_links` rows that R-192's completion gate reads. With
`PLANSYNC_OUTBOX_CONSUMER` unset/false the consumer is dormant: push events
accumulate undelivered, no links are written, and every git-gated task stays
parked in `awaiting_evidence`. Set `PLANSYNC_OUTBOX_CONSUMER=true` on this
worker to make the gate actually clear tasks. Note the in-API worker
(`PLANSYNC_RUN_WORKER_IN_API`, used by `scripts/dev.sh`) runs ONLY the
heartbeat scanner — the evidence pipeline requires this dedicated worker.

## docker-compose

`docker-compose.yml` boots three services — `postgres`, `plansync-api`,
`plansync-worker` — against a bind-mounted source tree. Suitable for dev /
CI smoke; **not** a production image.

```bash
cp .env.example .env                      # edit DATABASE_URL etc.
docker compose -f deploy/docker-compose.yml up --build
```

What it does:

- Starts Postgres 16 with `pg_isready` healthcheck.
- `plansync-api` waits for the healthcheck, runs `npm ci`, applies Prisma
  migrations (`prisma migrate deploy`), builds Next.js, then `next start`
  on port 3001.
- `plansync-worker` runs the same `npm ci` then `npm run --workspace=@plansync/api worker`,
  which boots the heartbeat scanner and webhook queue.

Override DB by pointing `DATABASE_URL` at an external Postgres via
`--env-file your.env`.

### Why no application Dockerfile?

A production image needs per-service trimming (Next.js standalone build for
`plansync-api`, `tsc` output for `plansync-worker`, no source mount). Adding
that here without R-202 splitting the web bundle out would lock in the
current "API + web in one process" shape. Deferred to the R-203 follow-up
PR that lands alongside R-202.

## Helm chart (planned)

Not in this PR. Tracked under R-203 follow-up — the chart can only sensibly
exist once R-202 makes `plansync-web` a separately deployable Service +
Deployment.

## Single-host without containers

`./bin/ps-admin start` is still the supported on-host path. It uses the
repo-local Node + Postgres runtimes in `.local-runtime/` (NFS-safe) and is
faster to iterate than rebuilding the compose stack.
