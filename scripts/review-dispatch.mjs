#!/usr/bin/env node
/**
 * cursor-review-dispatch runner.
 *
 * Triggered by the workflow when an issue gets the `cursor:dispatch` label.
 * Spawns a Cursor Cloud Agent against this repo, asking it to fix the
 * triaged review-finding (or implement a clustered rule suggestion)
 * represented by the issue body. The agent opens its own PR
 * (autoCreatePR=true) on a deterministic `cursor/fix-rf-<n>-d31d` branch —
 * combined with `auto-merge-cursor-pr.yml`'s existing allow-list
 * (`cursor[bot]` + `cursor/*` branches), the loop closes when the PR
 * merges via `Fixes #<n>`.
 *
 * Accepted labels (must satisfy at least one, AND no `umbrella`):
 *   - `review-finding`   — single finding from triage
 *   - `review-cluster`   — themed cluster from monthly aggregator
 *
 * Idempotency: a `dispatched` label is added BEFORE calling the Cursor API.
 * Subsequent runs see that label and exit. Re-dispatch requires removing
 * both the `dispatched` and `cursor:dispatch` labels and re-applying
 * `cursor:dispatch`.
 *
 * Required env:
 *   GITHUB_TOKEN, GH_REPO, ISSUE_NUMBER, CURSOR_API_KEY
 *
 * Optional env:
 *   REVIEW_DISPATCH_BASE_REF (default: master)
 *   REVIEW_DISPATCH_MODEL    (Cursor model id, e.g. claude-4.5-sonnet-thinking)
 *   REVIEW_DISPATCH_DRY_RUN=1
 */
import { Buffer } from 'node:buffer';

const {
  GITHUB_TOKEN,
  GH_REPO,
  ISSUE_NUMBER,
  CURSOR_API_KEY,
  REVIEW_DISPATCH_BASE_REF,
  REVIEW_DISPATCH_MODEL,
  REVIEW_DISPATCH_DRY_RUN,
} = process.env;

if (!GITHUB_TOKEN || !GH_REPO || !ISSUE_NUMBER) {
  console.error('Missing required env: GITHUB_TOKEN, GH_REPO, ISSUE_NUMBER');
  process.exit(1);
}

const DRY_RUN = REVIEW_DISPATCH_DRY_RUN === '1' || REVIEW_DISPATCH_DRY_RUN === 'true';
const BASE_REF = REVIEW_DISPATCH_BASE_REF || 'master';
const DISPATCH_MARKER = '<!-- review-dispatch:agent -->';
const LOCK_LABEL = 'dispatched';
const FINDING_LABEL = 'review-finding';
const CLUSTER_LABEL = 'review-cluster';
const UMBRELLA_LABEL = 'umbrella';

async function ghApi(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'plansync-review-dispatch',
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

async function getIssue() {
  return ghApi('GET', `/repos/${GH_REPO}/issues/${ISSUE_NUMBER}`);
}

async function commentIssue(body) {
  if (DRY_RUN) {
    console.log(`[dry-run] commentIssue: ${body.slice(0, 200)}`);
    return null;
  }
  return ghApi('POST', `/repos/${GH_REPO}/issues/${ISSUE_NUMBER}/comments`, { body });
}

async function addLabels(labels) {
  if (DRY_RUN) {
    console.log(`[dry-run] addLabels: ${labels.join(', ')}`);
    return null;
  }
  return ghApi('POST', `/repos/${GH_REPO}/issues/${ISSUE_NUMBER}/labels`, { labels });
}

async function removeLabel(label) {
  if (DRY_RUN) {
    console.log(`[dry-run] removeLabel: ${label}`);
    return null;
  }
  // Best-effort: 404 just means the label was already gone, which is fine.
  try {
    return await ghApi(
      'DELETE',
      `/repos/${GH_REPO}/issues/${ISSUE_NUMBER}/labels/${encodeURIComponent(label)}`,
    );
  } catch (err) {
    if (String(err.message).includes(' -> 404')) return null;
    console.warn(`removeLabel(${label}) failed (non-fatal): ${err.message}`);
    return null;
  }
}

async function createCursorAgent({ prompt, branchName }) {
  if (!CURSOR_API_KEY) throw new Error('CURSOR_API_KEY not set');
  const auth = Buffer.from(`${CURSOR_API_KEY}:`).toString('base64');
  const body = {
    prompt: { text: prompt },
    repos: [
      {
        url: `https://github.com/${GH_REPO}`,
        startingRef: BASE_REF,
      },
    ],
    autoCreatePR: true,
    branchName,
  };
  if (REVIEW_DISPATCH_MODEL) {
    body.model = { id: REVIEW_DISPATCH_MODEL };
  }
  const res = await fetch('https://api.cursor.com/v1/agents', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      'User-Agent': 'plansync-review-dispatch',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cursor ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

function buildFindingPrompt(issue) {
  const issueUrl = issue.html_url;
  const issueBody = (issue.body || '').trim();
  return [
    `请修复以下代码评审 finding。`,
    ``,
    `**Issue**: ${issueUrl}`,
    `**Issue title**: ${issue.title}`,
    ``,
    `## Finding 详情`,
    ``,
    issueBody,
    ``,
    `---`,
    ``,
    `## 修复要求（强约束，请严格遵循）`,
    ``,
    `1. 严格按仓库的 \`CLAUDE.md\` / \`AGENTS.md\` / \`docs/standards/\` 规范工作；`,
    `   特别是 PlanSync exec-mode 工具白名单——不要尝试调用 \`plansync_plan_create\` 等 owner-only 工具。`,
    `2. **只动跟这个 finding 直接相关的代码**，不要顺手做无关的重构、重排序、风格 sweep。`,
    `3. 如果有清晰的可写测试场景，添加 vitest 单测；改动应尽量在变化点附近被覆盖。`,
    `4. PR 描述里**必须**写 \`Fixes #${ISSUE_NUMBER}\`（这样合并自动关掉本 issue）；并简述修复思路、影响范围、风险。`,
    `5. 如果判断这条 finding 是误报、无法复现、或修复风险大于收益：**不要硬修**。改为：`,
    `   - 在该 issue（#${ISSUE_NUMBER}）评论说明你的判断与依据；`,
    `   - 不要开 PR；`,
    `   - 直接结束本次执行。`,
    `6. 如果文件已被其他 PR 修掉 / 不存在：同上，issue 评论说明并结束，不开 PR。`,
    ``,
    `开始之前请用 plan mode 先描述你的思路并等待主流程接管。`,
  ].join('\n');
}

function buildClusterPrompt(issue) {
  const issueUrl = issue.html_url;
  const issueBody = (issue.body || '').trim();
  return [
    `请把以下高频 review-finding 聚类**沉淀成可复用的规则/约束**。`,
    ``,
    `**Issue**: ${issueUrl}`,
    `**Issue title**: ${issue.title}`,
    ``,
    `## Cluster 报告（含每簇的 suggested_action）`,
    ``,
    issueBody,
    ``,
    `---`,
    ``,
    `## 实施要求`,
    ``,
    `1. 逐簇按 \`suggested_action\` 决定落地位置：`,
    `   - \`eslint_rule\`     → 改 \`eslint.config.mjs\`，必要时安装 plugin（先在 PR 描述中说明依赖变化）。`,
    `   - \`agent_rule\`      → 写到 \`.cursor/rules/<topic>.mdc\` 或 \`AGENTS.md\` / \`CLAUDE.md\` 的相应小节。`,
    `   - \`doc_constraint\`  → 写到 \`docs/standards/\` 下对应文件，没有就新建。`,
    `   - \`no_action\`       → 跳过本簇，不要为它写任何东西。`,
    `2. **不要试图回过头去修复历史 finding 涉及的具体代码**——本任务只产出规则/文档；具体修复由各 finding 自己的 dispatch 处理。`,
    `3. 每个新增的 lint 规则必须配最小重现单测或 fixture（放在该 lint plugin 的常规位置；如不可行请在 PR 描述中说明）。`,
    `4. 如果某簇的 suggested_action 你判断不合理（比如 LLM 把不可静态化的东西归成了 \`eslint_rule\`），**不要硬上**——改为在该簇下方追加一段说明并降级为 \`doc_constraint\`，在 PR 中明确指出。`,
    `5. PR 描述必须 \`Fixes #${ISSUE_NUMBER}\`，并按簇列出"哪个簇落到了哪个文件"的对应表。`,
    `6. 严格遵循仓库的 \`CLAUDE.md\` / \`AGENTS.md\` / PlanSync exec-mode 工具白名单——不要调用 owner-only 工具。`,
    ``,
    `开始之前请用 plan mode 先描述你的实施思路（每簇打算改哪些文件）并等待主流程接管。`,
  ].join('\n');
}

function buildPrompt(issue, kind) {
  return kind === 'cluster' ? buildClusterPrompt(issue) : buildFindingPrompt(issue);
}

async function main() {
  const issue = await getIssue();
  if (issue.pull_request) {
    console.log('Target is a PR, not an issue, skipping');
    return;
  }
  if (issue.state !== 'open') {
    console.log(`Issue #${ISSUE_NUMBER} is not open (state=${issue.state}), skipping`);
    return;
  }

  const labelNames = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  const labelSet = new Set(labelNames);

  if (labelSet.has(UMBRELLA_LABEL)) {
    console.log('Refusing to dispatch umbrella issue (multi-finding).');
    await commentIssue(
      `${DISPATCH_MARKER}\n\n⚠ 本 issue 是 \`umbrella\`，包含多条 finding；单次 agent 修复无法处理。请先把其中需要的条目拆成独立 issue（直接复制条目内容并保留指纹）后再 \`cursor:dispatch\`。本次已忽略。`,
    );
    return;
  }

  const isCluster = labelSet.has(CLUSTER_LABEL);
  const isFinding = labelSet.has(FINDING_LABEL);
  if (!isCluster && !isFinding) {
    console.log(
      `Issue lacks both '${FINDING_LABEL}' and '${CLUSTER_LABEL}' labels, refusing to dispatch`,
    );
    return;
  }

  // Label-based idempotency lock. Acquired BEFORE the Cursor API call so a
  // duplicate webhook (or fast remove+re-add of cursor:dispatch) sees the
  // lock and exits without spawning a second agent. Avoids the comment
  // pagination corner case (per_page cap missing older markers) — the
  // labelSet here is built from the issue payload we already have.
  if (labelSet.has(LOCK_LABEL)) {
    console.log(`Already dispatched (label '${LOCK_LABEL}' present), skipping idempotently.`);
    return;
  }

  const branchName = `cursor/fix-rf-${ISSUE_NUMBER}-d31d`;
  const kind = isCluster ? 'cluster' : 'finding';
  const prompt = buildPrompt(issue, kind);

  if (DRY_RUN) {
    console.log('[dry-run] would dispatch:', { kind, branchName, baseRef: BASE_REF });
    console.log('[dry-run] prompt preview:\n' + prompt.slice(0, 500));
    return;
  }
  if (!CURSOR_API_KEY) {
    await commentIssue(
      `${DISPATCH_MARKER}\n\n⚠ \`cursor:dispatch\` 已打但 \`CURSOR_API_KEY\` 仓库 secret 未配置，无法启动 Cursor Cloud Agent。请先在 Settings → Secrets 添加。`,
    );
    process.exit(1);
  }

  // Acquire the lock label as the first mutation. addLabels is idempotent
  // server-side; the local short-circuit above relied on the issue snapshot
  // we fetched at the top. Two truly concurrent runs can both reach this
  // point, but only one will subsequently succeed at the Cursor API
  // (the second sees a duplicate-branchName conflict).
  await addLabels([LOCK_LABEL]);

  let result;
  try {
    result = await createCursorAgent({ prompt, branchName });
  } catch (err) {
    // The agent never started, so release the lock so a re-application of
    // `cursor:dispatch` (without manual label cleanup) auto-retries. This
    // is safe: if HTTP failed, the agent didn't get created — there is no
    // duplicate to worry about. If we removed the lock for a request that
    // actually succeeded server-side, the second attempt would still hit
    // Cursor's branchName uniqueness conflict and surface clearly.
    await removeLabel(LOCK_LABEL);
    await commentIssue(
      `${DISPATCH_MARKER}\n\n❌ 启动 Cursor Cloud Agent 失败：\n\n\`\`\`\n${err.message}\n\`\`\`\n\n已自动摘掉 \`${LOCK_LABEL}\` 锁。要重试：摘掉 \`cursor:dispatch\` 后重新打上即可。`,
    );
    throw err;
  }

  const agentId = result?.agent?.id || '(unknown)';
  const agentUrl = result?.agent?.url || '(unknown)';
  const runId = result?.run?.id || '(unknown)';

  await commentIssue(
    [
      DISPATCH_MARKER,
      `🚀 **Cursor Cloud Agent dispatched** (${kind})`,
      ``,
      `- agent: \`${agentId}\``,
      `- run: \`${runId}\``,
      `- branch: \`${branchName}\``,
      `- base ref: \`${BASE_REF}\``,
      `- watch: ${agentUrl}`,
      ``,
      `Agent 完成后会自动开 PR；PR body 包含 \`Fixes #${ISSUE_NUMBER}\`，PR 合并即关闭本 issue。`,
      `如果 agent 判断这条 finding 不该修，会以另一条评论说明并不开 PR——本 issue 仍保持 open，由人工决定关闭。`,
      `重 dispatch：先摘掉 \`${LOCK_LABEL}\` 和 \`cursor:dispatch\` 标签，再重新打上 \`cursor:dispatch\`。`,
    ].join('\n'),
  );

  console.log(`Dispatched ${agentId} (run ${runId}) on ${branchName} [${kind}]`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
