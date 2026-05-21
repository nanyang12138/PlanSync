#!/usr/bin/env node
/**
 * cursor-review-stale runner.
 *
 * Conservative weekly sweep over open `review-finding` issues:
 *
 *   - >= 14d old + the file referenced in the body 404s on the default
 *     branch → label `stale:file-missing` + one-time comment naming the
 *     missing path. We do NOT auto-close: a 404 conflates rename/move
 *     (issue still valid at the new path) with actual deletion (issue moot).
 *     The label gives the owner a deterministic backlog to triage manually.
 *
 *   - >= 30d / 60d / 90d old → label `stale:30d` / `stale:60d` / `stale:90d`
 *     (idempotent: skipped if the label already present). 90d+ also gets
 *     a one-time mention comment to nudge the owner.
 *
 * No LLM is used here — every label decision is a deterministic check
 * against issue metadata or the repo's contents API.
 *
 * Required env:
 *   GITHUB_TOKEN, GH_REPO
 *
 * Optional env:
 *   REVIEW_STALE_DRY_RUN=1
 *   REVIEW_STALE_OWNER (the @ to ping at 90d; default = repo owner)
 */
const { GITHUB_TOKEN, GH_REPO, REVIEW_STALE_DRY_RUN, REVIEW_STALE_OWNER } = process.env;

import { pathToFileURL } from 'node:url';

const __isMainScript = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (__isMainScript && (!GITHUB_TOKEN || !GH_REPO)) {
  console.error('Missing required env: GITHUB_TOKEN, GH_REPO');
  process.exit(1);
}

const DRY_RUN = REVIEW_STALE_DRY_RUN === '1' || REVIEW_STALE_DRY_RUN === 'true';
const OWNER = REVIEW_STALE_OWNER || (GH_REPO ? GH_REPO.split('/')[0] : '');

async function ghApi(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'plansync-review-stale',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) {
    const err = new Error(`GitHub ${method} ${path} -> 404`);
    err.status = 404;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function listOpenFindings() {
  const all = [];
  let page = 1;
  let totalCount = null;
  while (true) {
    const q = encodeURIComponent(`repo:${GH_REPO} is:issue is:open label:review-finding`);
    const data = await ghApi('GET', `/search/issues?q=${q}&per_page=100&page=${page}`);
    if (totalCount === null) totalCount = data?.total_count ?? null;
    const items = data?.items || [];
    all.push(...items);
    if (items.length < 100) break;
    page += 1;
    if (page > 20) {
      // Hard cap. Search API itself caps at 1000 results per query for
      // unauthenticated callers; for authenticated callers we still risk
      // long sweeps. Surface the truncation rather than silently miss work.
      const truncated = (totalCount ?? Number.POSITIVE_INFINITY) - all.length;
      console.warn(
        `listOpenFindings truncated at ${all.length} items (total_count=${totalCount}, missed≈${truncated}). Increase the page cap or refine the query.`,
      );
      const summaryFile = process.env.GITHUB_STEP_SUMMARY;
      if (summaryFile) {
        const fs = await import('node:fs');
        await fs.promises.appendFile(
          summaryFile,
          `\n> ⚠ stale sweep truncated at 2000 issues (total_count=${totalCount}, missed≈${truncated}).\n`,
        );
      }
      break;
    }
  }
  return all.filter((i) => !i.pull_request);
}

async function fileExistsOnDefault(path) {
  try {
    await ghApi('GET', `/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`);
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

async function addLabels(issueNumber, labels) {
  if (DRY_RUN) {
    console.log(`[dry-run] addLabels #${issueNumber}: ${labels.join(', ')}`);
    return;
  }
  await ghApi('POST', `/repos/${GH_REPO}/issues/${issueNumber}/labels`, { labels });
}

async function commentIssue(issueNumber, body) {
  if (DRY_RUN) {
    console.log(`[dry-run] commentIssue #${issueNumber}`);
    return;
  }
  await ghApi('POST', `/repos/${GH_REPO}/issues/${issueNumber}/comments`, { body });
}

function extractFilePath(body) {
  if (!body) return null;
  const m = body.match(/\*\*File\*\*:\s*`([^`]+)`/);
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw || raw === '(unknown)') return null;
  return raw.split(':')[0];
}

function extractSourcePrNumber(body) {
  if (!body) return null;
  // Triage writes `**Source**: PR #N · cursor-review · [comment](...#issuecomment-...)`.
  // Match the first PR number that follows `Source` to avoid catching unrelated
  // PR references in user-edited body.
  const m = body.match(/\*\*Source\*\*[^\n]*?PR\s+#(\d+)/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

async function isPrStillOpen(prNumber) {
  if (!prNumber) return false;
  try {
    const pr = await ghApi('GET', `/repos/${GH_REPO}/pulls/${prNumber}`);
    return pr?.state === 'open';
  } catch (err) {
    if (err.status === 404) return false;
    console.warn(`PR #${prNumber} lookup failed (non-fatal): ${err.message}`);
    return false;
  }
}

function ageInDays(createdAt) {
  return (Date.now() - new Date(createdAt).getTime()) / (1000 * 86400);
}

function appendSummary(line) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) {
    console.log(line);
    return;
  }
  // Append synchronously to keep ordering predictable.
  return import('node:fs').then(({ promises: fs }) => fs.appendFile(file, line + '\n'));
}

async function main() {
  const issues = await listOpenFindings();
  console.log(`Found ${issues.length} open review-finding issues`);

  const stats = {
    total: issues.length,
    fileMissing: [],
    stale30: [],
    stale60: [],
    stale90: [],
    untouched: 0,
  };

  // First pass (no API calls): pre-process labels/age and decide whether the
  // issue still needs a remote file/PR check. This lets us short-circuit
  // most issues without spending API quota and keeps the workflow within
  // its 10-minute timeout even at the 2000-issue cap.
  const preprocessed = issues.map((issue) => {
    const labels = new Set((issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)));
    const age = ageInDays(issue.created_at);
    const file = extractFilePath(issue.body);
    const needsFileCheck = Boolean(file) && age >= 14 && !labels.has('stale:file-missing');
    return { issue, labels, age, file, needsFileCheck };
  });

  // Second pass: run remote file-missing checks with bounded concurrency.
  // Each check is up to 2 API calls (PR state + contents). We process in
  // chunks so the wall time scales with `total / CONCURRENCY` instead of
  // strictly serial.
  const CONCURRENCY = 6;
  const targets = preprocessed.filter((p) => p.needsFileCheck);
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const chunk = targets.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (p) => {
        const sourcePr = extractSourcePrNumber(p.issue.body);
        const sourcePrOpen = await isPrStillOpen(sourcePr);
        if (sourcePrOpen) {
          // Source PR not merged yet; default-branch check would be a
          // false positive. Skip silently and revisit on the next sweep.
          p.fileMissingApplied = false;
          return;
        }
        let exists = true;
        try {
          exists = await fileExistsOnDefault(p.file);
        } catch (err) {
          console.warn(`#${p.issue.number}: file check failed (${err.message}), skipping`);
          p.fileMissingApplied = false;
          return;
        }
        if (!exists) {
          await commentIssue(
            p.issue.number,
            `自动检测：路径 \`${p.file}\` 在默认分支已不存在。可能是**文件被删除**（这条 finding 应关闭）或**文件被 rename/move**（finding 仍有效，只是路径变了）——sweep 无法区分这两种情况，因此**不**自动关单，仅打 \`stale:file-missing\` 标签由你判断后处理。`,
          );
          await addLabels(p.issue.number, ['stale:file-missing']);
          stats.fileMissing.push(p.issue.number);
          p.fileMissingApplied = true;
        } else {
          p.fileMissingApplied = false;
        }
      }),
    );
  }

  // Third pass: age-based stale labels. Bucket each issue first (no API
  // calls), then run mutations with bounded concurrency. Most issues fall
  // into the "no change needed" bucket and are free; the bounded
  // concurrency only matters when many items cross thresholds in a single
  // sweep (e.g. first run after backlog accumulation).
  const ageBuckets = { stale90: [], stale60: [], stale30: [], untouched: [] };
  for (const p of preprocessed) {
    const { labels, age } = p;
    if (age >= 90 && !labels.has('stale:90d')) ageBuckets.stale90.push(p);
    else if (age >= 60 && !labels.has('stale:60d') && !labels.has('stale:90d'))
      ageBuckets.stale60.push(p);
    else if (
      age >= 30 &&
      !labels.has('stale:30d') &&
      !labels.has('stale:60d') &&
      !labels.has('stale:90d')
    )
      ageBuckets.stale30.push(p);
    else if (!p.fileMissingApplied) ageBuckets.untouched.push(p);
  }
  stats.untouched = ageBuckets.untouched.length;

  async function applyAgeMutations(items, mutate) {
    for (let i = 0; i < items.length; i += CONCURRENCY) {
      const slice = items.slice(i, i + CONCURRENCY);
      await Promise.all(slice.map(mutate));
    }
  }

  await applyAgeMutations(ageBuckets.stale90, async (p) => {
    await addLabels(p.issue.number, ['stale:90d']);
    await commentIssue(
      p.issue.number,
      `这条 review-finding 已 open 90+ 天未处理，@${OWNER} 请决定：close（\`auto-closed:wontfix\` 标签后关）、派给 cloud agent（\`cursor:dispatch\` 标签）、或 \`do-not-close\` 标签压住等待时机。`,
    );
    stats.stale90.push(p.issue.number);
  });
  await applyAgeMutations(ageBuckets.stale60, async (p) => {
    await addLabels(p.issue.number, ['stale:60d']);
    stats.stale60.push(p.issue.number);
  });
  await applyAgeMutations(ageBuckets.stale30, async (p) => {
    await addLabels(p.issue.number, ['stale:30d']);
    stats.stale30.push(p.issue.number);
  });

  await appendSummary(`# Review-finding stale sweep`);
  await appendSummary(``);
  await appendSummary(`- Open findings scanned: **${stats.total}**`);
  await appendSummary(
    `- Newly labelled stale:file-missing: **${stats.fileMissing.length}** ${stats.fileMissing.map((n) => `#${n}`).join(' ')}`,
  );
  await appendSummary(
    `- Newly labelled stale:30d: **${stats.stale30.length}** ${stats.stale30.map((n) => `#${n}`).join(' ')}`,
  );
  await appendSummary(
    `- Newly labelled stale:60d: **${stats.stale60.length}** ${stats.stale60.map((n) => `#${n}`).join(' ')}`,
  );
  await appendSummary(
    `- Newly labelled stale:90d: **${stats.stale90.length}** ${stats.stale90.map((n) => `#${n}`).join(' ')}`,
  );
  await appendSummary(`- Already-labelled / fresh: **${stats.untouched}**`);

  console.log('Done.');
}

export { extractFilePath, extractSourcePrNumber, ageInDays };

if (__isMainScript) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
