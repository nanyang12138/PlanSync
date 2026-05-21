#!/usr/bin/env node
/**
 * cursor-review-dispatch runner.
 *
 * Triggered by the workflow when an issue gets the `cursor:dispatch` label.
 * Spawns a Cursor Cloud Agent against this repo, asking it to fix the
 * triaged review-finding represented by the issue body. The agent opens its
 * own PR (autoCreatePR=true) on a deterministic `cursor/fix-rf-<n>-d31d`
 * branch — combined with `auto-merge-cursor-pr.yml`'s existing allow-list
 * (`cursor[bot]` + `cursor/*` branches), the loop closes when the PR
 * merges via `Fixes #<n>`.
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

async function listIssueComments() {
  return ghApi('GET', `/repos/${GH_REPO}/issues/${ISSUE_NUMBER}/comments?per_page=100`);
}

async function commentIssue(body) {
  if (DRY_RUN) {
    console.log(`[dry-run] commentIssue: ${body.slice(0, 200)}`);
    return null;
  }
  return ghApi('POST', `/repos/${GH_REPO}/issues/${ISSUE_NUMBER}/comments`, { body });
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

function buildPrompt(issue) {
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
  if (!labelNames.includes('review-finding')) {
    console.log('Issue lacks `review-finding` label, refusing to dispatch');
    return;
  }

  const comments = await listIssueComments();
  const already = comments.find((c) => c.body && c.body.includes(DISPATCH_MARKER));
  if (already) {
    console.log(`Already dispatched (comment #${already.id}); skipping idempotently.`);
    return;
  }

  const branchName = `cursor/fix-rf-${ISSUE_NUMBER}-d31d`;
  const prompt = buildPrompt(issue);

  if (DRY_RUN) {
    console.log('[dry-run] would dispatch:', { branchName, baseRef: BASE_REF });
    console.log('[dry-run] prompt preview:\n' + prompt.slice(0, 500));
    return;
  }
  if (!CURSOR_API_KEY) {
    await commentIssue(
      `${DISPATCH_MARKER}\n\n⚠ \`cursor:dispatch\` 已打但 \`CURSOR_API_KEY\` 仓库 secret 未配置，无法启动 Cursor Cloud Agent。请先在 Settings → Secrets 添加。`,
    );
    process.exit(1);
  }

  let result;
  try {
    result = await createCursorAgent({ prompt, branchName });
  } catch (err) {
    await commentIssue(
      `${DISPATCH_MARKER}\n\n❌ 启动 Cursor Cloud Agent 失败：\n\n\`\`\`\n${err.message}\n\`\`\`\n\n你可以摘掉 \`cursor:dispatch\` 标签后重新打上，重试 dispatch。`,
    );
    throw err;
  }

  const agentId = result?.agent?.id || '(unknown)';
  const agentUrl = result?.agent?.url || '(unknown)';
  const runId = result?.run?.id || '(unknown)';

  await commentIssue(
    [
      DISPATCH_MARKER,
      `🚀 **Cursor Cloud Agent dispatched**`,
      ``,
      `- agent: \`${agentId}\``,
      `- run: \`${runId}\``,
      `- branch: \`${branchName}\``,
      `- base ref: \`${BASE_REF}\``,
      `- watch: ${agentUrl}`,
      ``,
      `Agent 完成后会自动开 PR；PR body 包含 \`Fixes #${ISSUE_NUMBER}\`，PR 合并即关闭本 issue。`,
      `如果 agent 判断这条 finding 不该修，会以另一条评论说明并不开 PR——本 issue 仍保持 open，由人工决定关闭。`,
    ].join('\n'),
  );

  console.log(`Dispatched ${agentId} (run ${runId}) on ${branchName}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
