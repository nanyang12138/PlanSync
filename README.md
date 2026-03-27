# PlanSync

AI Team Collaboration Platform for Plan Alignment — ensuring AI agents and human developers stay synchronized when plans change.

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  AI Agent (MCP)  │───▶│  PlanSync API    │◀───│  Human (CLI/Web)│
│  38 MCP Tools    │    │  Next.js + Prisma │    │                 │
└─────────────────┘    └────────┬─────────┘    └─────────────────┘
                                │
                       ┌────────▼─────────┐
                       │   PostgreSQL      │
                       │   (/tmp, non-NFS) │
                       └──────────────────┘
```

## Quick Start

```bash
# 1. One-command setup (Node 18 + deps + PostgreSQL + migrations + seed)
npm run setup

# 2. Start development server
npm run dev

# 3. Verify everything works
curl http://localhost:3000/api/health
```

## Project Structure

```
PlanSync/
├── packages/
│   ├── shared/          # Zod schemas, TypeScript types, error handling
│   ├── api/             # Next.js API (REST endpoints + Prisma ORM)
│   │   ├── prisma/      # Schema, migrations, seed
│   │   ├── src/
│   │   │   ├── app/api/ # ~30 API routes across 8 domains
│   │   │   └── lib/     # auth, prisma, drift-engine, logger, etc.
│   │   └── tests/       # Unit + integration tests (vitest)
│   └── mcp-server/      # MCP Server (38 tools for AI agents)
├── scripts/             # setup.sh, dev.sh, pg-start/stop.sh, verify.sh
├── bin/plansync          # Wrapper script for Claude/Genie
└── claude-md/           # AI agent behavior instructions
```

## Key Commands

| Command | Description |
|---------|-------------|
| `npm run setup` | First-time setup (PostgreSQL, deps, migrations, seed) |
| `npm run dev` | Start API dev server (auto-starts PostgreSQL) |
| `npm run test` | Run all tests |
| `npm run lint` | Lint all TypeScript |
| `npm run db:start` | Start PostgreSQL only |
| `npm run db:stop` | Stop PostgreSQL |
| `npm run db:reset` | Destroy and recreate database |
| `npm run db:psql` | Interactive PostgreSQL shell |

## API Domains

| Domain | Endpoints | Description |
|--------|-----------|-------------|
| Project | 5 | CRUD + status aggregation |
| ProjectMember | 4 | CRUD with owner permissions |
| Plan | 8 | CRUD + propose/activate/reactivate lifecycle |
| PlanReview | 3 | List + approve/reject |
| PlanSuggestion | 4 | Structured modification proposals |
| PlanComment | 4 | Threaded discussion with soft delete |
| Task | 7 | CRUD + claim/rebind/pack |
| Activity | 1 | Paginated activity log |
| ExecutionRun | 4 | Start/heartbeat/complete agent runs |
| DriftAlert | 2 | List + resolve (rebind/cancel/no_impact) |

## Authentication

All API requests require:
- `Authorization: Bearer <PLANSYNC_SECRET>` header
- `X-User-Name: <username>` header

Set `AUTH_DISABLED=true` in `.env` to skip auth during local development.

## MCP Server (for AI Agents)

The MCP server provides 38 tools for AI agents to interact with PlanSync:

```bash
# Start via wrapper
./bin/plansync

# Environment variables
PLANSYNC_API_URL=http://localhost:3000
PLANSYNC_SECRET=dev-secret
PLANSYNC_USER=coder-agent
```

## NFS Environment Notes

This project runs on NFS-mounted filesystems. Key workarounds:
- PostgreSQL data stored in `/tmp` (local xfs disk)
- npm cache redirected to `/tmp/npm-cache-$USER`
- MCP server uses `esbuild` instead of `tsc` (OOM on NFS with large SDK types)
- All dependency versions pinned with `~` for Node 18 compatibility

## Testing

```bash
# Run all tests
npm run test

# Run specific test file
cd packages/api && npx vitest run tests/unit/drift-engine.test.ts
```

## License

Private — Internal use only.
