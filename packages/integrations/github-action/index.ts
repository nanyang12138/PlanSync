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
  // R-207 / L3: needed for the strict-sourcing version-binding check.
  boundPlanVersion?: number;
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

// R-193: marker tags for the PlanSync block injected into the PR body.
// Use HTML comments so they render as zero-width on GitHub and double as
// idempotency anchors for the "update in place" logic below.
const PLANSYNC_BLOCK_START = '<!-- plansync-status -->';
const PLANSYNC_BLOCK_END = '<!-- /plansync-status -->';

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PLANSYNC_BLOCK_RE = new RegExp(
  `${escapeForRegExp(PLANSYNC_BLOCK_START)}[\\s\\S]*?${escapeForRegExp(PLANSYNC_BLOCK_END)}`,
);

// R-193: input shape for `renderPlansyncStatusBlock`. Only fields the action
// already collects in `run()`; future additions (e.g. deliverable evidence
// from R-191) plug in here without a wire-protocol change.
export interface PlansyncStatusInput {
  projectId: string;
  planVersion: number | null;
  drifts: ReadonlyArray<{ id: string; severity: string; taskId: string; reason?: string }>;
  semanticGate: 'skipped' | 'passed' | 'failed';
  deliverableGlobs: readonly string[];
  unmatchedFiles: readonly string[];
  scopedTaskIds: readonly string[] | null;
  truncatedTaskScan: boolean;
  truncatedDriftScan: boolean;
  // R-193 (#2768): tri-state lifecycle for the drift query so the rendered
  // block can distinguish "we asked the API and got nothing" from "we never
  // got to ask". Without this, every early-return path before the drift
  // fetch (semantic-gate failure, task-scope truncation, deliverable-fetch
  // error, …) would still render the default empty `drifts` array as
  // "no open alerts in scope" — a false-positive that misleads reviewers
  // into thinking drift was checked.
  //   'not_run'   — drift query was not attempted (gate aborted earlier).
  //   'failed'    — drift query started but did not produce an authoritative
  //                  result (pagination cap hit, network error, …). The
  //                  `drifts` array may be empty or partial; do not trust it.
  //   'completed' — drift query finished and `drifts` is authoritative.
  driftScanStatus: 'not_run' | 'failed' | 'completed';
}

/**
 * R-193: render the `<!-- plansync-status -->` block content (including its
 * delimiter tags). Pure formatting, so the caller can render the block in
 * isolation (tests / debugging) without touching GitHub.
 *
 * The block format is intentionally small and stable: every line is a
 * Markdown bullet so existing PR templates with their own headings keep
 * working. The delimiter tags are HTML comments so the block renders as
 * zero-width on GitHub when the bullets are stripped.
 */
export function renderPlansyncStatusBlock(input: PlansyncStatusInput): string {
  const lines: string[] = [];
  lines.push(PLANSYNC_BLOCK_START);
  lines.push('## PlanSync Status');
  lines.push('');
  if (input.planVersion != null) {
    lines.push(`- **Active plan**: v${input.planVersion}`);
  } else {
    lines.push('- **Active plan**: _none — activate a plan to enable drift gating_');
  }
  if (input.scopedTaskIds && input.scopedTaskIds.length > 0) {
    const preview = input.scopedTaskIds.slice(0, 5).join(', ');
    const more = input.scopedTaskIds.length > 5 ? ` (+${input.scopedTaskIds.length - 5} more)` : '';
    lines.push(`- **PR scope**: ${input.scopedTaskIds.length} task(s) — ${preview}${more}`);
  } else {
    lines.push('- **PR scope**: project-wide');
  }
  // R-193 (#2768): render based on the drift query lifecycle, not the array
  // contents. An empty `drifts` on the `'not_run'` / `'failed'` paths is the
  // default value, not a real signal — surfacing it as "no open alerts" would
  // be a false negative.
  if (input.driftScanStatus === 'not_run') {
    lines.push('- **Drift**: _not checked — gate aborted before drift query; see action log_');
  } else if (input.driftScanStatus === 'failed') {
    lines.push('- **Drift**: _check failed — see action log_');
  } else {
    const highCount = input.drifts.filter((d) => d.severity === 'high').length;
    const medCount = input.drifts.filter((d) => d.severity === 'medium').length;
    const lowCount = input.drifts.length - highCount - medCount;
    if (input.drifts.length === 0) {
      lines.push('- **Drift**: no open alerts in scope');
    } else {
      lines.push(
        `- **Drift**: ${input.drifts.length} open alert(s) — ${highCount} high · ${medCount} medium · ${lowCount} other`,
      );
    }
  }
  if (input.deliverableGlobs.length > 0) {
    const previewGlobs = input.deliverableGlobs
      .slice(0, 6)
      .map((g) => `\`${g}\``)
      .join(', ');
    const moreGlobs =
      input.deliverableGlobs.length > 6 ? ` (+${input.deliverableGlobs.length - 6} more)` : '';
    lines.push(`- **Deliverable globs**: ${previewGlobs}${moreGlobs}`);
  }
  const gateIcon =
    input.semanticGate === 'passed' ? '✅' : input.semanticGate === 'failed' ? '❌' : '➖';
  lines.push(`- **Deliverable gate**: ${gateIcon} ${input.semanticGate}`);
  if (input.semanticGate === 'failed' && input.unmatchedFiles.length > 0) {
    const previewFiles = input.unmatchedFiles
      .slice(0, 10)
      .map((f) => `  - \`${f}\``)
      .join('\n');
    lines.push('');
    lines.push('Files outside any active deliverable glob:');
    lines.push(previewFiles);
    if (input.unmatchedFiles.length > 10) {
      lines.push(`  - … (+${input.unmatchedFiles.length - 10} more)`);
    }
  }
  if (input.truncatedTaskScan || input.truncatedDriftScan) {
    lines.push('');
    lines.push(
      '> ⚠ PlanSync truncated its scan — the figures above are partial. See the action log.',
    );
  }
  lines.push('');
  lines.push(
    `<sub>_Updated automatically by PlanSync GitHub Action — project \`${input.projectId}\`. ` +
      `Re-runs replace this block in place; do not edit between the markers._</sub>`,
  );
  lines.push(PLANSYNC_BLOCK_END);
  return lines.join('\n');
}

/**
 * R-193: replace the PlanSync block in `body` with `block`, or append it if
 * the markers are not present. Idempotent: running twice produces the same
 * body as running once, so the action can safely re-run on every PR sync
 * event without duplicating the block.
 *
 * Preserves the surrounding text verbatim, including author-written PR
 * template content above or below the block.
 */
export function injectPlansyncBlock(body: string | null | undefined, block: string): string {
  const existing = body ?? '';
  if (PLANSYNC_BLOCK_RE.test(existing)) {
    return existing.replace(PLANSYNC_BLOCK_RE, block);
  }
  if (existing.length === 0) return block;
  const sep = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${sep}${block}`;
}

interface PrBodyUpdateOptions {
  repo: string;
  prNumber: number;
  token: string;
  fetchImpl?: typeof fetch;
}

/**
 * R-193: GET the PR body, inject/replace the PlanSync block, and PATCH back
 * if (and only if) the body would change. Returns the outcome so the
 * caller can wire it into the action's `pr-body-updated` output and the
 * job log.
 *
 * Network errors are non-fatal — the drift / semantic gate has already
 * completed by the time we get here; failing to update the PR body is a
 * cosmetic regression, not a correctness one, and we never want to mask
 * a green gate with a red one because the GitHub API was momentarily
 * unavailable.
 */
export async function syncPrBody(
  status: PlansyncStatusInput,
  opts: PrBodyUpdateOptions,
): Promise<{ updated: boolean; reason: string }> {
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  const url = `https://api.github.com/repos/${opts.repo}/pulls/${opts.prNumber}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'plansync-github-action',
  };
  const getRes = await fetchFn(url, { headers });
  if (!getRes.ok) {
    const text = await getRes.text().catch(() => '');
    throw new Error(
      `GitHub API GET ${url} returned ${getRes.status} ${getRes.statusText}: ${text.slice(0, 200)}`,
    );
  }
  const prJson = (await getRes.json()) as { body?: string | null };
  const block = renderPlansyncStatusBlock(status);
  const nextBody = injectPlansyncBlock(prJson.body ?? '', block);
  if (nextBody === (prJson.body ?? '')) {
    return { updated: false, reason: 'no-op (block already up to date)' };
  }
  const patchRes = await fetchFn(url, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: nextBody }),
  });
  if (!patchRes.ok) {
    const text = await patchRes.text().catch(() => '');
    throw new Error(
      `GitHub API PATCH ${url} returned ${patchRes.status} ${patchRes.statusText}: ${text.slice(0, 200)}`,
    );
  }
  return { updated: true, reason: 'wrote new block' };
}

function parseTaskIds(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// R-157: PR file lists arrive from one of two natural producers:
//   * `gh pr diff --name-only` → newline-separated
//   * `${{ steps.changed.outputs.all_changed_files }}` from
//     `tj-actions/changed-files` → space-separated by default,
//     or comma-separated when the workflow sets `separator: ','`.
//
// Splitting strategy preserves filenames containing spaces whenever a
// structured delimiter is available, while still handling the default
// space-separated `tj-actions/changed-files` output:
//
//   * If the input contains any `\n` or `,`, split on those delimiters
//     only — filenames with spaces (e.g. "my docs/foo.md") are kept
//     intact, matching the input contract documented in `action.yml`.
//   * Otherwise (no commas, no newlines) the input must come from a
//     space-separated producer; fall back to splitting on any whitespace
//     so that "a.ts b.ts" → ["a.ts", "b.ts"] instead of being treated as
//     a single nonexistent path that would trip the semantic gate
//     (issue #1266). The narrow edge case — a single bare filename that
//     itself contains a space, with no other delimiter — is unsupported
//     in this branch; users with such paths should pass them via newline
//     or comma separation.
function parsePrFiles(input: string): string[] {
  if (!input) return [];
  const splitter = /[\n,]/.test(input) ? /[\n,]+/ : /\s+/;
  return input
    .split(splitter)
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

async function fetchTasksForBranch(
  apiUrl: string,
  projectId: string,
  headers: Record<string, string>,
  branchName: string,
): Promise<{ tasks: TaskRow[]; truncated: boolean; droppedNonMatching: number }> {
  // R-207 / L3: the API now exposes a server-side `branchName` filter, so we
  // fetch exactly this branch's task(s) instead of paginating the whole
  // project and matching client-side (which capped at TASK_PAGE_CAP pages and
  // could silently truncate on large projects — the very TODO this replaces).
  // We still loop in case a branch legitimately carries more than one page of
  // tasks, and keep the cap as a runaway guard.
  //
  // Hardening: we ALSO re-verify `branchName` client-side. The server filters,
  // but a server bug (filter ignored / wrong column) must never cause us to
  // scope the gate to a task that isn't actually on this PR's branch — we keep
  // only exact matches and surface how many rows were dropped.
  const tasks: TaskRow[] = [];
  let droppedNonMatching = 0;
  let page = 1;
  const q = encodeURIComponent(branchName);
  for (let i = 0; i < TASK_PAGE_CAP; i += 1) {
    const url = `${apiUrl}/api/projects/${projectId}/tasks?branchName=${q}&page=${page}&pageSize=${TASK_PAGE_SIZE}`;
    const res = await fetch(url, { headers });
    const json = (await res.json()) as TasksResponse & { error?: { message?: string } };
    if (!res.ok) {
      throw new Error(json?.error?.message || `HTTP ${res.status} ${res.statusText}`);
    }
    const rows = json.data ?? [];
    for (const t of rows) {
      if (t.branchName === branchName) tasks.push(t);
      else droppedNonMatching += 1;
    }
    if (isLastPage(json.pagination, TASK_PAGE_SIZE, page, rows.length)) {
      return { tasks, truncated: false, droppedNonMatching };
    }
    page += 1;
  }
  return { tasks, truncated: true, droppedNonMatching };
}

// R-207 / L3: fetch a single task by id (for the explicit `task-ids` path's
// strict-version check, where we don't already hold the task objects).
async function fetchTaskById(
  apiUrl: string,
  projectId: string,
  headers: Record<string, string>,
  taskId: string,
): Promise<TaskRow | null> {
  const url = `${apiUrl}/api/projects/${projectId}/tasks/${encodeURIComponent(taskId)}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  const json = (await res.json()) as { data?: TaskRow; error?: { message?: string } };
  if (!res.ok) {
    throw new Error(json?.error?.message || `HTTP ${res.status} ${res.statusText}`);
  }
  return json.data ?? null;
}

// R-207 / L3: active plan version only (lighter than fetchActivePlanFileGlobs,
// which also pulls deliverables). Returns null when there is no active plan.
async function fetchActivePlanVersion(
  apiUrl: string,
  projectId: string,
  headers: Record<string, string>,
): Promise<number | null> {
  const url = `${apiUrl}/api/projects/${projectId}/plans/active`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  const json = (await res.json()) as { data?: PlanRow; error?: { message?: string } };
  if (!res.ok) {
    throw new Error(json?.error?.message || `HTTP ${res.status} ${res.statusText}`);
  }
  return json.data?.version ?? null;
}

// R-207 / L3: read PR labels for the auditable exemption mechanism. Reuses the
// same GitHub REST shape as syncPrBody; `fetchImpl` is injectable for tests.
async function fetchPrLabels(opts: {
  token: string;
  repo: string;
  prNumber: number;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  const url = `https://api.github.com/repos/${opts.repo}/pulls/${opts.prNumber}`;
  const res = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${opts.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'plansync-github-action',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `GitHub API GET ${url} returned ${res.status} ${res.statusText}: ${text.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as { labels?: Array<{ name?: string }> };
  return (json.labels ?? []).map((l) => l.name).filter((n): n is string => !!n);
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

  // R-193: optional PR-body sync inputs. Each is independently optional —
  // if any is missing, we silently skip the body update (the action still
  // gates the PR). The token is masked the same way as `api-key`, even
  // though `${{ secrets.GITHUB_TOKEN }}` is already redacted by Actions —
  // belt-and-braces if a workflow ever passes a PAT instead.
  const githubToken = core.getInput('github-token');
  const repoInput = core.getInput('repo').trim();
  const prNumberInput = core.getInput('pr-number').trim();
  if (githubToken) {
    core.setSecret(githubToken);
  }

  // R-207 / L3: strict-sourcing. When true, every PR must map to a task bound
  // to the CURRENT active plan version: project-wide (unscoped) runs are
  // refused, a scope that matches zero tasks fails, and any scoped task on a
  // stale plan version fails. Default false to keep existing workflows
  // wire-compatible — opt in via the input (the shipped example sets it true).
  const strictRaw = core.getInput('strict-sourcing').trim().toLowerCase();
  const strictSourcing = strictRaw === 'true' || strictRaw === '1' || strictRaw === 'yes';
  // R-207 / L3: comma-separated labels that exempt a PR from the gate (e.g.
  // `plansync:exempt` for dependabot / the workflow file itself). Reuses the
  // comma parser. Requires the github-token/repo/pr-number trio to read labels.
  const exemptLabels = parseTaskIds(core.getInput('exempt-labels'));

  // Mask the api-key so it never appears in GitHub Actions logs even when
  // accidentally echoed (e.g. via `set -x`, child process stderr, or a
  // contributor adding `core.debug(headers)` later). `setSecret` is a no-op
  // when the value is empty, so it is safe to call unconditionally.
  if (apiKey) {
    core.setSecret(apiKey);
  }

  // R-193: status accumulator threaded through the gate logic. The
  // try/finally below renders this into the `<!-- plansync-status -->`
  // block and PATCHes it onto the PR (when the github-token / repo /
  // pr-number inputs are configured). Mutating a single struct keeps
  // the existing flow control (early returns on gate failure) intact.
  const status: PlansyncStatusInput = {
    projectId,
    planVersion: null,
    drifts: [],
    semanticGate: 'skipped',
    deliverableGlobs: [],
    unmatchedFiles: [],
    scopedTaskIds: null,
    truncatedTaskScan: false,
    truncatedDriftScan: false,
    // R-193 (#2768): default to 'not_run'. Only the success path below
    // (after `fetchOpenDrifts` returns an authoritative page set) flips
    // this to 'completed'; truncation / error paths flip it to 'failed'.
    driftScanStatus: 'not_run',
  };
  // PR-body sync runs in a `finally` so a thrown error inside the gate
  // logic still leaves the reviewer with the partial status block.
  // Default-false output keeps existing workflows wire-compatible.
  core.setOutput('pr-body-updated', 'false');

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };

    // R-207 / L3: auditable exemption. Some PRs legitimately map to no task
    // (the workflow file itself, dependabot, CI-config-only changes). A
    // maintainer applies an exempt label; the gate then skips for that PR and
    // logs it loudly. Label-gating (vs a workflow input) keeps it per-PR and
    // auditable, and applying a label needs repo write access. Fail-closed: if
    // the label set is configured but we cannot read the PR, the gate runs.
    if (exemptLabels.length > 0) {
      if (githubToken && repoInput && prNumberInput) {
        try {
          const labels = await fetchPrLabels({
            token: githubToken,
            repo: repoInput,
            prNumber: Number.parseInt(prNumberInput, 10),
          });
          const hit = labels.find((l) => exemptLabels.includes(l));
          if (hit) {
            core.warning(
              `PlanSync gate EXEMPTED via label "${hit}". Skipping drift + strict-sourcing checks for this PR.`,
            );
            core.setOutput('drift-count', '0');
            core.setOutput('has-drift', 'false');
            core.setOutput('semantic-gate', 'skipped');
            return;
          }
        } catch (err) {
          core.warning(
            `PlanSync exemption check could not read PR labels (${err instanceof Error ? err.message : String(err)}); running the gate (fail-closed).`,
          );
        }
      } else {
        core.warning(
          'PlanSync `exempt-labels` is set but `github-token`/`repo`/`pr-number` are not all provided; exemption is unavailable and the gate will run (fail-closed).',
        );
      }
    }

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
        // R-193: still publish the plan version into the status block so the
        // reviewer can see we found an active plan even though the deliverable
        // gate is fail-open.
        status.planVersion = activePlan.planVersion;
        core.info(
          `PlanSync semantic gate skipped: active plan v${activePlan.planVersion} has no \`file_glob\` deliverables. Add file_glob deliverables to enable the R-157 check.`,
        );
      } else {
        status.planVersion = activePlan.planVersion;
        status.deliverableGlobs = activePlan.globs;
        const compiled = activePlan.globs.map(globToRegExp);
        const unmatched = prFiles.filter((f) => !matchesAnyGlob(f, compiled));
        if (unmatched.length > 0) {
          semanticGate = 'failed';
          status.semanticGate = semanticGate;
          status.unmatchedFiles = unmatched;
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
        status.semanticGate = semanticGate;
        core.info(
          `PlanSync semantic gate passed: all ${prFiles.length} PR file(s) match at least one of ${compiled.length} active deliverable glob(s) on plan v${activePlan.planVersion}.`,
        );
      }
    }
    core.setOutput('semantic-gate', semanticGate);
    status.semanticGate = semanticGate;

    // R-094: scope the drift gate to the tasks affected by *this* PR rather
    // than the entire project. Otherwise an unrelated open drift would block
    // every PR in the project. Inputs are checked in priority order:
    //   1. `task-ids` — explicit comma-separated taskIds (most precise)
    //   2. `branch-name` — fetch tasks whose `branchName` matches
    //   3. neither — fall back to project-wide behavior and warn (preserves
    //      backwards compatibility with existing workflows that have not yet
    //      adopted scoping).
    let scopedTaskIds: Set<string> | null = null;
    // R-207 / L3: when we already hold the scoped task objects (branch path),
    // keep them so the strict-version check below doesn't refetch.
    let scopedTaskObjects: TaskRow[] | null = null;
    const explicitTaskIds = parseTaskIds(taskIdsInput);
    // Helper: keep `status.scopedTaskIds` in lockstep with the Set so the
    // PR body block always reflects what was actually used to filter.
    const setScope = (ids: readonly string[] | null) => {
      scopedTaskIds = ids === null ? null : new Set(ids);
      status.scopedTaskIds = ids === null ? null : [...ids];
    };
    // Whitespace-only `branch-name` (e.g. `${{ github.head_ref }}` against a
    // tag push) was previously truthy → entered scoped mode → matched 0 tasks
    // → silently filtered out every drift, including HIGH ones, and never
    // called setFailed. Treat empty/whitespace input as "no branch provided".
    const branchName = branchNameInput.trim();
    if (explicitTaskIds.length > 0) {
      setScope(explicitTaskIds);
      core.info(`Scoping drift check to ${explicitTaskIds.length} explicit task id(s).`);
    } else if (branchName) {
      const { tasks, truncated, droppedNonMatching } = await fetchTasksForBranch(
        apiUrl,
        projectId,
        headers,
        branchName,
      );
      if (droppedNonMatching > 0) {
        // The server returned rows whose branchName != the one we asked for —
        // a server-side filter contract violation. We already dropped them
        // (client-side re-check), but surface it loudly so the bug gets fixed.
        core.warning(
          `PlanSync drift-check: API returned ${droppedNonMatching} task(s) not on branch "${branchName}" for a branchName-filtered query; ignoring them (client-side re-check). This indicates a server-side filter bug.`,
        );
      }
      if (truncated) {
        status.truncatedTaskScan = true;
        core.setFailed(
          `PlanSync drift-check refused to run: more than ${TASK_PAGE_CAP * TASK_PAGE_SIZE} tasks on branch "${branchName}" — scope would be incomplete and could miss in-scope HIGH drifts.`,
        );
        return;
      }
      if (tasks.length === 0) {
        // The caller explicitly asked us to scope to a branch; finding 0 tasks
        // is almost always a mis-configured workflow (wrong branch ref, stale
        // task records, etc.) rather than "this PR truly has no PlanSync work".
        // Fail loudly instead of pretending the gate is green.
        core.setFailed(
          `PlanSync drift-check: no tasks found with branchName="${branchName}". Refusing to silently pass — verify the branch-name input or pass \`task-ids\` explicitly.`,
        );
        return;
      }
      scopedTaskObjects = tasks;
      const ids = tasks.map((t) => t.id);
      setScope(ids);
      core.info(`Scoping drift check to ${ids.length} task(s) on branch "${branchName}".`);
    } else if (strictSourcing) {
      // R-207 / L3: strict-sourcing forbids project-wide runs — an unscoped PR
      // cannot be traced to a current-plan task, which is the whole point.
      core.setFailed(
        'PlanSync strict-sourcing: this PR is not scoped to any task (no `branch-name` or `task-ids`). Every change must trace to a current-plan task — provide branch-name/task-ids, or add an exempt label.',
      );
      return;
    } else {
      core.warning(
        'PlanSync drift-check is running in project-wide mode: any open drift in the project will gate this PR. Pass `task-ids` or `branch-name` to scope the check to this PR.',
      );
    }

    // R-207 / L3: strict version binding — every scoped task must be bound to
    // the CURRENT active plan version. This is belt-and-suspenders beyond the
    // drift gate: drift rows are generated on plan activation and the gate only
    // fails on HIGH severity, but a deterministic version comparison catches
    // ANY stale binding (incl. medium/low, or an edge case with no drift row)
    // before the change can merge.
    if (strictSourcing && scopedTaskIds !== null) {
      const activeVersion =
        status.planVersion ?? (await fetchActivePlanVersion(apiUrl, projectId, headers));
      if (activeVersion == null) {
        core.setFailed(
          'PlanSync strict-sourcing: no active plan for this project — cannot verify task version binding.',
        );
        return;
      }
      let scopedTasks: TaskRow[];
      if (scopedTaskObjects !== null) {
        scopedTasks = scopedTaskObjects;
      } else {
        const ids = [...(scopedTaskIds as Set<string>)];
        const fetched = await Promise.all(
          ids.map((id) => fetchTaskById(apiUrl, projectId, headers, id)),
        );
        scopedTasks = fetched.filter((t): t is TaskRow => t !== null);
        if (scopedTasks.length < ids.length) {
          core.setFailed(
            `PlanSync strict-sourcing: ${ids.length - scopedTasks.length} explicit task id(s) not found in project ${projectId}.`,
          );
          return;
        }
      }
      // Fail-closed: a scoped task with no boundPlanVersion in the API response
      // means we cannot verify its plan binding. Under strict-sourcing we must
      // refuse rather than wave it through.
      const missingVersion = scopedTasks.filter((t) => typeof t.boundPlanVersion !== 'number');
      if (missingVersion.length > 0) {
        core.setFailed(
          `PlanSync strict-sourcing: ${missingVersion.length} scoped task(s) have no boundPlanVersion in the API response — cannot verify plan binding, refusing to pass (fail-closed): ${missingVersion.map((t) => t.id).join(', ')}.`,
        );
        return;
      }
      const stale = scopedTasks.filter((t) => t.boundPlanVersion !== activeVersion);
      if (stale.length > 0) {
        for (const t of stale) {
          core.error(
            `Task ${t.id} is bound to plan v${t.boundPlanVersion}, but the active plan is v${activeVersion}. Rebind before merging.`,
          );
        }
        core.setFailed(
          `PlanSync strict-sourcing: ${stale.length} scoped task(s) bound to a stale plan version. Rebind to v${activeVersion} (plansync_task_rebind) before this PR can merge.`,
        );
        return;
      }
    }

    let allDrifts: DriftRow[];
    try {
      const result = await fetchOpenDrifts(apiUrl, projectId, headers);
      if (result.truncated) {
        status.truncatedDriftScan = true;
        // R-193 (#2768): a truncated scan is NOT an authoritative empty —
        // mark 'failed' so the PR body block does not render the partial
        // (possibly empty) list as "no open alerts in scope".
        status.driftScanStatus = 'failed';
        core.setFailed(
          'PlanSync drift-check: open drift list exceeds pagination cap; refusing to gate on a partial view (HIGH drifts could be on later pages). Triage backlog or raise the cap.',
        );
        return;
      }
      allDrifts = result.rows;
    } catch (err) {
      // R-193 (#2768): network / server error before we got a complete page
      // set — same reasoning as the truncation branch above.
      status.driftScanStatus = 'failed';
      core.setFailed(err instanceof Error ? err.message : String(err));
      return;
    }

    const drifts =
      scopedTaskIds === null ? allDrifts : allDrifts.filter((d) => scopedTaskIds!.has(d.taskId));
    status.drifts = drifts.map((d) => ({
      id: d.id,
      severity: d.severity,
      taskId: d.taskId,
      reason: d.reason,
    }));
    // R-193 (#2768): drift query finished and `status.drifts` is now the
    // authoritative scoped list. Everything below this point is local
    // formatting / output that cannot invalidate the drift result.
    status.driftScanStatus = 'completed';

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
  } finally {
    // R-193: write the PlanSync status block onto the PR body, in place,
    // exactly once per run. The block is idempotent — re-runs replace the
    // block in place rather than appending — so workflows can wire this
    // into both `pull_request: [opened]` and `pull_request: [synchronize]`.
    //
    // Skip silently when any of the three inputs is missing so existing
    // workflows that haven't opted in continue to behave exactly as before.
    if (!githubToken || !repoInput || !prNumberInput) {
      if (githubToken || repoInput || prNumberInput) {
        core.info(
          'PlanSync PR-body sync skipped: provide all three of `github-token`, `repo`, and `pr-number` to enable the R-193 block injection.',
        );
      }
    } else {
      const prNumber = Number.parseInt(prNumberInput, 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        core.warning(
          `PlanSync PR-body sync skipped: \`pr-number\` input "${prNumberInput}" is not a positive integer.`,
        );
      } else if (!/^[^/\s]+\/[^/\s]+$/.test(repoInput)) {
        core.warning(
          `PlanSync PR-body sync skipped: \`repo\` input "${repoInput}" must be in "owner/name" form.`,
        );
      } else {
        try {
          const result = await syncPrBody(status, {
            repo: repoInput,
            prNumber,
            token: githubToken,
          });
          core.setOutput('pr-body-updated', String(result.updated));
          core.info(
            result.updated
              ? `PlanSync PR-body sync: updated PR #${prNumber} (${result.reason}).`
              : `PlanSync PR-body sync: ${result.reason}.`,
          );
        } catch (err) {
          // Intentionally non-fatal: the gate's pass/fail verdict is the
          // contract callers actually rely on. A failed PR-body sync only
          // means the reviewer doesn't get the rendered status block;
          // logging a warning is enough.
          core.warning(
            `PlanSync PR-body sync failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }
}

// When this module is the GitHub Action entrypoint, kick off `run()`
// immediately. During unit tests we import `run` directly and drive it from
// the test runner, so we suppress auto-invocation via VITEST.
if (!process.env.VITEST) {
  void run();
}
