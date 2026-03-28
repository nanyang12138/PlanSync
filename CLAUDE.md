# PlanSync — AI Agent Instructions

You are working on a project managed by **PlanSync**, an AI team collaboration platform for plan alignment.

## Key Concepts

- **Plan**: A versioned document describing what to build (goal, scope, constraints, standards, deliverables). Only one plan is `active` at a time.
- **Task**: Work items bound to a specific plan version. When the plan changes, your task may drift.
- **Drift Alert**: Notification that your task is bound to an older plan version. Always check for drift before starting work.

## Before Starting Work

1. Call `plansync_status` to see the project overview, active plan, and any open drift alerts
2. Call `plansync_task_pack` to get your full execution context (plan + task + constraints)
3. If there are open drift alerts affecting your task, stop and notify the user

## During Work

- Call `plansync_execution_start` at the beginning of your work session
- Follow the constraints and standards from the active plan
- If you discover the plan has issues, use `plansync_plan_suggest` to propose changes
- Use `plansync_comment_create` to document decisions and questions

## After Work

- Call `plansync_execution_complete` with a summary of what you did
- Update task status via `plansync_task_update`

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
