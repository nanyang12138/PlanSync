/**
 * Shared, side-effect-free helpers used by **both** entry points to PlanSync
 * exec mode:
 *
 *   1) `packages/cli/src/exec.ts`   — invoked by the CLI's `/exec <taskId>`
 *      slash command.
 *   2) `packages/cli/src/exec-cli.mjs` — invoked by `bin/plansync --exec <id>`
 *      (the shell entry point).
 *
 * Pre-R-062 these two paths diverged: the shell entry only fetched the task
 * pack, then asked the spawned LLM to call `plansync_execution_start` itself.
 * The CLI path, by contrast, validated the assignee (R-060), pre-registered
 * the execution run, issued an exec-scoped API key, and built a prompt that
 * **forbids** the LLM from calling `plansync_execution_start`. Behaviour
 * therefore differed by entry point. R-062 unifies them by routing both
 * through this module + the orchestrator in `exec-cli.mjs`.
 *
 * Everything in this file MUST stay pure / dependency-free so it can be
 * imported from a `.mjs` shell-side script without pulling in `cfg`, Ink, or
 * other heavy CLI runtime state.
 */

/**
 * Resolve whether `/exec` may be invoked on a given task and, if so, which
 * executor identity (executorType + executorName) to register the run as.
 *
 * Allowed cases (R-060):
 *   - task is assigned to an agent member  → executorType='agent',
 *     executorName=assignee
 *   - task is assigned to a human AND that human is the current CLI user
 *                                          → executorType='human',
 *                                            executorName=currentUser
 *
 * Anything else (unassigned, human-assigned to someone else, unknown type)
 * is rejected with a user-visible reason. Pure (no I/O).
 *
 * @param {{ assignee?: string | null, assigneeType?: string | null }} task
 * @param {string} currentUser
 * @returns {{ ok: true, executorType: 'agent'|'human', executorName: string }
 *            | { ok: false, reason: string }}
 */
export function resolveExecAssignee(task, currentUser) {
  const assignee = task && task.assignee != null ? task.assignee : null;
  const assigneeType = task && task.assigneeType != null ? task.assigneeType : null;

  if (!assignee) {
    return {
      ok: false,
      reason: `/exec requires the task to have an assignee. Current assignee: none (${assigneeType ?? 'unassigned'}).`,
    };
  }

  if (assigneeType === 'agent') {
    return { ok: true, executorType: 'agent', executorName: assignee };
  }

  if (assigneeType === 'human') {
    if (assignee === currentUser) {
      return { ok: true, executorType: 'human', executorName: assignee };
    }
    return {
      ok: false,
      reason: `/exec on a human-assigned task requires you to be the assignee. Task is assigned to "${assignee}" but you are signed in as "${currentUser}".`,
    };
  }

  return {
    ok: false,
    reason: `/exec requires the task to be assigned to an agent member or a human matching the current user. Current assignee: ${assignee} (${assigneeType ?? 'unassigned'}).`,
  };
}

/**
 * Unwrap the `{ data: ... }` envelope that every PlanSync REST route
 * applies to its successful responses. Closes #725 / #735 / #737 / #739
 * — the `/api/projects/:projectId/tasks/:taskId/pack` route does
 * `return NextResponse.json({ data: taskPack })`, but both `/exec`
 * entry points (CLI `/exec` slash command and `bin/plansync --exec`)
 * used the response object directly. The wrapper has no `.task`,
 * `.driftAlerts`, etc., so:
 *
 *   - `openDriftAlerts(response).length === 0` was always true →
 *     drift gate silently failed even on a high-severity drift.
 *   - `response.task.assignee` was undefined → assignee gating ran
 *     against an empty record and rejected every legitimate task.
 *   - `buildExecPrompt({ taskPack: response, … })` dumped the
 *     wrapper as JSON, so the LLM saw `{"data":{…}}` instead of the
 *     actual pack.
 *
 * Be defensive about both shapes: a future API contract that drops
 * the envelope, or a test fixture that hand-rolls a bare pack, must
 * still work. We treat anything with a `data` field that is itself
 * an object as wrapped, otherwise we pass the input through.
 *
 * @param {unknown} response
 * @returns {unknown}
 */
export function unwrapTaskPack(response) {
  if (!response || typeof response !== 'object') return response;
  const wrapper = /** @type {{data?: unknown}} */ (response);
  if (
    'data' in wrapper &&
    wrapper.data !== null &&
    wrapper.data !== undefined &&
    typeof wrapper.data === 'object'
  ) {
    return wrapper.data;
  }
  return response;
}

/**
 * Return the open drift alerts of a task pack.
 *
 * Accepts EITHER the bare pack OR the `{ data: pack }` envelope and
 * unwraps internally so callers don't have to remember which shape
 * they're holding (closes #725 — the drift gate was silently
 * empty in both `/exec` entry points because the envelope wasn't
 * unwrapped).
 *
 * @param {unknown} taskPackOrEnvelope
 * @returns {Array<{ status?: string, reason?: string }>}
 */
export function openDriftAlerts(taskPackOrEnvelope) {
  const taskPack = unwrapTaskPack(taskPackOrEnvelope);
  if (!taskPack || typeof taskPack !== 'object') return [];
  const alerts = /** @type {{driftAlerts?: unknown}} */ (taskPack).driftAlerts;
  if (!Array.isArray(alerts)) return [];
  return alerts.filter(
    (a) => a && typeof a === 'object' && /** @type {{status?:string}}*/ (a).status === 'open',
  );
}

/**
 * Construct the prompt sent to the spawned coding engine for `/exec`. The
 * prompt is the *contract* between the PlanSync run already pre-registered by
 * the orchestrator and the LLM: it tells the LLM the run already exists
 * (no `plansync_execution_start`), what to do, and what is forbidden.
 *
 * Kept here so the shell `--exec` and CLI `/exec` produce identical prompts.
 *
 * @param {{ taskId: string, taskPack: unknown }} opts
 * @returns {string}
 */
export function buildExecPrompt({ taskId, taskPack }) {
  // Closes #725 / #735 / #737 / #739 — accept either the bare pack
  // or the API envelope. Pre-fix the LLM saw `{"data":{…}}` because
  // callers passed the wrapper through verbatim, which made drift /
  // deliverable references one level too deep for the prompt.
  const unwrapped = unwrapTaskPack(taskPack);
  return [
    `You are about to execute PlanSync task ${taskId}.`,
    '',
    'This session is launched in PlanSync exec mode. The execution run has ALREADY',
    'been registered for you (runId in env PLANSYNC_EXEC_RUN_ID). Call',
    'plansync_exec_context FIRST to retrieve runId and full task context.',
    '',
    'Do NOT call plansync_execution_start — only one running execution is allowed',
    'per task and yours is already active.',
    '',
    'CRITICAL: DO NOT call EnterPlanMode. DO NOT ask questions. DO NOT wait for approval.',
    'In exactly 1 sentence state the first file you will write, then IMMEDIATELY call Write to create it.',
    'After implementation: call plansync_run with',
    'action="complete" and the runId from plansync_exec_context.',
    '(The legacy alias plansync_execution_complete is deprecated and will be removed —',
    ' always use plansync_run({action:"complete", ...}) so this prompt keeps working.)',
    '',
    'FORBIDDEN: Do NOT call plansync_plan_create, plansync_plan_propose, plansync_plan_activate, or plansync_plan_reactivate.',
    'A plan already exists. You are here to EXECUTE a task within the existing plan, not to create a new one.',
    '',
    'Task Pack:',
    JSON.stringify(unwrapped, null, 2),
  ].join('\n');
}

/**
 * Compute the env block that the spawned MCP server child process needs in
 * order to recognise this session as a PlanSync exec session. Both entries
 * points feed this exact object into either an `--mcp-config` JSON blob
 * (claude-code) or a `codex mcp add` call.
 *
 * @param {{
 *   runId: string,
 *   taskId: string,
 *   projectId: string,
 *   sessionId: string,
 *   apiUrl?: string,
 *   apiKey?: string,
 *   user?: string,
 *   secret?: string,
 * }} opts
 * @returns {Record<string, string>}
 */
export function buildExecMcpEnv(opts) {
  return {
    PLANSYNC_API_URL: opts.apiUrl ?? 'http://localhost:3001',
    PLANSYNC_API_KEY: opts.apiKey ?? '',
    PLANSYNC_USER: opts.user ?? '',
    PLANSYNC_SECRET: opts.secret ?? '',
    PLANSYNC_PROJECT: opts.projectId,
    PLANSYNC_EXEC_RUN_ID: opts.runId,
    PLANSYNC_EXEC_TASK_ID: opts.taskId,
    PLANSYNC_EXEC_SESSION_ID: opts.sessionId,
    LOG_LEVEL: 'warn',
  };
}

/**
 * Build the JSON value that gets passed to `claude-code --mcp-config` so the
 * spawned engine talks to the right PlanSync MCP server with the right
 * exec-scoped env. Pure — does not touch `process.env` itself, callers must
 * pass the values explicitly.
 *
 * @param {{
 *   runId: string,
 *   taskId: string,
 *   projectId: string,
 *   sessionId: string,
 *   localNodeBin: string,
 *   mcpServerDist: string,
 *   apiUrl?: string,
 *   apiKey?: string,
 *   user?: string,
 *   secret?: string,
 * }} opts
 * @returns {string}
 */
export function buildExecMcpConfigJson(opts) {
  return JSON.stringify({
    mcpServers: {
      plansync: {
        command: opts.localNodeBin,
        args: [opts.mcpServerDist],
        env: buildExecMcpEnv(opts),
      },
    },
  });
}
