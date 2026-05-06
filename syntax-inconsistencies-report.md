# PlanSync Syntax Inconsistencies & Bugs Report

**Generated:** 2026-05-06  
**Project:** test (cmotmrole000d8knzo1mrszie)  
**Plan:** v1 "PlanSync Syntax Testing"  
**Method:** Live tool invocations + cross-referencing CLAUDE.md, AGENTS.md, and MCP tool schemas

> Note: The five upstream verification tasks (plan lifecycle, task lifecycle, drift, suggestions, comments)
> were all in `todo` status when this task executed. Findings below come from direct tool probing
> and documentation cross-referencing, not from aggregating their outputs. See Finding 5 for the
> ordering issue this represents.

---

## Summary

| Severity  | Count  |
| --------- | ------ |
| HIGH      | 5      |
| MEDIUM    | 5      |
| LOW       | 4      |
| **Total** | **14** |

---

## Findings Table

| #   | Issue                                                                                                                                                                                                                                                            | Area               | Severity | Reproduction Steps                                                                                                                                                                                                                                                                                                    | Suggested Fix                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `plansync_plan_update` is referenced in CLAUDE.md in 4 places (lines 189, 200, 221, 241) but does not exist as an MCP tool                                                                                                                                       | Plan Management    | HIGH     | 1. Owner says "edit the plan goal". 2. CLAUDE.md instructs calling `plansync_plan_update`. 3. Tool call returns "tool not found".                                                                                                                                                                                     | Implement `plansync_plan_update` MCP tool with fields: `planId`, `projectId`, and any updatable plan field; or remove all references and replace with `plansync_plan_suggest` workflow.                                                                                              |
| 2   | `plansync_project_update` is referenced for "close project" / "reopen project" commands but does not exist as an MCP tool                                                                                                                                        | Project Management | HIGH     | 1. User says "close project". 2. CLAUDE.md maps this to `plansync_project_update { projectId, phase: "completed" }`. 3. Call returns "tool not found".                                                                                                                                                                | Implement `plansync_project_update { projectId, phase }` MCP tool, or map the commands to whichever tool actually transitions project phase.                                                                                                                                         |
| 3   | `plansync_task_update` is listed as **Blocked** in exec mode (CLAUDE.md tools table, line 35) yet is explicitly required by "Session Start Override" step 7, "After Work" section, and "Delegating Work" step 7                                                  | Task Management    | HIGH     | 1. Complete a task via `plansync_execution_complete`. 2. Follow documented step: `plansync_task_update { status: "done" }`. 3. Tool is unavailable in exec mode — returns "tool not found" or is absent from MCP registration.                                                                                        | Option A: Unblock `plansync_task_update` for `status` field on own assigned task in exec mode. Option B: Document that `plansync_execution_complete` automatically sets task status to `done`, and remove `plansync_task_update` from all post-completion steps.                     |
| 4   | `plansync_plan_diff` requires an undocumented `compareWith` query parameter; calling it with only `planId` + `projectId` (as documented) returns an error                                                                                                        | Plan Lifecycle     | HIGH     | 1. Call `plansync_plan_diff { projectId: "...", planId: "cmotnsayp000j8knz9slmwth9" }`. 2. API returns: `"compareWith query param required (plan ID to compare against)"`. 3. MCP tool schema shows only `planId` and `projectId` parameters — `compareWith` is absent from schema.                                   | Add `compareWith` (optional, defaults to predecessor) to MCP tool schema and CLAUDE.md docs; for v1 plans (no predecessor), return `{ changes: [], summary: "First version — no predecessor", breakingChanges: false }` instead of an error.                                         |
| 5   | No dependency enforcement: compilation/aggregation task (`cmotor302000u26i7j8y7q16z`) was allowed to start while all 5 upstream research tasks remain `todo`; `plansync_check_task_conflicts` correctly flagged this as HIGH but the API did not block execution | Task Ordering      | HIGH     | 1. Create task A that aggregates output from tasks B–F. 2. Start task A via `plansync_execution_start` without completing B–F. 3. Execution starts successfully with no warning or error. 4. Run `plansync_check_task_conflicts` — reports HIGH conflict but only after execution has begun.                          | Add optional `dependsOn: [taskId]` field to task schema. Validate in `plansync_execution_start`: if any `dependsOn` task is not `done`, return a `DEPENDENCY_INCOMPLETE` error (or warning with override flag). Surface in `plansync_task_pack` as a pre-work check.                 |
| 6   | `plansync_delegation_clear` is referenced in CLAUDE.md delegation flow (line 430) but does not exist as an MCP tool                                                                                                                                              | Delegation         | MEDIUM   | 1. Finish processing all of an agent's delegated work. 2. CLAUDE.md instructs: "call `plansync_delegation_clear`". 3. Call returns "tool not found".                                                                                                                                                                  | Implement `plansync_delegation_clear` MCP tool, or remove the reference and document the correct end-of-delegation signal (if the concept no longer applies).                                                                                                                        |
| 7   | `plansync_review_approve` and `plansync_review_reject` are referenced in the delegation P1 flow (CLAUDE.md line 402) but neither exists as an MCP tool                                                                                                           | Review Flow        | MEDIUM   | 1. Write review comment via `plansync_comment_create`. 2. Follow documented step: call `plansync_review_approve { asUser: "<agent>" }`. 3. Call returns "tool not found".                                                                                                                                             | Implement `plansync_review_approve` and `plansync_review_reject` MCP tools with `asUser` parameter; or document the actual API call that submits a review decision (e.g., a parameter on `plansync_comment_create`).                                                                 |
| 8   | AGENTS.md and CLAUDE.md describe conflicting session start protocols: AGENTS.md says "call `plansync_status` first", CLAUDE.md says "call `plansync_exec_context` first, then branch on `execMode`"                                                              | Documentation      | MEDIUM   | 1. AI agent reads AGENTS.md (the standard file for non-terminal use). 2. Session starts with `plansync_status`, skipping `plansync_exec_context`. 3. If session was launched via `/exec`, exec mode goes undetected — no heartbeats, no `execution_complete`. 4. Run appears to hang until heartbeat timeout (5 min). | Merge session start logic: update AGENTS.md to instruct calling `plansync_exec_context` first, then branching as CLAUDE.md describes. Keep AGENTS.md as the single source of truth for agents not using Terminal Mode.                                                               |
| 9   | The review approval API accepted a one-paragraph free-form comment that violates CLAUDE.md's review rules ("Blanket approvals without evidence are not acceptable") — no server-side enforcement                                                                 | Review Flow        | MEDIUM   | 1. Call review approval with comment: "Plan covers all key flows... Approved." (observed in `plansync_plan_active.reviews[0].comment`). 2. API accepts it. 3. CLAUDE.md rule: structured template with role perspective, impact, concerns, questions, and evidence is required.                                       | Add server-side validation: require review comment to meet a minimum structure (e.g., must include "Decision: APPROVE/REJECT" token and be ≥ N characters); or surface a linting warning in the API response when structure is missing.                                              |
| 10  | `plansync_who` response does not include `runId` in executor objects — cannot trace from "who is running" to a specific execution run for audit                                                                                                                  | Execution          | MEDIUM   | 1. Call `plansync_who { projectId }`. 2. Response: `{ executors: [{ assignee, assigneeType, taskId, taskTitle, boundPlanVersion }] }`. 3. `runId` is absent — cannot cross-reference with `plansync_activity_list` execution records without a separate lookup.                                                       | Add `runId` field to executor objects in `plansync_who` response.                                                                                                                                                                                                                    |
| 11  | CLAUDE.md line 308 states "Three contexts produce comments" but the immediately following note says "Why two templates?" — contradictory copy within the same paragraph                                                                                          | Documentation      | LOW      | 1. Read CLAUDE.md "Comment Templates" section header. 2. First line: "Three contexts produce comments." 3. Next line: "> Why two templates?" 4. Contradiction: `<decision>` is a third context but is labeled free-form and excluded from the template count.                                                         | Change the header to: "Three contexts produce comments — two structured templates (`<review>`, `<pre-work>`) and one free-form (`<decision>`). Pick the matching format."                                                                                                            |
| 12  | `plansync_plan_diff` on a v1 plan (no predecessor) returns a generic error rather than a meaningful first-version signal                                                                                                                                         | Plan Lifecycle     | LOW      | 1. Plan v1 is the only version (no predecessor). 2. Call `plansync_plan_diff { projectId, planId, compareWith: <v1-id> }`. 3. Alternatively, call without `compareWith` — returns "compareWith query param required". 4. No sentinel response for the valid first-version case.                                       | Server should detect "first version, no predecessor" and return `{ changes: [], summary: "First version — no predecessor to diff", breakingChanges: false }`. CLAUDE.md already anticipates this with "First proposal, no diff" in the review template.                              |
| 13  | Transient "Not connected" errors from `plansync_task_show` and `plansync_member_list` during a single session with no prior disconnect signal                                                                                                                    | Reliability        | LOW      | 1. Call `plansync_task_show` and `plansync_member_list` in parallel. 2. Both return `"Not connected"` error. 3. Retrying the same calls immediately succeeds. 4. No reconnect or retry signal is surfaced to the caller.                                                                                              | Add automatic reconnect with exponential backoff in the MCP client; surface `TRANSIENT_ERROR` code distinct from `NOT_CONNECTED` so callers can safely retry without ambiguity.                                                                                                      |
| 14  | Project `phase` remains `"planning"` while plan v1 is active and tasks are in-progress — the Case C1 banner template brackets `[active]` suggesting active plan = active phase, creating a confusing dual-state                                                  | Project Lifecycle  | LOW      | 1. Activate plan v1. 2. Start task execution. 3. Call `plansync_status` — `phase: "planning"`, `activePlanVersion: 1`, `taskStats.in_progress: 1`. 4. CLAUDE.md Case C1 banner: `Phase: planning → [active] → completed` — bracketing `[active]` implies the project is in the active phase, but it is not.           | Either (A) auto-advance project phase to `active` on first plan activation (current behavior requires explicit owner action), or (B) relabel phases to avoid collision with plan `status` field (e.g., use `setup`/`executing`/`closed` instead of `planning`/`active`/`completed`). |

---

## Appendix: Tool Availability Matrix (Exec Mode)

| Tool                                  | Documented      | In MCP Schema | Works in Exec Mode       | Notes                                         |
| ------------------------------------- | --------------- | ------------- | ------------------------ | --------------------------------------------- |
| `plansync_plan_update`                | ✅ CLAUDE.md ×4 | ❌            | ❌                       | Does not exist                                |
| `plansync_project_update`             | ✅ CLAUDE.md ×2 | ❌            | ❌                       | Does not exist                                |
| `plansync_task_update`                | ✅ CLAUDE.md ×3 | ❌            | ❌ (Blocked)             | Listed as blocked; listed in after-work steps |
| `plansync_delegation_clear`           | ✅ CLAUDE.md ×2 | ❌            | ❌                       | Does not exist                                |
| `plansync_review_approve`             | ✅ CLAUDE.md ×1 | ❌            | ❌                       | Does not exist                                |
| `plansync_review_reject`              | ✅ CLAUDE.md ×1 | ❌            | ❌                       | Does not exist                                |
| `plansync_plan_diff`                  | ✅ CLAUDE.md ×1 | ✅ (partial)  | ⚠️ (needs `compareWith`) | Schema missing required `compareWith` param   |
| `plansync_task_rebind`                | ✅              | ✅            | ✅                       | Works correctly                               |
| `plansync_drift_resolve`              | ✅              | ✅            | ✅                       | Works correctly                               |
| `plansync_comment_create/edit/delete` | ✅              | ✅            | ✅                       | Works correctly                               |
| `plansync_plan_suggest`               | ✅              | ✅            | ✅                       | Works correctly                               |
| `plansync_check_task_conflicts`       | ✅              | ✅            | ✅                       | Works correctly; detected dep ordering issue  |
| `plansync_task_show`                  | ✅              | ✅            | ⚠️ (transient)           | Occasional "Not connected" on first call      |
| `plansync_member_list`                | ✅              | ✅            | ⚠️ (transient)           | Occasional "Not connected" on first call      |

---

## Appendix: Raw Evidence

### Finding 4 — `plansync_plan_diff` error response

```
Tool: plansync_plan_diff { projectId: "cmotmrole000d8knzo1mrszie", planId: "cmotnsayp000j8knz9slmwth9" }
Error: "compareWith query param required (plan ID to compare against)"
```

### Finding 5 — `plansync_check_task_conflicts` output (excerpt)

```json
{
  "taskIds": ["cmotor302000u26i7j8y7q16z", "cmotor2zg000p26i7s1ogb5kr", "...all 6 tasks..."],
  "type": "dependency",
  "severity": "high",
  "description": "The 'Compile syntax inconsistencies & bugs report' task is in_progress but explicitly
    aggregates findings from the other five todo verification tasks. Compiling before those tests
    complete will result in an incomplete or empty report.",
  "recommendation": "Move the compilation task back to todo or block it until all five verification
    tasks complete."
}
```

### Finding 9 — Review comment stored in plan (from `plansync_plan_active`)

```json
{
  "reviewerName": "ai",
  "status": "approved",
  "comment": "Plan covers all key PlanSync syntax/tool flows: plan lifecycle, task lifecycle, drift,
    suggestions, comments, and reviewer flows. Constraints and standards are reasonable; deliverables
    are concrete and verifiable. Approved."
}
```

CLAUDE.md review rules state: "Blanket approvals without evidence ('LGTM', 'looks good') are not acceptable."
This comment is a concise summary without the required structured sections — accepted by API without error.

### Finding 13 — Transient errors observed

```
Tool: plansync_task_show (first attempt)  → Error: "Not connected"
Tool: plansync_member_list (first attempt) → Error: "Not connected"
Tool: plansync_task_show (second attempt)  → Success
Tool: plansync_member_list (second attempt) → Success
```
