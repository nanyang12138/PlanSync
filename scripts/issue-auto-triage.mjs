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
const MAX_DISPATCH = Number.parseInt(process.env.TRIAGE_MAX_DISPATCH || '3', 10);
const MAX_CLOSE = Number.parseInt(process.env.TRIAGE_MAX_CLOSE || '25', 10);

if (APPLY && (!REPO || !TOKEN)) {
  console.error(
    'apply mode needs GH_REPO + GITHUB_TOKEN env vars. Pass --dry-run for read-only triage.',
  );
  process.exit(2);
}

// `gh` is the cleanest GitHub client in CI (already installed on
// ubuntu-latest). Using it via spawnSync keeps the script free of npm
// deps so the workflow doesn't need an install step.
function gh(args, { allowFail = false } = {}) {
  const env = { ...process.env };
  if (TOKEN) env.GH_TOKEN = TOKEN;
  const r = spawnSync('gh', args, { encoding: 'utf-8', env });
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
  // gh issue close --comment is one atomic call.
  gh([
    'issue',
    'close',
    String(issue.number),
    '--reason',
    reason === 'wontfix' ? 'not planned' : 'completed',
    '--comment',
    body,
  ]);
  gh([
    'issue',
    'edit',
    String(issue.number),
    '--add-label',
    reason === 'wontfix' ? 'wontfix,auto-triaged' : 'auto-triaged',
  ]);
  console.log(`closed #${issue.number} (${reason}): ${issue.title.slice(0, 80)}`);
}

async function dispatchIssue(issue) {
  if (DRY_RUN) {
    console.log(`[dry-run] would dispatch #${issue.number}: ${issue.title.slice(0, 80)}`);
    return;
  }
  gh(['issue', 'edit', String(issue.number), '--add-label', 'cursor:dispatch,auto-triaged']);
  console.log(`dispatched #${issue.number}: ${issue.title.slice(0, 80)}`);
}

// --- 5. Main ---------------------------------------------------------------

async function main() {
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
    await commentAndClose(item.issue, body, 'completed');
    closed += 1;
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
    await commentAndClose(item.issue, body, 'completed');
    closed += 1;
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
    await commentAndClose(item.issue, body, 'wontfix');
    closed += 1;
  }

  let dispatched = 0;
  for (const item of buckets.dispatch) {
    if (dispatched >= MAX_DISPATCH) {
      console.log(
        `(rate-limit: skipping #${item.issue.number} — ${dispatched}/${MAX_DISPATCH} dispatch slots used)`,
      );
      continue;
    }
    await dispatchIssue(item.issue);
    dispatched += 1;
  }

  console.log();
  console.log(`Summary: closed ${closed}, dispatched ${dispatched}.`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
