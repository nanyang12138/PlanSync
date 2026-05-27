/**
 * Exec-mode and delegation-mode tool allowlists.
 *
 * Extracted from `index.ts` (previously inline inside `main()`) so the
 * security boundary they describe — "which tools an exec-scoped or
 * delegation-scoped MCP session is allowed to call" — can be pinned by a
 * unit test rather than living as opaque local state.
 *
 * # Why pinning matters (issue #2756)
 *
 * Exec mode is the most-restricted scope: an AI agent dispatched via
 * `/exec <taskId>` runs with a short-lived execution-scoped API token and
 * is supposed to be able to read freely but only write to a small set of
 * "safe collaboration" surfaces — comments, suggestions, drift resolution
 * (limited to `rebind` of its own task), execution lifecycle. The only
 * task-record write that exec scope is permitted to perform is
 * `plansync_task_rebind`; every other task write (`_create`, `_update`,
 * `_claim`, `_decline`) is owner-/agent-mode-only and must NOT be reachable
 * via an exec-scoped MCP session.
 *
 * FSM-based gating in `exec-state-manager.ts` enforces this when
 * `PLANSYNC_EXEC_STATE_ENFORCE` is set to a non-`off` mode AND
 * `PLANSYNC_SECRET` is configured. In the default deploy (`enforce=off` or
 * missing secret) the FSM is bypassed, so the allowlist defined here is
 * the only line of defence — anything in `EXEC_ALLOWED` is reachable.
 * That is exactly why the future unified `plansync_task(action, ...)`
 * surface (R-205, PR #2755) cannot be added to `EXEC_ALLOWED` wholesale:
 * doing so would expose `update` / `claim` / `decline` actions to exec
 * scope in deployments without the FSM, regressing the per-tool boundary.
 *
 * The matching pin test lives at
 * `tests/r2756-exec-task-write-pin.test.ts`.
 */

/**
 * Execution-mode whitelist — tools allowed during task execution
 * (`/exec <taskId>` sessions). Tools NOT in this set are not registered
 * at all when the server boots in exec mode (`PLANSYNC_EXEC_TASK_ID` set),
 * so they are invisible to the AI.
 */
export const EXEC_ALLOWED: ReadonlySet<string> = new Set([
  // Read-only queries
  'plansync_task_list',
  'plansync_task_show',
  'plansync_task_pack',
  'plansync_plan_list',
  'plansync_plan_show',
  'plansync_plan_active',
  'plansync_plan_diff',
  'plansync_status',
  'plansync_who',
  'plansync_activity_list',
  'plansync_my_work',
  'plansync_drift_list',
  'plansync_member_list',
  'plansync_project_list',
  'plansync_project_show',
  'plansync_suggestion_list',
  'plansync_comment_list',
  'plansync_exec_context',
  'plansync_check_task_conflicts',
  // R-155: deliverable read-only views — exec-mode agents need to inspect
  // the structured deliverable rows when reasoning about which file
  // changes belong to their bound task. Writes stay owner-only via
  // `requireNotExecScoped` on the API side.
  'plansync_deliverable_list',
  'plansync_deliverable_show',
  // Execution lifecycle
  // R-204: `plansync_run(action, ...)` is the new unified surface; the
  // three `plansync_execution_*` names stay registered as deprecated
  // aliases for one release.
  'plansync_run',
  'plansync_execution_start',
  'plansync_execution_heartbeat',
  'plansync_execution_complete',
  // Collaboration (safe writes)
  'plansync_comment_create',
  'plansync_comment_edit',
  'plansync_comment_delete',
  'plansync_plan_suggest',
  'plansync_drift_resolve',
  // Task writes:
  //   ONLY `plansync_task_rebind` is exec-mode-safe.
  //   Do NOT add `plansync_task_create / _update / _claim / _decline`
  //   here, and do NOT add the unified R-205 `plansync_task` surface
  //   without first adding a per-action exec-mode gate that rejects
  //   `action ∈ {create, update, claim, decline}` at the wrapper layer.
  //   The matching pin test is `tests/r2756-exec-task-write-pin.test.ts`.
  'plansync_task_rebind',
]);

/**
 * Delegation-mode whitelist — tools allowed when "working as <agent>"
 * (via `plansync_my_work`). Strictly a superset of `EXEC_ALLOWED` for the
 * task-write surface: an agent operating in delegation mode legitimately
 * needs `claim` / `decline` / `update` on its own task records, whereas
 * exec mode does not.
 */
export const DELEGATION_ALLOWED: ReadonlySet<string> = new Set([
  // All read-only (same as exec)
  'plansync_task_list',
  'plansync_task_show',
  'plansync_task_pack',
  'plansync_plan_list',
  'plansync_plan_show',
  'plansync_plan_active',
  'plansync_plan_diff',
  'plansync_status',
  'plansync_who',
  'plansync_activity_list',
  'plansync_my_work',
  'plansync_drift_list',
  'plansync_member_list',
  'plansync_project_list',
  'plansync_project_show',
  'plansync_suggestion_list',
  'plansync_comment_list',
  'plansync_exec_context',
  'plansync_check_task_conflicts',
  // R-155: deliverable reads available in delegation mode too. Writes
  // are owner-only and would fail at the API layer regardless, but
  // reads are useful when an agent reviews a plan and wants to see
  // structured deliverables instead of the legacy String[] mirror.
  'plansync_deliverable_list',
  'plansync_deliverable_show',
  // Execution lifecycle
  // R-204: unified `plansync_run` surface + deprecated aliases.
  'plansync_run',
  'plansync_execution_start',
  'plansync_execution_heartbeat',
  'plansync_execution_complete',
  // Collaboration
  'plansync_comment_create',
  'plansync_comment_edit',
  'plansync_comment_delete',
  'plansync_plan_suggest',
  'plansync_drift_resolve',
  'plansync_task_rebind',
  // R-205: unified `plansync_task(action, ...)` surface. Delegation agents
  // legitimately need claim / decline / update; create stays owner-only.
  'plansync_task',
  // Agent task operations (claim, decline, update own task)
  'plansync_task_claim',
  'plansync_task_decline',
  'plansync_task_update',
  // Plan review (agent's core delegation action)
  'plansync_review_approve',
  'plansync_review_reject',
  // Exit delegation
  'plansync_delegation_clear',
]);
