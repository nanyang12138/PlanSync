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

type Pagination = {
  page?: number;
  pageSize?: number;
  total?: number;
  totalPages?: number;
};

type DriftsResponse = { data?: DriftRow[]; pagination?: Pagination };

type TaskRow = {
  id: string;
  branchName?: string | null;
};

type TasksResponse = { data?: TaskRow[]; pagination?: Pagination };

// R-157: shape of `/api/projects/:projectId/plans/active` and the related
// deliverables endpoint. Only the fields the action actually consumes are
// modelled — the server may return additional keys.
type PlanRow = {
  id: string;
  version: number;
};

type DeliverableRow = {
  id: string;
  slug: string;
  refType?: string | null;
  refUri?: string | null;
  status: string;
};

type DeliverablesResponse = { data?: DeliverableRow[] };

function parseTaskIds(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// R-157: PR file lists arrive from one of two natural producers:
//   * `gh pr diff --name-only` → newline-separated
//   * `${{ steps.changed.outputs.all_changed_files }}` from
//     `tj-actions/changed-files` → space- or comma-separated
// Accept either by splitting on both newlines and commas. We deliberately
// do NOT split on whitespace beyond newlines — file names can contain
// spaces and silently truncating "my docs/foo.md" → ["my", "docs/foo.md"]
// would mask real drift.
function parsePrFiles(input: string): string[] {
  if (!input) return [];
  return input
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// R-157: convert a deliverable `refUri` glob into a RegExp.
// Supports the subset the rest of the PlanSync code already uses:
//   `**`  → match any path segments (including empty + slashes)
//   `*`   → match within a single segment (no slashes)
//   `?`   → match a single non-slash character
//   `{a,b,c}` → alternation
// Anything else is treated as a literal. This intentionally avoids pulling
// in the full minimatch package (~80 KB of bundled JS) for what is a
// short list of globs on every PR.
function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      // `**` — drop a trailing `/` if present so `src/**/*.ts` matches
      // `src/foo.ts` as well as `src/a/b/foo.ts` (standard minimatch
      // behaviour).
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 3;
      } else {
        re += '.*';
        i += 2;
      }
      continue;
    }
    if (c === '*') {
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
        i += 1;
        continue;
      }
      const alternatives = glob
        .slice(i + 1, end)
        .split(',')
        .map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&'));
      re += `(?:${alternatives.join('|')})`;
      i = end + 1;
      continue;
    }
    // Escape regex metacharacters; leave `/` as-is.
    if ('.+^$()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

function matchesAnyGlob(file: string, globs: readonly RegExp[]): boolean {
  for (const re of globs) {
    if (re.test(file)) return true;
  }
  return false;
}

// Scoping safety cap. If a project legitimately holds more than this many
// tasks the operator should ask plansync to expose a server-side branchName
// filter; silently truncating could miss in-scope HIGH drifts and let a
// broken PR through the gate.
const TASK_PAGE_CAP = 50;
const TASK_PAGE_SIZE = 100;

/**
 * Returns true when the just-fetched `page` is the last available page,
 * even when the response was exactly full. The previous heuristic
 * (`data.length < pageSize`) had a foot-gun: if the project happened to
 * hold exactly N×pageSize rows, every page came back full and the loop
 * had to walk through `*_PAGE_CAP` iterations before reporting a false
 * truncation.
 *
 * We prefer the server-reported `pagination.totalPages` when available
 * (every PlanSync paginated route emits it); the partial-page heuristic
 * is the legacy-server fallback.
 */
function isLastPage(
  pagination: Pagination | undefined,
  pageSize: number,
  page: number,
  receivedRows: number,
): boolean {
  const totalPages = pagination?.totalPages;
  if (typeof totalPages === 'number' && totalPages >= 0) {
    return page >= totalPages;
  }
  return receivedRows < pageSize;
}

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
    if (isLastPage(json.pagination, TASK_PAGE_SIZE, page, tasks.length)) {
      return { matched, truncated: false };
    }
    page += 1;
  }
  return { matched, truncated: true };
}

const DRIFT_PAGE_CAP = 50;
const DRIFT_PAGE_SIZE = 100;

async function fetchOpenDrifts(
  apiUrl: string,
  projectId: string,
  headers: Record<string, string>,
): Promise<{ rows: DriftRow[]; truncated: boolean }> {
  // Mirror the task pagination strategy: drift gates that silently miss a
  // HIGH drift on page 2 are exactly the failure mode #146 reports.
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
    if (isLastPage(json.pagination, DRIFT_PAGE_SIZE, page, data.length)) {
      return { rows, truncated: false };
    }
    page += 1;
  }
  return { rows, truncated: true };
}

// R-157: fetch the active plan's `file_glob` deliverable refUris.
// Returns `null` when no active plan exists (404 on /plans/active) so the
// caller can treat "no plan" the same as "no globs configured" and skip
// the semantic gate gracefully.
async function fetchActivePlanFileGlobs(
  apiUrl: string,
  projectId: string,
  headers: Record<string, string>,
): Promise<{ planId: string; planVersion: number; globs: string[] } | null> {
  const planUrl = `${apiUrl}/api/projects/${projectId}/plans/active`;
  const planRes = await fetch(planUrl, { headers });
  if (planRes.status === 404) return null;
  const planJson = (await planRes.json()) as
    | { data?: PlanRow; error?: { message?: string } }
    | undefined;
  if (!planRes.ok) {
    throw new Error(planJson?.error?.message || `HTTP ${planRes.status} ${planRes.statusText}`);
  }
  const plan = planJson?.data;
  if (!plan?.id) return null;

  const delUrl = `${apiUrl}/api/projects/${projectId}/plans/${plan.id}/deliverables`;
  const delRes = await fetch(delUrl, { headers });
  const delJson = (await delRes.json()) as DeliverablesResponse & { error?: { message?: string } };
  if (!delRes.ok) {
    throw new Error(delJson?.error?.message || `HTTP ${delRes.status} ${delRes.statusText}`);
  }
  const rows = delJson.data ?? [];
  const globs = rows
    .filter((r) => r.refType === 'file_glob' && r.status === 'active' && !!r.refUri)
    .map((r) => r.refUri as string);
  return { planId: plan.id, planVersion: plan.version, globs };
}

export async function run() {
  try {
    const apiUrl = core.getInput('api-url').replace(/\/$/, '');
    const apiKey = core.getInput('api-key');
    const projectId = core.getInput('project');
    const taskIdsInput = core.getInput('task-ids');
    const branchNameInput = core.getInput('branch-name');
    const prFilesInput = core.getInput('pr-files');
    // `legacy-mode` is an emergency rollback for R-157. We accept the
    // canonical lowercase `true` plus a couple of common typos so a
    // sleep-deprived operator does not have to remember exact casing.
    const legacyModeRaw = core.getInput('legacy-mode').trim().toLowerCase();
    const legacyMode = legacyModeRaw === 'true' || legacyModeRaw === '1' || legacyModeRaw === 'yes';

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

    // R-157: semantic deliverable gate. Runs before the drift check so a
    // PR that does not touch any active deliverable fails fast with a
    // clear message instead of "no drift, looks good" which is misleading.
    //
    // Backwards-compatibility ladder (top wins):
    //   * `legacy-mode: true`                          → skip semantic gate.
    //   * `pr-files` empty                             → skip semantic gate
    //                                                     (workflows not yet
    //                                                     wired up still pass
    //                                                     the legacy drift
    //                                                     check).
    //   * `/plans/active` returns 404 / no plan        → skip semantic gate.
    //   * Active plan has zero `file_glob` deliverables → skip semantic gate
    //                                                     (project has not
    //                                                     adopted the schema
    //                                                     yet — fail-open).
    //   * Otherwise enforce: every PR file must match
    //     at least one active glob.
    const prFiles = parsePrFiles(prFilesInput);
    let semanticGate: 'skipped' | 'passed' | 'failed' = 'skipped';
    if (legacyMode) {
      core.info('PlanSync semantic gate disabled (legacy-mode=true). Running drift-only check.');
    } else if (prFiles.length === 0) {
      core.info(
        'PlanSync semantic gate skipped: no `pr-files` input provided. Pass the list of PR-changed files to enable the R-157 deliverable check.',
      );
    } else {
      let activePlan: Awaited<ReturnType<typeof fetchActivePlanFileGlobs>>;
      try {
        activePlan = await fetchActivePlanFileGlobs(apiUrl, projectId, headers);
      } catch (err) {
        core.setFailed(
          `PlanSync semantic gate: failed to load active plan deliverables — ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      if (!activePlan) {
        core.info(
          'PlanSync semantic gate skipped: no active plan for this project. Activate a plan to enable the R-157 deliverable check.',
        );
      } else if (activePlan.globs.length === 0) {
        core.info(
          `PlanSync semantic gate skipped: active plan v${activePlan.planVersion} has no \`file_glob\` deliverables. Add file_glob deliverables to enable the R-157 check.`,
        );
      } else {
        const compiled = activePlan.globs.map(globToRegExp);
        const unmatched = prFiles.filter((f) => !matchesAnyGlob(f, compiled));
        if (unmatched.length > 0) {
          semanticGate = 'failed';
          core.setOutput('semantic-gate', semanticGate);
          core.setOutput('unmatched-files', unmatched.join('\n'));
          core.error(
            `PlanSync semantic gate: ${unmatched.length} file(s) modified by this PR do not match any active deliverable glob on plan v${activePlan.planVersion}.`,
          );
          for (const f of unmatched) {
            core.error(`  Unmatched file: ${f}`);
          }
          core.error(
            `Active deliverable globs: ${activePlan.globs.map((g) => `\`${g}\``).join(', ')}`,
          );
          core.setFailed(
            `Modified files are not in scope of any active deliverable (${unmatched.length} unmatched). Either add a deliverable that covers these files (see plansync_deliverable_create) or scope the PR to in-plan changes. Override with \`legacy-mode: true\` only as an emergency rollback.`,
          );
          // R-157: short-circuit the rest of the gate. Falling through to
          // the drift check would let a PR that touches out-of-scope files
          // produce a confusing "drift-count: 0 → green" output alongside
          // the setFailed, which is the exact ambiguity that motivated the
          // upgrade. Bail out cleanly with `has-drift=false` so downstream
          // job summaries do not double-report.
          core.setOutput('drift-count', '0');
          core.setOutput('has-drift', 'false');
          return;
        }
        semanticGate = 'passed';
        core.info(
          `PlanSync semantic gate passed: all ${prFiles.length} PR file(s) match at least one of ${compiled.length} active deliverable glob(s) on plan v${activePlan.planVersion}.`,
        );
      }
    }
    core.setOutput('semantic-gate', semanticGate);

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
      core.info(`Scoping drift check to ${matched.length} task(s) on branch "${branchName}".`);
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
