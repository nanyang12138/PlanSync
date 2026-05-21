# PlanSync — AI Agent Instructions

You are working on a project managed by **PlanSync**, an AI team collaboration platform for plan alignment.

## SESSION START — MANDATORY (execute before responding to anything)

**When you first open a conversation in this workspace, you MUST immediately:**

1. Call `plansync_exec_context` (no arguments) — do this before anything else
   - If response has `execMode: true`: you were launched via `/exec` for a specific task. Follow the exec-mode flow: parse `taskPack` and `runId`, present your implementation approach, implement, then call `plansync_execution_complete`. Do NOT call `plansync_status` or show a banner.
   - If response has `execMode: false`: continue with the steps below
2. Call `plansync_status` — do not wait for the user to ask, do this before reading or responding to their first message
3. If `PLANSYNC_PROJECT` is not set or returns empty, call `plansync_project_list` so the user can choose a project
4. Greet the user with a structured summary:
   - Project name and current phase
   - Active plan: version, title, goal (one line)
   - Tasks: total count with status breakdown (todo / in_progress / done)
   - Open drift alerts: count — if > 0, mark ⚠️ and name the affected tasks
5. End with: **"What would you like to work on today?"**

**This is automatic — even if the user's first message is "hi" or a direct task request, call `plansync_exec_context` first (then `plansync_status` if not in exec mode), then respond.**

## Key Concepts

- **Plan**: A versioned document describing what to build (goal, scope, constraints, standards, deliverables). Only one plan is `active` at a time.
- **Task**: Work items bound to a specific plan version. When the plan changes, your task may drift.
- **Drift Alert**: Notification that your task is bound to an older plan version. Always check for drift before starting work.

## Before Starting a Task

1. Call `plansync_task_pack` with the task ID to get your full execution context (plan + task + constraints)
2. If there are open drift alerts affecting your task, stop and notify the user

## During Work

- Call `plansync_execution_start` at the beginning of your work session
- Follow the constraints and standards from the active plan
- If you discover the plan has issues, use `plansync_plan_suggest` to propose changes
- Use `plansync_comment_create` to document decisions and questions

## After Work

- Call `plansync_execution_complete` with a summary of what you did — this marks the task done

## If You Detect Drift

If `plansync_task_pack` shows drift alerts:

1. **STOP** your current work
2. Read the drift alert details to understand what changed
3. Notify the user: "⚠ Plan has changed since this task was created"
4. Wait for the user/owner to resolve the drift (rebind, cancel, or mark as no_impact)

## Important Rules

- Never ignore drift alerts — they mean the plan has changed
- Always check `plansync_status` at the start of a session
- Use structured suggestions (`plansync_plan_suggest`) instead of ad-hoc comments for plan changes
- Record all significant decisions as comments for the team

## Cursor Cloud specific instructions

### Pre-installed by update script

The Cloud Agent startup script handles: PostgreSQL 16 installation, `/var/run/postgresql` socket-directory permissions, repo-local Node.js v22.14.0 runtime, npm workspace dependencies, `.env` creation, and PG data-dir initialisation. You do **not** need to repeat these steps.

### PG_BIN auto-detection

All `scripts/*.sh` files auto-detect `PG_BIN` at runtime: AMD internal path (`/tool/pandora64/bin`) is preferred when present; otherwise falls back to `/usr/lib/postgresql/16/bin`. No manual export is needed when running repo scripts. If you call PG tools directly outside of repo scripts, `PG_BIN` is also exported from `~/.bashrc`.

### Starting PostgreSQL

PostgreSQL data lives in `/tmp/plansync-pgdata-$USER` (ephemeral). If the data dir was wiped, run:

```bash
export PATH="${PG_BIN:-/usr/lib/postgresql/16/bin}:$PATH"
initdb -D "/tmp/plansync-pgdata-$(whoami)" 2>/dev/null
pg_ctl -D "/tmp/plansync-pgdata-$(whoami)" -l "/tmp/plansync-pgdata-$(whoami)/logfile" -o "-p 15432" start
createdb -p 15432 plansync_dev 2>/dev/null || true
```

Or use the repo helper: `bash scripts/pg-start.sh`

### Running services

Standard commands are documented in `CLAUDE.md`. Quick reference:

| Task                                         | Command                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Dev server (PG + migrations + Next.js :3001) | `bash scripts/dev.sh`                                                                                                     |
| Build all packages                           | `bash scripts/build.sh`                                                                                                   |
| Lint                                         | `bash scripts/lint.sh`                                                                                                    |
| Tests (requires PG running)                  | `bash scripts/test.sh`                                                                                                    |
| Single workspace test                        | `bash -c '. scripts/local-node-runtime.sh && use_local_node_runtime && run_local_npm run test --workspace=@plansync/api'` |

### Gotchas

- The project uses a **repo-local Node.js v22.14.0** in `.local-runtime/node`. All scripts source `scripts/local-node-runtime.sh`. Do not use system `node`/`npm` for project scripts.
- `DATABASE_URL` defaults to `postgresql://$USER@localhost:15432/plansync_dev` (from `.env`). When running commands outside repo scripts, source `.env` first or export it manually.
- `sendmail failed` warnings in test output are expected and harmless — the Cloud VM has no mail transport.
- AI features silently no-op without `LLM_API_KEY` or `ANTHROPIC_API_KEY`; 3 AI tests are skipped accordingly.
