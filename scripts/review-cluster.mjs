#!/usr/bin/env node
/**
 * cursor-review-cluster runner.
 *
 * Monthly aggregator. Pulls all `review-finding` issues from the last 90
 * days (open + closed), groups them via LLM into themes, and writes a
 * tracking issue summarising high-frequency clusters with suggested
 * follow-up actions:
 *
 *   - eslint_rule       → can be encoded as static lint
 *   - agent_rule        → belongs in `.cursor/rules/` or AGENTS.md/CLAUDE.md
 *   - doc_constraint    → belongs in docs/standards/
 *   - no_action         → noisy/transient, no follow-up needed
 *
 * The script never edits source rules itself — it only opens a tracking
 * issue. The user (or a downstream dispatcher PR) decides how to act.
 *
 * Required env:
 *   GITHUB_TOKEN, GH_REPO
 *   one of: LLM_API_KEY (+ optional LLM_API_BASE / LLM_MODEL_NAME)
 *           ANTHROPIC_API_KEY (+ optional ANTHROPIC_BASE_URL / ANTHROPIC_DEFAULT_SONNET_MODEL)
 *
 * Optional env:
 *   REVIEW_CLUSTER_DAYS (default 90)
 *   REVIEW_CLUSTER_MIN_COUNT (default 3) — minimum issue count per cluster
 *   REVIEW_CLUSTER_DRY_RUN=1
 */
const {
  GITHUB_TOKEN,
  GH_REPO,
  LLM_API_KEY,
  LLM_API_BASE,
  LLM_MODEL_NAME,
  ANTHROPIC_API_KEY,
  ANTHROPIC_BASE_URL,
  ANTHROPIC_DEFAULT_SONNET_MODEL,
  REVIEW_CLUSTER_DAYS,
  REVIEW_CLUSTER_MIN_COUNT,
  REVIEW_CLUSTER_DRY_RUN,
} = process.env;

if (!GITHUB_TOKEN || !GH_REPO) {
  console.error('Missing required env: GITHUB_TOKEN, GH_REPO');
  process.exit(1);
}

const DRY_RUN = REVIEW_CLUSTER_DRY_RUN === '1' || REVIEW_CLUSTER_DRY_RUN === 'true';
const WINDOW_DAYS = Math.max(7, Number.parseInt(REVIEW_CLUSTER_DAYS || '90', 10) || 90);
const MIN_COUNT = Math.max(2, Number.parseInt(REVIEW_CLUSTER_MIN_COUNT || '3', 10) || 3);
const CLUSTER_MARKER = '<!-- review-cluster:report -->';

async function ghApi(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'plansync-review-cluster',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function listFindings() {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400 * 1000).toISOString().slice(0, 10);
  const all = [];
  let page = 1;
  let totalCount = null;
  while (true) {
    const q = encodeURIComponent(
      `repo:${GH_REPO} is:issue label:review-finding created:>=${since}`,
    );
    const data = await ghApi('GET', `/search/issues?q=${q}&per_page=100&page=${page}`);
    if (totalCount === null) totalCount = data?.total_count ?? null;
    const items = data?.items || [];
    all.push(...items);
    if (items.length < 100) break;
    page += 1;
    if (page > 20) {
      const truncated = (totalCount ?? Number.POSITIVE_INFINITY) - all.length;
      console.warn(
        `listFindings truncated at ${all.length} items (total_count=${totalCount}, missed≈${truncated}). Cluster output represents only the first 2000 findings in window.`,
      );
      const summaryFile = process.env.GITHUB_STEP_SUMMARY;
      if (summaryFile) {
        const fs = await import('node:fs');
        await fs.promises.appendFile(
          summaryFile,
          `\n> ⚠ cluster sweep truncated at 2000 findings in window (total_count=${totalCount}, missed≈${truncated}).\n`,
        );
      }
      break;
    }
  }
  return all.filter((i) => !i.pull_request);
}

async function findExistingClusterIssueForMonth(yyyymm) {
  // Idempotency for workflow_dispatch re-runs: if an open `review-cluster`
  // issue already exists this month carrying our marker, append a comment
  // there instead of opening a duplicate.
  try {
    const q = encodeURIComponent(
      `repo:${GH_REPO} is:issue is:open label:review-cluster created:>=${yyyymm}-01 in:body "${CLUSTER_MARKER}"`,
    );
    const data = await ghApi('GET', `/search/issues?q=${q}&per_page=5`);
    return data?.items?.[0] || null;
  } catch (err) {
    console.warn(`Existing cluster issue lookup failed (will create new): ${err.message}`);
    return null;
  }
}

async function addIssueComment(issueNumber, body) {
  if (DRY_RUN) {
    console.log(`[dry-run] addIssueComment #${issueNumber}: ${body.slice(0, 200)}`);
    return null;
  }
  return ghApi('POST', `/repos/${GH_REPO}/issues/${issueNumber}/comments`, { body });
}

async function createIssue(title, body, labels) {
  if (DRY_RUN) {
    console.log(`[dry-run] createIssue: ${title}\n${body.slice(0, 500)}`);
    return { number: 0, html_url: '(dry-run)' };
  }
  return ghApi('POST', `/repos/${GH_REPO}/issues`, { title, body, labels });
}

function llmConfig() {
  if (LLM_API_KEY) {
    const base = (LLM_API_BASE || 'https://llm-api.amd.com/Anthropic').replace(/\/$/, '');
    return {
      url: `${base}/v1/messages`,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'dummy',
        'anthropic-version': '2023-06-01',
        'Ocp-Apim-Subscription-Key': LLM_API_KEY,
      },
      model: LLM_MODEL_NAME || 'Claude-Sonnet-4.5',
    };
  }
  if (ANTHROPIC_API_KEY) {
    const base = (ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
    return {
      url: `${base}/v1/messages`,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      model: ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-20250514',
    };
  }
  return null;
}

async function llmCall(system, user) {
  const cfg = llmConfig();
  if (!cfg) throw new Error('No LLM_API_KEY or ANTHROPIC_API_KEY configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: cfg.headers,
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 4096,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`LLM ${res.status}: ${t.slice(0, 500)}`);
    }
    const data = await res.json();
    return data?.content?.[0]?.text || '';
  } finally {
    clearTimeout(timer);
  }
}

function extractJsonArray(text) {
  const fence = text.match(/```(?:json|JSON|\w*)\s*\n([\s\S]*?)\n```/);
  if (fence) return fence[1].trim();
  const arr = text.match(/(\[[\s\S]*\])/);
  if (arr) return arr[1].trim();
  return text.trim();
}

function condenseFinding(issue) {
  const body = issue.body || '';
  const file = (body.match(/\*\*File\*\*:\s*`([^`]+)`/) || [])[1] || '';
  const cat = (body.match(/\*\*Category\*\*:\s*([^\n]+)/) || [])[1] || '';
  const sev =
    (issue.labels || [])
      .map((l) => (typeof l === 'string' ? l : l.name))
      .find((n) => n.startsWith('severity:')) || '';
  const findingMatch = body.match(/### Finding\s*\n+>\s*([\s\S]*?)(?:\n\n|### )/);
  const text = (findingMatch?.[1] || issue.title || '').replace(/\s+/g, ' ').trim();
  return {
    n: issue.number,
    state: issue.state,
    sev: sev.replace('severity:', ''),
    cat: cat.trim(),
    file,
    text: text.slice(0, 240),
  };
}

function buildSystemPrompt() {
  return `You cluster code review findings to find recurring root causes.

Input: a JSON array of condensed findings, each with { n, state, sev, cat, file, text }.

Task: produce a JSON array of clusters. Each cluster has:
- theme (string): a short, specific name for the recurring root cause (Chinese OK)
- count (integer): how many findings belong to this cluster
- issue_numbers (integer[]): the n values of belonging findings
- example_text (string): one of the underlying texts, illustrative
- suggested_action: one of "eslint_rule" | "agent_rule" | "doc_constraint" | "no_action"
- action_rationale (string): one or two sentences explaining the action choice

Rules:
- Cluster only when ≥ ${MIN_COUNT} findings clearly share the same root cause. Do not invent clusters.
- Findings that do not fit any cluster of size ≥ ${MIN_COUNT} should be omitted from output.
- Prefer specific themes over broad ones. "Missing input validation" is too broad.
  "Missing zod schema on POST endpoints" is good.
- "eslint_rule" only when the pattern is statically detectable (e.g. forbidden import, missing function call).
- "agent_rule" when it's a behavior the AI agent should know but lint cannot enforce (e.g. coding patterns, project conventions).
- "doc_constraint" when it belongs in plan/standards but doesn't translate cleanly into either above.
- "no_action" if the cluster is recurring but reflects intentional design or environmental noise.

Output STRICT JSON: just the array, no prose, no markdown fences.
If there are no clusters meeting the threshold, output [].`;
}

function buildClusterReport({ window, total, clusters, totalIssues }) {
  const lines = [
    CLUSTER_MARKER,
    `# Review-finding cluster report (${window} days)`,
    ``,
    `Window: 最近 ${WINDOW_DAYS} 天，共 ${totalIssues} 条 \`review-finding\` issue。`,
    `分组阈值：每簇 ≥ ${MIN_COUNT} 条；产出 ${clusters.length} 个簇 / 共 ${total} 条 issue。`,
    ``,
  ];
  if (clusters.length === 0) {
    lines.push(`本期未识别出达到阈值的高频聚类。`);
    return lines.join('\n');
  }
  clusters.sort((a, b) => b.count - a.count);
  for (const c of clusters) {
    const refs = (c.issue_numbers || []).map((n) => `#${n}`).join(' ');
    lines.push(`## ${c.theme}`);
    lines.push(``);
    lines.push(`- **count**: ${c.count}`);
    lines.push(`- **suggested action**: \`${c.suggested_action}\``);
    lines.push(`- **rationale**: ${c.action_rationale}`);
    lines.push(`- **example**: ${c.example_text}`);
    lines.push(`- **issues**: ${refs}`);
    lines.push(``);
  }
  lines.push(`---`);
  lines.push(``);
  lines.push(`**下一步建议**`);
  lines.push(``);
  lines.push(
    `- \`eslint_rule\` 簇：直接派 \`cursor:dispatch\` 给本 issue 让 agent 写规则到 \`eslint.config.mjs\`。`,
  );
  lines.push(
    `- \`agent_rule\` 簇：派 \`cursor:dispatch\` 让 agent 写到 \`.cursor/rules/\` 或 \`AGENTS.md\`。`,
  );
  lines.push(`- \`doc_constraint\` 簇：写到 \`docs/standards/\` 下对应文件。`);
  lines.push(`- \`no_action\` 簇：人工确认后批量打 \`auto-closed:wontfix\` 关闭即可。`);
  return lines.join('\n');
}

async function main() {
  const issues = await listFindings();
  console.log(`Pulled ${issues.length} review-finding issues from last ${WINDOW_DAYS}d`);

  if (issues.length < MIN_COUNT * 2) {
    console.log(`Too few findings (${issues.length}) for clustering, skipping`);
    return;
  }

  const condensed = issues.map(condenseFinding);
  const userPayload = JSON.stringify(condensed, null, 2);

  let raw;
  try {
    raw = await llmCall(buildSystemPrompt(), userPayload);
  } catch (err) {
    console.error('LLM call failed:', err.message);
    process.exit(1);
  }

  let clusters;
  try {
    clusters = JSON.parse(extractJsonArray(raw));
  } catch (err) {
    console.error('Failed to parse cluster output:', err.message);
    console.error('Raw (first 1000):', raw.slice(0, 1000));
    process.exit(1);
  }
  if (!Array.isArray(clusters)) {
    console.error('Cluster output is not an array');
    process.exit(1);
  }

  clusters = clusters.filter(
    (c) =>
      c &&
      typeof c.theme === 'string' &&
      Array.isArray(c.issue_numbers) &&
      (c.count || 0) >= MIN_COUNT,
  );

  const totalCovered = clusters.reduce((sum, c) => sum + (c.issue_numbers?.length || 0), 0);
  const yyyymm = new Date().toISOString().slice(0, 7);

  const body = buildClusterReport({
    window: WINDOW_DAYS,
    total: totalCovered,
    clusters,
    totalIssues: issues.length,
  });

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    const fs = await import('node:fs');
    await fs.promises.appendFile(summaryFile, body + '\n');
  }

  if (clusters.length === 0) {
    console.log('No clusters above threshold; not opening tracking issue');
    return;
  }

  // Re-run protection: if a cluster tracking issue for this month already
  // exists (workflow_dispatch ran twice in the same month, or schedule
  // happens to overlap), append a fresh report as a comment rather than
  // opening a duplicate issue.
  const existing = await findExistingClusterIssueForMonth(yyyymm);
  if (existing) {
    if (DRY_RUN) {
      console.log(`[dry-run] would append re-run report to existing #${existing.number}`);
    } else {
      await addIssueComment(
        existing.number,
        `<!-- review-cluster:rerun -->\n\n月度聚类重跑（${new Date().toISOString().slice(0, 16)}Z）。最新报告：\n\n${body}`,
      );
    }
    console.log(`Appended re-run to existing cluster issue #${existing.number}`);
    return;
  }

  const title = `[review-cluster] ${yyyymm}: ${clusters.length} high-frequency themes`;
  const issue = await createIssue(title, body, ['review-cluster']);
  console.log(`Cluster report posted: #${issue.number} ${issue.html_url}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
