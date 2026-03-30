# PlanSync

> **[Read this in Chinese](./README.zh-CN.md)**

**Keep AI Agents and human developers in sync when plans change.**

---

## What problem does it solve?

In team projects, the biggest risk isn't coding — it's **information drift**. The Owner updates the plan, but someone is still working on the old version.

PlanSync fixes this:

- The Owner writes a Plan, breaks it into Tasks, and assigns them to members
- Members work directly from their AI tool (Cursor / Claude Code / Genie) — view tasks, claim tasks, report progress
- When the plan changes, affected members get a **Drift Alert** immediately

Everything happens through AI chat. No context switching required.

---

## Quick Start

```bash
# Owner: start the local PlanSync service
cd /path/to/PlanSync
./bin/ps-admin start
```

```bash
# Member: connect your AI tool
./bin/plansync --host cursor    # Cursor
./bin/plansync --host claude    # Claude Code
./bin/plansync --host genie     # Genie (default)
```

For single-user local development, **zero global Node/npm setup** is needed. Both commands auto-prepare the fixed project-local runtime in `.local-runtime/node`, so nothing needs to be installed into your home directory first.

`./bin/ps-admin start` auto-prepares the server side (runtime, dependencies, database, migrations) before starting the API. `./bin/plansync --host ...` auto-prepares the client side (runtime, dependencies, MCP build output) before connecting your AI tool.

---

## Configuration

All settings live in a single **`.env`** file at the project root. Both `./bin/ps-admin` and `./bin/plansync` create it automatically from `.env.example` on first run if it does not exist.

### Single user (local)

Nothing to change — defaults work out of the box.

### Team collaboration

Edit `.env` with the info from your Owner:

```bash
PLANSYNC_USER=alice                        # Your identity (default: system $USER)
PLANSYNC_API_URL=http://192.168.1.10:3001  # API address (skip for localhost)
PLANSYNC_SECRET=your-team-secret           # Auth secret (get from Owner)
```

The `bin/plansync` launcher reads `.env` automatically — no need to pass environment variables on the command line.

> **Full variable list:** see [Configuration Reference](#configuration-reference)

---

## Team Collaboration

### What the Owner does

1. Run `./bin/ps-admin start` on the server
2. Set a `PLANSYNC_SECRET` in `.env`, share the **API address** and **secret** with the team
3. Choose either Owner workflow:
   - Web: open the dashboard in your browser, then manage plans directly from the `Plans` page (create draft, edit, propose, activate, reactivate)
   - AI: run `./bin/plansync --user <owner-name> --host cursor`, then use the `plansync_plan_*` MCP tools
4. In AI chat or via the web UI, create the project and members:

```
> Create project "Login System"
> Add member alice (developer)
> Add member bob (developer)
```

5. Assign tasks:

```
> Create task "Implement login API", assign to alice
> Create task "Build login page UI", leave unassigned
```

> **Member names = identity credentials.** They must exactly match each member's `PLANSYNC_USER` (case-sensitive). When in doubt, ask them to run `echo $USER`.

### What members do

1. Get the API address and secret from the Owner
2. Edit `.env` (see "Team collaboration" example above)
3. Launch: `./bin/plansync --host cursor`
4. In AI chat:

```
> Show me my tasks
> Start task TASK-42
> Mark TASK-42 as done
```

### Task lifecycle

| Action               | Description                                                   |
| -------------------- | ------------------------------------------------------------- |
| **Assign**           | Owner creates a task with an assignee; the member is notified |
| **Accept / Decline** | Members can accept and start, or decline to send it back      |
| **Claim**            | Unassigned tasks can be self-claimed                          |
| **Complete**         | Mark as done                                                  |

---

## Configuration Reference

| Variable                    | Default                                           | Purpose                          |
| --------------------------- | ------------------------------------------------- | -------------------------------- |
| **Client (`bin/plansync`)** |                                                   |                                  |
| `PLANSYNC_USER`             | `$USER`                                           | Your identity in PlanSync        |
| `PLANSYNC_API_URL`          | `http://localhost:3001`                           | API server address               |
| `PLANSYNC_SECRET`           | `dev-secret`                                      | Auth secret (shared by the team) |
| **Server (API)**            |                                                   |                                  |
| `DATABASE_URL`              | `postgresql://$USER@localhost:15432/plansync_dev` | PostgreSQL connection string     |
| `PG_PORT`                   | `15432`                                           | PostgreSQL port                  |
| `PORT`                      | `3001`                                            | API server port                  |
| `AUTH_DISABLED`             | `false`                                           | Skip auth (local dev only)       |
| `LOG_LEVEL`                 | `info`                                            | Log level                        |
| **AI features (optional)**  |                                                   |                                  |
| `LLM_API_KEY`               | —                                                 | AMD internal LLM API key         |
| `LLM_API_BASE`              | `https://llm-api.amd.com`                         | LLM API URL                      |
| `LLM_MODEL_NAME`            | `Claude-Sonnet-4.5`                               | Model name                       |
| `ANTHROPIC_API_KEY`         | —                                                 | Anthropic API key                |

---

## Commands

| Command                        | Description                                                 |
| ------------------------------ | ----------------------------------------------------------- |
| `./bin/ps-admin start`         | Auto-prepare server dependencies and start the PlanSync API |
| `./bin/plansync --host cursor` | Auto-prepare client dependencies and connect Cursor         |
| `bash scripts/build.sh`        | Build all workspace packages using the local runtime        |
| `bash scripts/npm.sh test`     | Run tests through the project-local npm                     |
| `bash scripts/lint.sh`         | Run eslint through the project-local runtime                |
| `bash scripts/format.sh`       | Run prettier through the project-local runtime              |
| `bash scripts/db-reset.sh`     | Wipe the database and start fresh                           |
| `bash scripts/db-psql.sh`      | Open a PostgreSQL shell                                     |

Advanced / manual entry points:

- `bash scripts/setup.sh` for a full explicit owner bootstrap
- `bash scripts/dev.sh` to start the API directly once the environment is ready

---

## Core Concepts

**Identity model** — No registration, no passwords. The Owner adds member names via `plansync_member_add`; members declare who they are by setting `PLANSYNC_USER` in `.env`. The system matches permissions and tasks by name. Names are case-sensitive.

**Roles** — **Owner**: creates projects, writes plans, manages members. **Developer / Agent**: claims tasks, does the work, reports progress.

**Drift Alert** — When a plan is updated, the system detects which tasks were created against an older version and notifies affected members. On receiving an alert, stop current work and assess the impact before continuing.

---

## Project Structure

```
PlanSync/
├── packages/
│   ├── api/          # REST API (Next.js + Prisma + PostgreSQL)
│   ├── mcp-server/   # MCP Server (AI tools connect here)
│   ├── shared/       # Shared types & Zod schemas
│   └── cli/          # CLI tool
├── bin/plansync      # One-command launcher (auto-injects MCP config)
├── claude-md/        # AI Agent behavior instructions
└── scripts/          # Database & ops scripts
```

For detailed design docs, see [PLAN.md](./PLAN.md).

---

## FAQ

| Problem                            | Solution                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| Tasks not showing up               | Is `PLANSYNC_USER` in `.env` an exact match with the name the Owner registered? |
| `assignee is not a project member` | Have the Owner add the member first, or check spelling                          |
| `permission denied`                | `PLANSYNC_SECRET` in `.env` doesn't match the server                            |
| Forgot which members exist         | Ask in AI chat: "list project members"                                          |
| Want to start over                 | `bash scripts/db-reset.sh`                                                      |

---

## NFS Environment Notes

This project is adapted for NFS-mounted filesystems:

- PostgreSQL data stored in `/tmp` (local disk, avoids NFS file-locking issues)
- npm cache redirected to `/tmp/npm-cache-$USER`
- Node runtime installed under `.local-runtime/node` inside the repository
- MCP Server bundled with esbuild (avoids tsc OOM on NFS)
