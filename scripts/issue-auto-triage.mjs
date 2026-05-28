#!/usr/bin/env node
/**
 * scripts/issue-auto-triage.mjs — backlog triage for `severity:must` issues.
 *
 * The review-finding pipeline (cursor-review → cursor-review-triage) keeps
 * opening structured issues, but it does NOT have a "is this real?" stage.
 * Result: the backlog grows by 10-30 issues a day, most of which are
 * duplicates of the same finding flagged across multiple PRs, already
 * fixed by a merged PR, or about a feature that doesn't exist yet.
 *
 * This script is the missing triage layer. For each open `severity:must`
 * issue it decides one of four outcomes, then takes the matching action:
 *
 *   resolved-by-pr  → comment "closed by #N" + close as completed.
 *                     Detected by scanning every OPEN cursor/* PR body
 *                     and every recently-merged PR body for
 *                     `closes #N` / `fixes #N` / `resolves #N`.
 *
 *   phantom         → comment with the verification evidence (grep
 *                     locations checked) + label `wontfix` + close as
 *                     not_planned. Detected by a small registry of
 *                     phantom-feature probes; each probe asserts the
 *                     codebase does NOT contain the path the issue
 *                     complains about.
 *
 *   dispatch        → add `cursor:dispatch` label so the existing
 *                     `cursor-review-dispatch.yml` workflow spawns a
 *                     Cursor Cloud Agent to fix it. Rate-limited per
 *                     run via TRIAGE_MAX_DISPATCH (default 3) so we
 *                     don't burn Cursor API tokens on the whole
 *                     backlog in one go.
 *
 *   skip            → already labeled cursor:dispatch / dispatched /
 *                     umbrella / wontfix / auto-triaged / needs-human,
 *                     or referenced as closes-keyword in a still-open
 *                     PR (let that PR finish first).
 *
 * Modes
 *
 *   --dry-run   Print the proposed action for every issue but do NOT
 *               touch the issue tracker. Safe to run on a workstation
 *               with read-only `gh` auth.
 *   --json      Emit the categorized issue list as JSON to stdout
 *               (skips the action phase). Useful for piping into
 *               other tooling.
 *   --apply     Default. Take the action for each non-skip issue.
 *
 * Env
 *
 *   GITHUB_TOKEN          required for write actions (issues: write).
 *                         Read-only token is fine for --dry-run.
 *   GH_REPO               required, e.g. `nanyang12138/PlanSync`.
 *   TRIAGE_MAX_DISPATCH   maximum issues to label cursor:dispatch per
 *                         run. Default 3 to leave headroom on the
 *                         Cursor API quota.
 *   TRIAGE_MAX_CLOSE      maximum issues to close per run. Default 25.
 *                         Closes are cheap and idempotent so the cap
 *                         is loose.
 *
 * Idempotency
 *
 *   Every issue we act on gets the `auto-triaged` label so a subsequent
 *   run skips it. Closed issues are obviously skipped by the open-only
 *   filter at the top.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const MODE_FLAGS = new Set(['--dry-run', '--json', '--apply']);
const args = process.argv.slice(2);
const mode = args.find((a) => MODE_FLAGS.has(a)) ?? '--apply';
const DRY_RUN = mode === '--dry-run';
const JSON_OUT = mode === '--json';
const APPLY = mode === '--apply';

const REPO = process.env.GH_REPO || '';
const TOKEN = process.env.GITHUB_TOKEN || '';
// Parse a non-negative-integer rate-limit knob from the env, with a hard
// guard against garbage input.
//
// Why this isn't just `Number.parseInt(raw || default, 10)`:
//   The two consumers below use `count >= LIMIT` as the loop break.
//   `Number.parseInt('abc', 10)` returns NaN, and any comparison
//   against NaN is `false` — so a NaN limit silently DISABLES the
//   rate limit and the loop drains the entire backlog. The manual
//   workflow_dispatch form (.github/workflows/issue-auto-triage.yml
//   `max_dispatch` / `max_close` inputs) is the realistic source of
//   bad input: a typo like `max_dispatch=abx` would otherwise
//   dispatch every open `severity:must` issue in one run and burn
//   the Cursor API quota.
//
// Why we don't just trust `Number.parseInt` for the non-empty branch:
//   parseInt is lexically permissive — `parseInt('5abc', 10)` returns
//   5, and `parseInt('1.5', 10)` returns 1. Both of those are exactly
//   the "garbage input → silent rate-limit change" the rest of this
//   guard is here to prevent: the user typed `max_dispatch=5abc` or
//   `max_dispatch=1.5` expecting it to be rejected, and instead we'd
//   quietly run with a different limit than intended. So we
//   pre-validate with a strict `/^\d+$/` after trim before handing
//   off to parseInt — only fully-numeric, non-negative strings get
//   through; everything else routes to the default + warning path.
//
// Why a negative integer clamps to 0 instead of falling back to the
// default (issue #1400 / review-finding #2751):
//   A manual operator who types `max_dispatch=-1` is unambiguously
//   asking for *fewer* actions — they want the cron paused for this
//   run. The previous policy ("negative → default") substituted a
//   *higher* limit (3 dispatches, 25 closes) and pushed the run in
//   the opposite direction of operator intent, burning Cursor API
//   quota and closing issues they wanted left alone. The current
//   policy clamps to 0 so `count >= LIMIT` is true on the first
//   iteration (count starts at 0) and the loop short-circuits before
//   any action runs. The clamp is warning-loud so the CI log still
//   surfaces the misconfigured input. NaN / non-numeric still falls
//   back to the default because there is no quantitative "do less"
//   intent to honor — silently no-op'ing the scheduled cron on a
//   typo would be worse.
function parseLimitEnv(name, raw, defaultValue) {
  if (raw === undefined || raw === null || raw === '') {
    return defaultValue;
  }
  const trimmed = typeof raw === 'string' ? raw.trim() : String(raw);
  if (trimmed === '') return defaultValue; // whitespace-only treated the same as unset
  if (/^-\d+$/.test(trimmed)) {
    console.warn(
      `[triage] ${name}=${JSON.stringify(raw)} is negative; ` +
        `clamping to 0 (zero quota) — refusing to substitute the default ` +
        `because that would expand quota in the opposite direction of the operator's input.`,
    );
    return 0;
  }
  const parsed = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER) {
    console.warn(
      `[triage] ${name}=${JSON.stringify(raw)} is not a non-negative integer; ` +
        `falling back to default=${defaultValue} to preserve rate-limit semantics.`,
    );
    return defaultValue;
  }
  return parsed;
}

const MAX_DISPATCH = parseLimitEnv('TRIAGE_MAX_DISPATCH', process.env.TRIAGE_MAX_DISPATCH, 3);
const MAX_CLOSE = parseLimitEnv('TRIAGE_MAX_CLOSE', process.env.TRIAGE_MAX_CLOSE, 25);

if (APPLY && (!REPO || !TOKEN)) {
  console.error(
    'apply mode needs GH_REPO + GITHUB_TOKEN env vars. Pass --dry-run for read-only triage.',
  );
  process.exit(2);
}

// `gh` is the cleanest GitHub client in CI (already installed on
// ubuntu-latest). Using it via spawnSync keeps the script free of npm
// deps so the workflow doesn't need an install step.
//
// Token selection.
//   The default GITHUB_TOKEN granted to a workflow CANNOT trigger other
//   workflow runs — when you create/label an issue using GITHUB_TOKEN,
//   the resulting `issues: labeled` event is silently dropped to prevent
//   recursive workflow loops. This script's whole purpose is to add the
//   `cursor:dispatch` label so the existing cursor-review-dispatch.yml
//   workflow picks the issue up; that label MUST be applied with a
//   token that GitHub treats as a real user / App identity (a PAT or a
//   GitHub App installation token).
//
//   `gh()` keeps using GITHUB_TOKEN for the read-heavy and close-issue
//   paths (cheap, no downstream workflow side effects). `ghAsUser()` is
//   the explicit "I need this to trigger another workflow" helper; it
//   uses TRIGGER_TOKEN (`CURSOR_REVIEW_PAT` in the workflow env) and
//   falls back to GITHUB_TOKEN with a warning so a misconfigured repo
//   still does *something* visible instead of silently failing.
// Node's `spawnSync` defaults `maxBuffer` to 1 MiB; once the gh JSON
// output passes that line, the child is killed with ENOBUFS and stdout
// is silently truncated mid-string. Production hit: 2026-05-26 the
// `severity:must` backlog grew past 800 open issues and `gh issue list
// --limit 1500 --json number,title,labels,body,createdAt` started
// returning ~1.1 MB of JSON. Every other workflow run died with
// `SyntaxError: Unterminated string in JSON at position ~870000`
// because `r.status` is still `0` in the ENOBUFS case (gh exited
// cleanly before SIGTERM landed) so this wrapper handed the truncated
// buffer to JSON.parse. We now (a) raise the cap to 64 MiB — plenty
// of headroom even if the backlog 50x's — and (b) explicitly surface
// `r.error` so any spawn-level failure (ENOBUFS, ENOENT, signal kill)
// becomes a thrown error instead of silently-truncated output.
const GH_MAX_BUFFER = 64 * 1024 * 1024;

function gh(args, { allowFail = false } = {}) {
  const env = { ...process.env };
  if (TOKEN) env.GH_TOKEN = TOKEN;
  const r = spawnSync('gh', args, { encoding: 'utf-8', env, maxBuffer: GH_MAX_BUFFER });
  if (r.error && !allowFail) {
    throw new Error(`gh ${args.join(' ')} -> spawn error: ${r.error.message}`);
  }
  if (r.status !== 0 && !allowFail) {
    throw new Error(`gh ${args.join(' ')} -> exit ${r.status}: ${r.stderr}`);
  }
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

const TRIGGER_TOKEN = process.env.TRIGGER_TOKEN || '';
let triggerTokenWarned = false;

function ghAsUser(args, { allowFail = false } = {}) {
  const env = { ...process.env };
  if (TRIGGER_TOKEN) {
    env.GH_TOKEN = TRIGGER_TOKEN;
  } else {
    if (!triggerTokenWarned) {
      console.warn(
        '[warn] TRIGGER_TOKEN is not set (workflow forgot to wire CURSOR_REVIEW_PAT). ' +
          'Falling back to GITHUB_TOKEN — label adds will succeed but the resulting ' +
          'issues: labeled event will NOT trigger cursor-review-dispatch.yml, so no ' +
          'Cursor Cloud Agent will be spawned. Add a CURSOR_REVIEW_PAT repo secret ' +
          '(fine-grained PAT with issues:write) to fix this.',
      );
      triggerTokenWarned = true;
    }
    if (TOKEN) env.GH_TOKEN = TOKEN;
  }
  const r = spawnSync('gh', args, { encoding: 'utf-8', env, maxBuffer: GH_MAX_BUFFER });
  if (r.error && !allowFail) {
    throw new Error(`gh ${args.join(' ')} -> spawn error: ${r.error.message}`);
  }
  if (r.status !== 0 && !allowFail) {
    throw new Error(`gh ${args.join(' ')} -> exit ${r.status}: ${r.stderr}`);
  }
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

function ghJson(args) {
  const r = gh(args);
  if (!r.stdout.trim()) return [];
  return JSON.parse(r.stdout);
}

// Labels the script writes during normal operation. Created at
// startup via `gh label create --force` (idempotent — `--force`
// no-ops if the label already exists with the same metadata,
// otherwise updates colour/description). Without this bootstrap
// step the first `gh issue edit --add-label <name>` call fails
// with "'<name>' not found" and the script aborts mid-batch
// (production hit: workflow run 2026-05-26 crashed on issue #1219
// after closing it but before labelling it; remaining 68
// resolved-by-pr issues were never processed).
//
// `cursor:dispatch` and `dispatched` are the labels the *existing*
// cursor-review-dispatch.yml workflow listens for; if they are
// missing from the repo, the whole agent-dispatch chain is dead
// regardless of whether THIS script runs. Creating them here
// doubles as a repo-bootstrap guarantee — the first run of
// issue-auto-triage anywhere becomes the canonical creator of all
// labels the automation surface depends on.
const REQUIRED_LABELS = [
  {
    name: 'auto-triaged',
    color: 'ededed',
    description: 'issue-auto-triage acted on this issue (idempotency lock)',
  },
  {
    name: 'needs-human',
    color: 'fbca04',
    description: 'issue-auto-triage could not classify; owner needs to look',
  },
  {
    name: 'cursor:dispatch',
    color: '5319e7',
    description:
      'Apply this label to ask cursor-review-dispatch.yml to spawn a Cursor Cloud Agent to fix this issue',
  },
  {
    name: 'dispatched',
    color: 'c5def5',
    description: 'cursor-review-dispatch.yml has handed this issue to an agent',
  },
];

function ensureRequiredLabels() {
  // We use `--force` so an existing label is preserved (with its
  // current colour / description updated to match the canonical
  // values above). Non-zero exit here is logged but does NOT abort
  // the run — the per-issue label calls below already fall back
  // to allowFail mode so the worst case is "this issue does not
  // get the lock label", not "the whole batch dies".
  for (const label of REQUIRED_LABELS) {
    const r = gh(
      [
        'label',
        'create',
        label.name,
        '--color',
        label.color,
        '--description',
        label.description,
        '--force',
      ],
      { allowFail: true },
    );
    if (r.status !== 0) {
      console.warn(
        `[warn] could not ensure label "${label.name}": ${r.stderr.trim() || '(no stderr)'}`,
      );
    }
  }
}

// `gh issue edit --add-label X,Y` rejects the WHOLE call if any
// label in the list is missing, even if the others exist. This
// helper retries the add label-by-label and lets the caller log
// partial failures without aborting the batch.
//
// `triggersDownstreamWorkflow` is the load-bearing knob: when true,
// every label add is routed through ghAsUser() so a downstream
// workflow listening on `issues: labeled` will actually fire. The
// default (false) uses the standard gh() helper because most label
// adds (auto-triaged, wontfix) are pure bookkeeping that doesn't
// need to trigger anything.
function addLabelsToIssue(issueNumber, labels, { triggersDownstreamWorkflow = false } = {}) {
  const failed = [];
  const runner = triggersDownstreamWorkflow ? ghAsUser : gh;
  for (const label of labels) {
    const r = runner(['issue', 'edit', String(issueNumber), '--add-label', label], {
      allowFail: true,
    });
    if (r.status !== 0) {
      failed.push({ label, stderr: r.stderr.trim() });
    }
  }
  return failed;
}

// --- 1. Snapshot the world -------------------------------------------------

function listOpenMustIssues() {
  // gh's --label filter swallows `severity:must` (the `:` confuses the
  // filter), so we mirror find-pending-must.sh and filter in code.
  const all = ghJson([
    'issue',
    'list',
    '--state',
    'open',
    '--limit',
    '1500',
    '--json',
    'number,title,labels,body,createdAt',
  ]);
  return all.filter((i) => (i.labels || []).some((l) => l.name === 'severity:must'));
}

function listOpenPrs() {
  return ghJson([
    'pr',
    'list',
    '--state',
    'open',
    '--limit',
    '300',
    '--json',
    'number,headRefName,body,title,state',
  ]);
}

function listRecentlyMergedPrs() {
  // Last ~14 days of merges is enough to catch the auto-close gap
  // (GitHub closes refs from merged squashed PRs only when the closes
  // line was in the PR body; older merges with bad closes lines are
  // already handled by close-resolved-issues.sh).
  return ghJson([
    'pr',
    'list',
    '--state',
    'merged',
    '--limit',
    '200',
    '--search',
    `repo:${REPO} merged:>=${new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10)}`,
    '--json',
    'number,body,title,mergedAt,state',
  ]);
}

// closing-keyword regex matching GitHub's own parser, including the
// `fix #N` singular form that `find-pending-must.sh` is missing
// (separately tracked as #1057 #1054 #1048).
const CLOSING_KEYWORD_RE = /\b(?:close[ds]?|fix(?:e[sd])?|resolve[ds]?)\s*[:#]?\s*#(\d+)\b/gi;

function extractClosesRefs(body, title) {
  const refs = new Set();
  const haystack = `${body || ''} ${title || ''}`;
  for (const m of haystack.matchAll(CLOSING_KEYWORD_RE)) {
    refs.add(Number.parseInt(m[1], 10));
  }
  return refs;
}

// --- 2. Phantom-feature / resolved-cluster probes --------------------------
//
// Probes are intentionally conservative: each one MUST positively confirm
// (via filesystem grep) that the codebase state matches the issue's
// premise — we never close just because a regex matches the title.
//
// Add a new probe by appending an object with:
//   id           — string; appears in the close comment for audit.
//   match(issue) — must return true for the probe to consider this issue.
//   verify()     — must return { matches: boolean, evidence: string }
//                  describing what was checked. Only `matches=true`
//                  triggers the action.
//   verdict      — 'phantom' (close as wontfix) | 'resolved-in-tree'
//                  (close as completed).
//   reason       — short human-readable explanation appended to the
//                  GitHub close comment.

const REPO_ROOT = resolve(import.meta.dirname || '.', '..');

function rg(pattern, paths, { extra = [] } = {}) {
  const args = ['--no-heading', '--no-line-number', '--quiet', ...extra, pattern, ...paths];
  const r = spawnSync('rg', args, { cwd: REPO_ROOT, encoding: 'utf-8' });
  return r.status === 0; // 0 = match found, 1 = no match, >=2 = error
}

const PROBES = [
  // Resolved-in-tree examples are documented inline rather than
  // hardcoded because the cluster catalog already lives in
  // close-resolved-issues.sh. The probes below are limited to
  // phantom-feature detection where a closes-keyword scan cannot
  // help us (no PR will ever close them by design).
];

// --- 3. Categorize ---------------------------------------------------------

const SKIP_LABELS = new Set([
  'cursor:dispatch',
  'dispatched',
  'umbrella',
  'wontfix',
  'auto-triaged',
  'needs-human',
  'do-not-merge',
]);

function categorize(issue, ctx) {
  const labels = new Set((issue.labels || []).map((l) => l.name));

  for (const l of SKIP_LABELS) {
    if (labels.has(l)) {
      return {
        verdict: 'skip',
        reason: `already labeled ${l}`,
      };
    }
  }

  // Resolved-by-open-PR: someone's already on it. Let the PR finish.
  const openPr = ctx.openPrClosesMap.get(issue.number);
  if (openPr) {
    return {
      verdict: 'skip',
      reason: `referenced as closes-keyword in open PR #${openPr.number} (${openPr.headRefName})`,
    };
  }

  // Resolved-by-merged-PR: auto-close didn't fire (markdown bold,
  // backtick'd refs, GitHub closer-list truncation, etc.). We can
  // safely close + comment.
  const mergedPr = ctx.mergedPrClosesMap.get(issue.number);
  if (mergedPr) {
    return {
      verdict: 'resolved-by-pr',
      pr: mergedPr,
      reason: `auto-close on PR #${mergedPr.number} did not fire — closing manually`,
    };
  }

  // Phantom probes.
  for (const probe of PROBES) {
    if (!probe.match(issue)) continue;
    const v = probe.verify();
    if (!v.matches) continue;
    return {
      verdict: probe.verdict,
      probeId: probe.id,
      reason: probe.reason,
      evidence: v.evidence,
    };
  }

  return { verdict: 'dispatch' };
}

// --- 4. Actions ------------------------------------------------------------

async function commentAndClose(issue, body, reason) {
  if (DRY_RUN) {
    console.log(`[dry-run] would close #${issue.number} as ${reason}: ${issue.title.slice(0, 80)}`);
    return;
  }
  // `gh issue close --comment` is one atomic call that creates the
  // closing comment and flips state in a single API round-trip — if
  // it throws here, no comment has been published either so retry
  // on the next cron is safe.
  gh([
    'issue',
    'close',
    String(issue.number),
    '--reason',
    reason === 'wontfix' ? 'not planned' : 'completed',
    '--comment',
    body,
  ]);
  // Best-effort label apply: if any label is missing from the repo
  // (e.g. someone deleted it manually between ensureRequiredLabels
  // at startup and now) we log the failure and continue rather
  // than abort the whole batch — the issue is already closed, so
  // the worst case is missing audit metadata, not duplicate work.
  const labels = reason === 'wontfix' ? ['wontfix', 'auto-triaged'] : ['auto-triaged'];
  const failed = addLabelsToIssue(issue.number, labels);
  if (failed.length > 0) {
    console.warn(
      `[warn] #${issue.number} closed but label apply failed for: ${failed
        .map((f) => f.label)
        .join(', ')}`,
    );
  }
  console.log(`closed #${issue.number} (${reason}): ${issue.title.slice(0, 80)}`);
}

async function dispatchIssue(issue) {
  if (DRY_RUN) {
    console.log(`[dry-run] would dispatch #${issue.number}: ${issue.title.slice(0, 80)}`);
    return;
  }
  // Dispatch label MUST land — without it the existing
  // cursor-review-dispatch.yml workflow won't trigger and the
  // issue sits forever. The auto-triaged lock is best-effort: if
  // cursor:dispatch landed but auto-triaged didn't, the next cron
  // run will see the cursor:dispatch label in SKIP_LABELS and
  // skip the issue anyway, so no duplicate dispatch is possible.
  //
  // triggersDownstreamWorkflow=true routes the label-add through
  // CURSOR_REVIEW_PAT (when configured). GitHub's recursion-guard
  // silently drops the `issues: labeled` event when GITHUB_TOKEN is
  // the actor, so without the PAT the dispatch chain dies on
  // arrival even though the label visibly lands on the issue —
  // exactly the failure mode caught on 2026-05-26 (28 issues acted
  // on, cursor-review-dispatch.yml never ran once).
  const failed = addLabelsToIssue(issue.number, ['cursor:dispatch', 'auto-triaged'], {
    triggersDownstreamWorkflow: true,
  });
  const dispatchFailed = failed.find((f) => f.label === 'cursor:dispatch');
  if (dispatchFailed) {
    console.warn(`[warn] failed to dispatch #${issue.number}: ${dispatchFailed.stderr}`);
    return false; // #1248: signal failure so caller does not count this against quota
  }
  if (failed.length > 0) {
    console.warn(
      `[warn] #${issue.number} dispatched but auto-triaged label failed: ${failed
        .map((f) => f.label)
        .join(', ')}`,
    );
  }
  console.log(`dispatched #${issue.number}: ${issue.title.slice(0, 80)}`);
}

// --- 5. Main ---------------------------------------------------------------

async function main() {
  // Make sure every label the script reads/writes exists in the
  // repo before we start mutating issues. Skipped in --json mode
  // (read-only contract) and in --dry-run (the whole point of dry-
  // run is "touch nothing").
  if (APPLY) {
    ensureRequiredLabels();
  }

  const issues = listOpenMustIssues();
  const openPrs = listOpenPrs();
  // Always fetch merged PRs — even --json output classifies issues
  // against them, otherwise resolved-by-pr would silently undercount
  // every recently-landed fix.
  const mergedPrs = listRecentlyMergedPrs();

  const openPrClosesMap = new Map();
  for (const pr of openPrs) {
    for (const n of extractClosesRefs(pr.body, pr.title)) {
      // First open PR to mention wins.
      if (!openPrClosesMap.has(n)) openPrClosesMap.set(n, pr);
    }
  }
  const mergedPrClosesMap = new Map();
  for (const pr of mergedPrs) {
    for (const n of extractClosesRefs(pr.body, pr.title)) {
      if (!mergedPrClosesMap.has(n)) mergedPrClosesMap.set(n, pr);
    }
  }

  const ctx = { openPrClosesMap, mergedPrClosesMap };
  const buckets = {
    skip: [],
    'resolved-by-pr': [],
    phantom: [],
    'resolved-in-tree': [],
    dispatch: [],
  };
  for (const issue of issues) {
    const r = categorize(issue, ctx);
    buckets[r.verdict].push({ issue, ...r });
  }

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(buckets, null, 2) + '\n');
    return;
  }

  console.log(`Open severity:must issues: ${issues.length}`);
  for (const [k, v] of Object.entries(buckets)) {
    console.log(`  ${k.padEnd(22)} ${v.length}`);
  }
  console.log();

  let closed = 0;
  for (const item of buckets['resolved-by-pr']) {
    if (closed >= MAX_CLOSE) break;
    const body =
      `Auto-triage: resolved by PR #${item.pr.number} (${item.pr.title}).\n\n` +
      `GitHub's closing-keyword auto-close did not fire on the merge — most\n` +
      `commonly because the PR body wrapped \`closes #N\` in markdown\n` +
      `formatting (bold, code fences) or because GitHub's per-PR closes-\n` +
      `list cap was exceeded. Closing manually now to keep the backlog\n` +
      `accurate.\n\n` +
      `_(automated by \`scripts/issue-auto-triage.mjs\`)_`;
    // #1240: wrap per-issue writes in try/catch so a single failure does
    // not interrupt the whole triage run via main().catch().
    try {
      await commentAndClose(item.issue, body, 'completed');
      closed += 1;
    } catch (err) {
      console.warn(`[warn] #${item.issue.number} close failed: ${err.message}`);
    }
  }
  for (const item of buckets['resolved-in-tree']) {
    if (closed >= MAX_CLOSE) break;
    const body =
      `Auto-triage: the code path this issue describes is already in the\n` +
      `expected shape on \`master\`.\n\n` +
      `**Probe**: \`${item.probeId}\`\n\n` +
      `**Evidence**:\n\n\`\`\`\n${item.evidence}\n\`\`\`\n\n` +
      `${item.reason}\n\n` +
      `_(automated by \`scripts/issue-auto-triage.mjs\`)_`;
    try {
      await commentAndClose(item.issue, body, 'completed');
      closed += 1;
    } catch (err) {
      console.warn(`[warn] #${item.issue.number} close failed: ${err.message}`);
    }
  }
  for (const item of buckets.phantom) {
    if (closed >= MAX_CLOSE) break;
    const body =
      `Auto-triage: this issue references a code path that does not exist\n` +
      `in this repository.\n\n` +
      `**Probe**: \`${item.probeId}\`\n\n` +
      `**Evidence**:\n\n\`\`\`\n${item.evidence}\n\`\`\`\n\n` +
      `${item.reason}\n\n` +
      `If a future PR introduces this feature, the same finding will be\n` +
      `re-emitted by the review-triage pipeline against the new code.\n\n` +
      `_(automated by \`scripts/issue-auto-triage.mjs\`)_`;
    try {
      await commentAndClose(item.issue, body, 'wontfix');
      closed += 1;
    } catch (err) {
      console.warn(`[warn] #${item.issue.number} close failed: ${err.message}`);
    }
  }

  let dispatched = 0;
  for (const item of buckets.dispatch) {
    if (dispatched >= MAX_DISPATCH) {
      console.log(
        `(rate-limit: skipping #${item.issue.number} — ${dispatched}/${MAX_DISPATCH} dispatch slots used)`,
      );
      continue;
    }
    // #1248: only increment the quota when dispatch actually succeeded.
    // dispatchIssue() returns true on success, false/undefined on failure.
    try {
      const ok = await dispatchIssue(item.issue);
      if (ok !== false) dispatched += 1;
    } catch (err) {
      console.warn(`[warn] #${item.issue.number} dispatch threw: ${err.message}`);
    }
  }

  console.log();
  console.log(`Summary: closed ${closed}, dispatched ${dispatched}.`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
