import * as core from '@actions/core';

type DriftRow = {
  id: string;
  taskId: string;
  severity: string;
  taskBoundVersion: number;
  currentPlanVersion: number;
  reason?: string;
  task?: { title?: string };
};

type DriftsResponse = { data?: DriftRow[] };

type TaskRow = {
  id: string;
  branchName?: string | null;
};

type TasksResponse = { data?: TaskRow[] };

function parseTaskIds(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Scoping safety cap. If a project legitimately holds more than this many
// tasks the operator should ask plansync to expose a server-side branchName
// filter; silently truncating could miss in-scope HIGH drifts and let a
// broken PR through the gate.
const TASK_PAGE_CAP = 50;
const TASK_PAGE_SIZE = 100;

async function fetchTaskIdsForBranch(
  apiUrl: string,
  projectId: string,
  headers: Record<string, string>,
  branchName: string,
): Promise<{ matched: string[]; truncated: boolean }> {
  const matched: string[] = [];
  let page = 1;
  // The task list endpoint does not expose a branchName filter, so paginate
  // and match client-side. Cap iterations to avoid runaway loops on a
  // misbehaving server; `truncated` lets the caller fail the gate rather
  // than silently use an incomplete scope.
  for (let i = 0; i < TASK_PAGE_CAP; i += 1) {
    const url = `${apiUrl}/api/projects/${projectId}/tasks?page=${page}&pageSize=${TASK_PAGE_SIZE}`;
    const res = await fetch(url, { headers });
    const json = (await res.json()) as TasksResponse & { error?: { message?: string } };
    if (!res.ok) {
      throw new Error(json?.error?.message || `HTTP ${res.status} ${res.statusText}`);
    }
    const tasks = json.data ?? [];
    for (const task of tasks) {
      if (task.branchName && task.branchName === branchName) {
        matched.push(task.id);
      }
    }
    if (tasks.length < TASK_PAGE_SIZE) {
      return { matched, truncated: false };
    }
    page += 1;
  }
  return { matched, truncated: true };
}

async function fetchOpenDrifts(
  apiUrl: string,
  projectId: string,
  headers: Record<string, string>,
): Promise<{ rows: DriftRow[]; truncated: boolean }> {
  // Mirror the task pagination strategy: drift gates that silently miss a
  // HIGH drift on page 2 are exactly the failure mode #146 reports.
  const DRIFT_PAGE_CAP = 50;
  const DRIFT_PAGE_SIZE = 100;
  const rows: DriftRow[] = [];
  let page = 1;
  for (let i = 0; i < DRIFT_PAGE_CAP; i += 1) {
    const url = `${apiUrl}/api/projects/${projectId}/drifts?status=open&page=${page}&pageSize=${DRIFT_PAGE_SIZE}`;
    const res = await fetch(url, { headers });
    const json = (await res.json()) as DriftsResponse & { error?: { message?: string } };
    if (!res.ok) {
      throw new Error(json?.error?.message || `HTTP ${res.status} ${res.statusText}`);
    }
    const data = json.data ?? [];
    rows.push(...data);
    if (data.length < DRIFT_PAGE_SIZE) {
      return { rows, truncated: false };
    }
    page += 1;
  }
  return { rows, truncated: true };
}

export async function run() {
  try {
    const apiUrl = core.getInput('api-url').replace(/\/$/, '');
    const apiKey = core.getInput('api-key');
    const projectId = core.getInput('project');
    const taskIdsInput = core.getInput('task-ids');
    const branchNameInput = core.getInput('branch-name');

    // Mask the api-key so it never appears in GitHub Actions logs even when
    // accidentally echoed (e.g. via `set -x`, child process stderr, or a
    // contributor adding `core.debug(headers)` later). `setSecret` is a no-op
    // when the value is empty, so it is safe to call unconditionally.
    if (apiKey) {
      core.setSecret(apiKey);
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };

    // R-094: scope the drift gate to the tasks affected by *this* PR rather
    // than the entire project. Otherwise an unrelated open drift would block
    // every PR in the project. Inputs are checked in priority order:
    //   1. `task-ids` — explicit comma-separated taskIds (most precise)
    //   2. `branch-name` — fetch tasks whose `branchName` matches
    //   3. neither — fall back to project-wide behavior and warn (preserves
    //      backwards compatibility with existing workflows that have not yet
    //      adopted scoping).
    let scopedTaskIds: Set<string> | null = null;
    const explicitTaskIds = parseTaskIds(taskIdsInput);
    // Whitespace-only `branch-name` (e.g. `${{ github.head_ref }}` against a
    // tag push) was previously truthy → entered scoped mode → matched 0 tasks
    // → silently filtered out every drift, including HIGH ones, and never
    // called setFailed. Treat empty/whitespace input as "no branch provided".
    const branchName = branchNameInput.trim();
    if (explicitTaskIds.length > 0) {
      scopedTaskIds = new Set(explicitTaskIds);
      core.info(`Scoping drift check to ${explicitTaskIds.length} explicit task id(s).`);
    } else if (branchName) {
      const { matched, truncated } = await fetchTaskIdsForBranch(
        apiUrl,
        projectId,
        headers,
        branchName,
      );
      if (truncated) {
        core.setFailed(
          `PlanSync drift-check refused to run: scanning more than ${TASK_PAGE_CAP * TASK_PAGE_SIZE} tasks for branch "${branchName}" — scope would be incomplete and could miss in-scope HIGH drifts. Pass \`task-ids\` explicitly or ask the API to expose a server-side branchName filter.`,
        );
        return;
      }
      if (matched.length === 0) {
        // The caller explicitly asked us to scope to a branch; finding 0 tasks
        // is almost always a mis-configured workflow (wrong branch ref, stale
        // task records, etc.) rather than "this PR truly has no PlanSync work".
        // Fail loudly instead of pretending the gate is green.
        core.setFailed(
          `PlanSync drift-check: no tasks found with branchName="${branchName}". Refusing to silently pass — verify the branch-name input or pass \`task-ids\` explicitly.`,
        );
        return;
      }
      scopedTaskIds = new Set(matched);
      core.info(
        `Scoping drift check to ${matched.length} task(s) on branch "${branchName}".`,
      );
    } else {
      core.warning(
        'PlanSync drift-check is running in project-wide mode: any open drift in the project will gate this PR. Pass `task-ids` or `branch-name` to scope the check to this PR.',
      );
    }

    let allDrifts: DriftRow[];
    try {
      const result = await fetchOpenDrifts(apiUrl, projectId, headers);
      if (result.truncated) {
        core.setFailed(
          'PlanSync drift-check: open drift list exceeds pagination cap; refusing to gate on a partial view (HIGH drifts could be on later pages). Triage backlog or raise the cap.',
        );
        return;
      }
      allDrifts = result.rows;
    } catch (err) {
      core.setFailed(err instanceof Error ? err.message : String(err));
      return;
    }

    const drifts =
      scopedTaskIds === null ? allDrifts : allDrifts.filter((d) => scopedTaskIds!.has(d.taskId));

    if (scopedTaskIds !== null) {
      const filteredOut = allDrifts.length - drifts.length;
      if (filteredOut > 0) {
        core.info(`Ignored ${filteredOut} open drift(s) outside this PR's task scope.`);
      }
    }

    if (drifts.length === 0) {
      core.info('No open drift alerts');
      core.setOutput('drift-count', '0');
      core.setOutput('has-drift', 'false');
      return;
    }

    core.warning(`Found ${drifts.length} open drift alert(s)`);
    for (const drift of drifts) {
      const title = drift.task?.title ? ` "${drift.task.title}"` : '';
      const msg = `Drift${title}: task ${drift.taskId} bound to plan v${drift.taskBoundVersion} (active is v${drift.currentPlanVersion}) — severity: ${drift.severity}`;
      if (drift.severity === 'high') {
        core.error(msg);
      } else {
        core.warning(msg);
      }
    }

    core.setOutput('drift-count', String(drifts.length));
    core.setOutput('has-drift', 'true');

    const hasHigh = drifts.some((d) => d.severity === 'high');
    if (hasHigh) {
      core.setFailed('High severity drift detected');
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
  }
}

// When this module is the GitHub Action entrypoint, kick off `run()`
// immediately. During unit tests we import `run` directly and drive it from
// the test runner, so we suppress auto-invocation via VITEST.
if (!process.env.VITEST) {
  void run();
}
