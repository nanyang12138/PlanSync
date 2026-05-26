# PlanSync 自动化流水线

> **目的**：让 `docs/REMEDIATION_PLAN.md` 里的 130 条修复任务被 Cursor Automatic 自动派发 → Cloud Agent 写代码 → GitHub Actions 把关 → 自动合并，全程无需人工点 button。

---

## 全景图

```
                 ┌────────────────────────────────┐
                 │ Cursor Automatic (cursor.com)  │
                 │ 周期任务：每天 02:00 UTC       │
                 └──────────────┬─────────────────┘
                                │ 派发 Cloud Agent
                                ▼
              ┌─────────────────────────────────┐
              │ Cloud Agent                     │
              │ 读 REMEDIATION_PLAN.md          │
              │ 找一个 pending + 依赖 done 的任务 │
              │ 实现 → push → 开 draft PR       │
              └──────────────┬──────────────────┘
                             │ PR opened
                             ▼
       ┌──────────────────────────────────────────────┐
       │ GitHub Actions:                              │
       │   • validate.yml  (lint + build + test)      │
       │   • cursor-review.yml  (AI code review)      │
       └─────────────────┬────────────────────────────┘
                         │ validate success
                         ▼
       ┌──────────────────────────────────────────────┐
       │ GitHub Actions: auto-merge-cursor-pr.yml     │
       │   ① 校验 PR author + branch 前缀             │
       │   ② 不在 do-not-merge label                  │
       │   ③ base = master                            │
       │   ④ gh pr ready (脱 draft)                   │
       │   ⑤ gh pr merge --auto --squash              │
       └──────────────────────────────────────────────┘
                         │
                         ▼
         合并 → Cloud Agent 回写 REMEDIATION_PLAN.md
                 把 R-XXX status: pending → done
                 （在下一个调度周期中）
```

---

## 三层 workflow 各自的职责

> 三层都是 **「PlanSync 这个工具特有的脆弱点 → 对应的检查」** 一一对应。下面每条都说清楚 _"如果不加这个检查，agent 会怎样把坏代码合进 master"_。

### 1. `.github/workflows/validate.yml` — 必过门槛（10 个 job）

**触发**：每个 PR、push 到 master、可手动跑。**任何一个 job 失败 → auto-merge 不触发**。

| Job               | 检查内容                                                                 | 没这个的话 agent 会怎么搞砸                                                           |
| ----------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `lint`            | `eslint packages/*/src --max-warnings 0`                                 | 不限 warning 时 agent 可以引入大量 warning 直到代码不可读                             |
| `format-check`    | prettier 校验源码 + 文档 + 配置文件                                      | 代码风格漂移                                                                          |
| `typecheck`       | `tsc --noEmit` × 4 workspace（mcp-server / cli / api / shared）          | **esbuild 不做类型检查**，TS bug 照样产出可运行 dist；只有 tsc 才能拦                 |
| `commitlint`      | 校验 PR 全部 commit message                                              | agent 不装 husky，commit message 可以乱写过                                           |
| `shellcheck`      | `scripts/` + `bin/` 所有 bash 脚本                                       | 用户日常入口都是 bash 脚本，agent 一行错语法直接卡 setup                              |
| `prisma-validate` | `prisma validate` + `prisma format` 幂等检查 + 拦截既有 migration 被改   | husky pre-commit 拦的事，CI 上不拦就漏                                                |
| `build`           | `shared → mcp-server → cli → api` 顺序构建，**并断言所有 dist 产物存在** | `cli` build 最后 `cp yoga.wasm` 这一步失败 esbuild 仍 exit 0（commit 874296b 就栽这） |
| `test`            | PG 16 service + `prisma migrate deploy` + `npm run test --workspaces`    | 单元 + 集成测试基础保障                                                               |
| `secret-scan`     | gitleaks 扫描提交历史                                                    | agent 误把 token 写进代码/日志                                                        |
| `audit`           | `npm audit --omit=dev --audit-level=high`                                | 生产依赖出 CVE，不被发现                                                              |

**关键设计点**：

- **`typecheck` 与 `build` 分开**：build 通过不代表没 TS 错误（esbuild 是 bundler 不是 compiler）；分开能精准定位失败。
- **`build` job 内逐个 dist 文件断言**：包括 `yoga.wasm` 头部 `\x00asm` 魔数校验 —— 不光验文件存在，验它是合法 wasm。
- **`prisma-validate` 跑 `prisma format` 幂等校验**：agent 手写迁移忘 format，本地 husky 不在 → CI 立即拦住。
- **`commitlint` 用 `--from BASE_SHA --to HEAD_SHA`**：只校验 PR 内提交，不影响历史。
- **每个 job 都有 `timeout-minutes`**：防止挂死烧 Actions 额度。
- **每个 job 都 `permissions: contents: read`**：最小权限。
- **`concurrency`**：同 PR 多次 push 取消旧 run。
- **PG service container** 用 port 15432：和 `tests/setup.ts` 默认值对齐，无需改测试代码。

---

### 2. `.github/workflows/auto-merge-cursor-pr.yml` — 自动合并

**触发**：`validate` workflow 完成事件（成功才进入条件分支）。

**5 层安全门**（任何一层未通过都安全退出 0，**不算失败**）：

1. **PR 解析**：从 `workflow_run.pull_requests[0]` 拿 PR 号，缺失时按 head branch fallback 查
2. **Author 白名单**：仅 `cursor[bot]` / `app/cursor` / `nanyang12138`，其他人开的 PR 不动
3. **Branch 前缀**：仅 `cursor/*`，普通分支不动
4. **`do-not-merge` 标签**：任何 collaborator 加这个 label 就立即跳过
5. **Base 分支**：仅合到 `master` / `main`，不会误合到任何特性分支

通过后：

- 若 PR 还是 draft → `gh pr ready`
- 然后 `gh pr merge --auto --squash`：注意 `--auto` 表示**等待所有 required checks 通过再合**，所以即便 validate 全绿，如果你在仓库 Settings 里还配了别的必需检查（如 `cursor-review`），它仍会等

> **如何让某个 PR 永不被自动合并**：在 PR 上加一个名为 `do-not-merge` 的 label 即可。
>
> **如何彻底关掉自动合并**：把 workflow 文件改名或注释掉 `on:` 部分；或把当前用户从 author 白名单移除。

---

### 3. `.github/workflows/pr-guards.yml` — 软拦截（自动加 `do-not-merge` label）

**触发**：PR opened / synchronize / reopened / ready_for_review。

**不 fail CI**，但发现风险时给 PR 打上 `do-not-merge` label，**让 auto-merge workflow 已实现的 opt-out 机制接管**：

| Job                     | 触发条件                                                                                                                | 后果                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pr-size`               | 代码改动 > 1000 行 **或** 涉及文件 > 50 个（**排除 docs / lockfile / 二进制资源**）                                     | label `do-not-merge` + `oversized-pr` + 评论解释                         |
| `destructive-migration` | 新增 migration 含 `DROP TABLE/COLUMN/CONSTRAINT/INDEX` / `TRUNCATE` / `ALTER TYPE` / `ALTER COLUMN ... TYPE` / `RENAME` | label `do-not-merge` + `destructive-migration` + 评论列出匹配文件        |
| `workflow-modification` | 改了 `.github/workflows/*.yml`                                                                                          | label `do-not-merge` + `workflow-change`（防止 CI 自我修改链）           |
| `dependency-review`     | PR 引入含高危 CVE 的新依赖 / 非许可证许可的依赖                                                                         | fail（这条是 fail，因为 GitHub Dependency Review action 就是设计为阻断） |

**为什么用 label 而不是 fail CI**：

- 风险型 PR 仍然需要 validate 跑完看其他 job 是否通过
- 人工 review 后只要移除 label，auto-merge workflow 会在下次 validate 完成时自然接管
- 不会把 PR 直接打回，agent 能拿到完整 CI 反馈

### 4. `.github/workflows/nightly.yml` — 定时跑、不阻断 PR

**触发**：每天 UTC 03:00 cron + 手动 dispatch。

| Job          | 内容                                                                       | 失败后果                                                                  |
| ------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `e2e`        | 启 Next.js 真服务 → `vitest --config vitest.e2e.config.ts`（660s timeout） | 自动开 `nightly-e2e-fail` label 的 issue（去重，已开就不重复）            |
| `full-audit` | `npm audit --json` 全严重度报告                                            | 有 high/critical 就开 `nightly-audit-fail` issue + 上传完整 JSON artifact |

**为什么把 e2e 放 nightly**：

- e2e 测试需要起完整 Next.js server、跑 60+s，放 PR 每个都跑会让 CI 慢得人神共怒
- e2e 本身有一定 flakiness（globalSetup 660s timeout 已说明），fail 后误以为 PR 有问题反而误导
- nightly 每天一次，足够及时发现新 master 上的回归

### 5. `.github/workflows/issue-auto-triage.yml` — `severity:must` 积压自动分流

**触发**：每 20 分钟 cron（`*/20 * * * *`）+ 手动 `workflow_dispatch`（可调 `max_dispatch` / `max_close` / `mode`）。20 分钟来自一次实测：以默认 `TRIAGE_MAX_DISPATCH=3`/run 计，72 run/天 × 3 = 最多 216 dispatch/天，足以在 ~2 天内消化 400 条积压；如果要进一步加速，临时把 `TRIAGE_MAX_DISPATCH` 调高，**不要再缩短 cron 间隔**（GitHub Actions cron 高峰期会 delay 5–15 分钟，\*/20 是稳定运行的下限）。

**做什么**：跑 `scripts/issue-auto-triage.mjs`，把所有 open 的 `severity:must` issue 分类成五桶并立即执行对应动作：

| 桶                 | 判定依据                                                                                                                                                                      | 动作                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `resolved-by-pr`   | 已被某个近 14 天合入的 PR body 用 `closes #N` 引用，但 GitHub 的 squash-auto-close 没触发（最常见原因：markdown bold 包了 `closes`、PR 一行 closes 列表超长被截断）           | 评论 + `gh issue close --reason completed` + 加 `auto-triaged` label                                                               |
| `resolved-in-tree` | 命中静态 probe，确认代码已经是期望形态                                                                                                                                        | 同上                                                                                                                               |
| `phantom`          | 命中静态 probe，确认 issue 描述的代码路径在本仓库根本不存在（review agent 幻觉）                                                                                              | 评论 + `wontfix` label + close as not_planned                                                                                      |
| `dispatch`         | 既没在飞，也没被任何 probe 命中 → 真的需要人/agent 处理                                                                                                                       | 加 `cursor:dispatch` label（已有 `cursor-review-dispatch.yml` 接管）+ `auto-triaged` label。受 `TRIAGE_MAX_DISPATCH`（默认 3）限流 |
| `skip`             | 已有 `cursor:dispatch` / `dispatched` / `umbrella` / `wontfix` / `auto-triaged` / `needs-human` / `do-not-merge` 任一 label，或被某个**仍打开**的 PR body 用 `closes #N` 引用 | 什么都不做                                                                                                                         |

**配置要求（重要 — 否则 dispatch 段会哑火）**：

仓库 Secrets 必须有 `CURSOR_REVIEW_PAT`（fine-grained PAT，scope = `issues: write` on this repo）。原因：GitHub 默认 `GITHUB_TOKEN` 加 label 触发的 `issues: labeled` 事件**会被 GitHub 静默丢弃**（防 workflow 递归），导致下游 `cursor-review-dispatch.yml` 看不到事件、不会启动 Cursor Cloud Agent。脚本里 `dispatchIssue` 用 `triggersDownstreamWorkflow: true` 把 `cursor:dispatch` 这一步路由到 `ghAsUser()` helper，再注入 PAT 写 label —— PAT 会被认为是真实用户身份，事件会正常派发。

没有 PAT 时脚本仍然能跑（fallback 到 GITHUB_TOKEN + 一行 warning），表面上 label 也加上了，但 **Cursor agent 永远不会被 spawn**。生产事故现场：2026-05-26 第一次 apply run 关了 25 个 issue、派出 3 个 dispatch label，但 `cursor-review-dispatch` workflow 一次都没跑过。

**为什么这层有意义**：

- review-finding 流水线每天会新开 10-30 个 `severity:must` issue，绝大部分都是同一个 finding 被不同 PR 的 review pass 反复举报。这个 workflow 在不需要 LLM 的情况下，通过两个确定性信号（**closes-keyword 扫描** + **静态代码 probe**）就能把可关掉的关掉、需要 agent 修的派出去，把剩下的留给人工。
- 任何写动作（close、label、comment）失败都不会中止其它 issue 的处理。整个流程是幂等的：每个 issue 处理后会被打上 `auto-triaged` label，下一轮 cron 自动跳过；CI 重跑也不会重复评论。
- `cursor:dispatch` 的限流（默认每轮 3 个）避免 Cursor API 配额被一晚上烧光。需要紧急加速时手动跑 `workflow_dispatch` 并把 `max_dispatch` 调高。

**如何加新的 probe**（最常见的扩展场景）：

在 `scripts/issue-auto-triage.mjs` 的 `PROBES` 数组里加一个对象：

```js
{
  id: 'verification-rules-not-implemented',
  match: (issue) => /\/explain rule|verification-rules/i.test(issue.title),
  verify: () => {
    const matches = !rg('explainRule|/explain rule', ['packages/cli/src']);
    return {
      matches,
      evidence: matches
        ? 'rg explainRule packages/cli/src → no match'
        : 'rg explainRule packages/cli/src → matches (feature is implemented)',
    };
  },
  verdict: 'phantom',  // or 'resolved-in-tree'
  reason: 'Reviewer flagged a /explain rule auth bug on a CLI command that has never been implemented.',
},
```

每个 probe 必须做"代码侧实证"，不能只是 title 匹配 —— 这样写错了也只是漏掉一类，不会误关一个真 bug。

`scripts/issue-auto-triage.test.mjs` 有 6 个单元测试，覆盖 closing-keyword 正则、null/undefined 安全、SKIP_LABELS 完整性、关键内部名（`PROBES` / `categorize`）的静态源码守护，确保未来重构不会悄悄破坏分类逻辑。

### 6. `.github/workflows/cursor-review.yml` — AI 自动 code review

**触发**：

- PR opened / synchronize / reopened
- 在 PR 评论中输入 `/cursor-review`、`/cursor-ask`、`/cursor-improve`、`/cursor-describe`、`/cursor-help`（仅 OWNER/MEMBER/COLLABORATOR 可触发）

**前置**：仓库 Settings → Secrets → Actions 加 `CURSOR_API_KEY`。

**特性**：

- **没设 secret 时自动 skip**，不会 fail（不影响 auto-merge）
- 中文输出（`language: zh-CN`）
- 用 `model: auto` 让 Cursor 自动选模型

---

## 在 Cursor Automatic 端怎么配

**Cursor Automatic 是 Cursor 网页端的功能**（cursor.com → Automations / Cron），不在本仓库里。本仓库提供的是它的"消费品"：一份机读 backlog（`docs/REMEDIATION_PLAN.md`）+ 接收 PR 的 CI。

### 推荐配置一：单条派发（最稳）

> 一次只让 Cursor 处理 1 个任务，避免并发改同一文件冲突。

**Schedule**：`0 2 * * *`（每天 UTC 02:00）

**Prompt 模板**：

```
仓库：nanyang12138/PlanSync 分支 master
任务：从 docs/REMEDIATION_PLAN.md 里挑一个可执行的修复任务并实现。

执行步骤：

1. 读 docs/REMEDIATION_PLAN.md
2. 找到第一个满足以下条件的条目（R-XXX）：
   - status: pending
   - 所有 depends_on 列出的条目 status: done
   - batch 当前最优先（B1 > B2 > ... > B12）
3. 在文档中把该条目的 status 改为 in_progress（先 commit 这一改动）
4. 严格按照该条目的 fix_steps 实现代码改动
5. 按照 verification 字段加测试（必须新增至少一个 vitest 用例）
6. 跑 bash scripts/test.sh 或 npm run test 确认通过
7. 开 draft PR：
   - 标题：fix(R-XXX): <条目标题>
   - 描述：完整复述该条目的 root_cause / fix_steps / verification
   - branch：cursor/R-XXX-<short-slug>
8. PR opened 后再 commit 一次：把该条目 status 改为 in_progress
   且添加 closed_in: <PR URL> 字段
9. 任务结束。GitHub Actions 会自动合并，合并后下一次 cron 把 status 改 done。

约束（必须遵守）：

- 永远不要在同一个 PR 里实现多个 R-XXX
- 永远不要修改文档中其他条目的 status
- 严重度 CRITICAL 的条目只把 status 改 in_progress，不要让 auto-merge 介入：
  在 PR 上手动加 do-not-merge label 等待人工 review
- 任何 fix_steps 不清楚就把 status 改 blocked 并在 PR 里说明
```

### 推荐配置二：每天派发 3 个（更快但要小心冲突）

如果想加速 burn-down，把 schedule 改成 `0 2 * * *` 同时启动 3 个 Cloud Agent，但要在 prompt 里加：

```
额外约束：
- 拿到任务后立即 git checkout -b 你的分支，先 push 一个空 commit 占位
- 实现完成后 git rebase origin/master 确保是最新
- 文档冲突时优先合并（保留所有 in_progress 标记）
```

---

## 失败处理 / 安全栏（针对每种风险有明确响应）

| 风险场景                                   | 哪一层拦住                                           | 后续                                      |
| ------------------------------------------ | ---------------------------------------------------- | ----------------------------------------- |
| TS 类型错误                                | `validate / typecheck`                               | PR 红，agent 看到错误自己改               |
| esbuild build 漏文件（如 yoga.wasm）       | `validate / build` 的产物断言                        | PR 红                                     |
| Bash 脚本语法错                            | `validate / shellcheck`                              | PR 红                                     |
| Commit message 不符合 conventional commits | `validate / commitlint`                              | PR 红                                     |
| schema.prisma 未 format                    | `validate / prisma-validate`                         | PR 红                                     |
| **修改了既有 migration**                   | `validate / prisma-validate`                         | PR 红                                     |
| 测试失败 / flaky                           | `validate / test`                                    | PR 红（人工 rerun）                       |
| 引入 token / 密钥到代码                    | `validate / secret-scan`                             | PR 红                                     |
| 引入高危 CVE 依赖                          | `validate / audit` + `pr-guards / dependency-review` | PR 红                                     |
| **PR 超大（>1000 LOC 或 >50 files）**      | `pr-guards / pr-size`                                | label `do-not-merge` → auto-merge 跳过    |
| **破坏性 migration（DROP/TRUNCATE 等）**   | `pr-guards / destructive-migration`                  | label `do-not-merge` → 人工 review        |
| **改了 workflow 自身**                     | `pr-guards / workflow-modification`                  | label `do-not-merge` → 人工 review        |
| Agent 写错 commit type                     | commitlint 拦                                        | PR 红                                     |
| Agent 改了别的条目 status                  | 没有 CI 拦截（合理范围内）                           | cursor-review 会标注；建议 prompt 强约束  |
| CRITICAL 任务被自动合并                    | prompt 要求 agent 主动加 `do-not-merge`              | 不应发生；发生立刻 revert                 |
| Cron 调度过密 / 并发改同一文件             | merge conflict → PR 卡                               | Cursor Automatic 改 schedule 间隔         |
| Agent 跑 e2e 跑不通的代码                  | 不会被 PR 拦（e2e 在 nightly）                       | nightly 失败开 issue                      |
| Agent 实现踩坑（如 fail-soft 太宽）        | validate 全过但人工感知到                            | revert + 在 REMEDIATION_PLAN 记录到原条目 |

### 紧急停机

任一办法都能立刻停止整套自动合并：

1. **PR 级别**：给 PR 加 `do-not-merge` label
2. **批次级别**：在 Cursor Automatic 控制台暂停那个 schedule
3. **全局级别**：把 `auto-merge-cursor-pr.yml` 顶部 `on:` 改成 `on: workflow_dispatch:`，提交一次空 commit 关闭自动触发

---

## 仓库设置建议（一次性配置）

打开 GitHub → Settings：

### Branches → Branch protection rules → master

- ☑ Require status checks to pass before merging
  - **必选**（validate.yml 全部 10 个 job）：
    - `validate / lint`
    - `validate / format-check`
    - `validate / typecheck`
    - `validate / commitlint`
    - `validate / shellcheck`
    - `validate / prisma-validate`
    - `validate / build`
    - `validate / test`
    - `validate / secret-scan`
    - `validate / audit`
  - **可选**：`cursor-review`、`pr-guards / dependency-review`
  - **不要列为必选**：`plansync-check`（旧的 drift gate，等 R-092/093/094 修完再启用）
- ☑ Require branches to be up to date before merging
- ☑ Require linear history（配合 squash merge）
- ☐ Require pull request reviews before merging（**关掉**，否则 auto-merge 永远等人审批）
  - 如果想保留：勾选 ☑ Allow specified actors to bypass required pull requests，把 `cursor[bot]` 加进去

### Labels → 预创建（pr-guards 会用到）

- `do-not-merge`（红色）— 任何 collaborator / pr-guards 加上 → auto-merge 立刻退出
- `oversized-pr` — pr-size guard 加
- `destructive-migration` — destructive-migration guard 加
- `workflow-change` — workflow-modification guard 加
- `nightly-e2e-fail` / `nightly-audit-fail` — nightly 自动开 issue 用

### Security & analysis（必开）

- ☑ **Dependency graph** — `pr-guards / dependency-review` 需要它才能跑（没开则自动 skip + warning）
- ☑ **Dependabot alerts**（可选）— 加上更安心
- ☐ Dependabot security updates / version updates — 暂不需要（避免 dependabot PR 进入自动合）

### Secrets and variables → Actions

| Secret name           | 是否必须 | 用途                              |
| --------------------- | -------- | --------------------------------- |
| `CURSOR_API_KEY`      | 可选     | cursor-review.yml 需要            |
| `PLANSYNC_API_URL`    | 已用     | plansync-check.yml（旧 workflow） |
| `PLANSYNC_API_KEY`    | 已用     | plansync-check.yml（旧 workflow） |
| `PLANSYNC_PROJECT_ID` | 已用     | plansync-check.yml（旧 workflow） |

### General → Pull Requests

- ☑ Allow squash merging
- ☐ Allow merge commits（关掉）
- ☐ Allow rebase merging（关掉，保持 history 干净）
- ☑ Always suggest updating pull request branches
- ☑ Automatically delete head branches（合并后自动删 cursor/\* 分支）

---

## 推进计划

1. **合本 PR**（CI 自动化基础设施）
2. **合 REMEDIATION_PLAN.md PR**（任务列表，#4）
3. **在 cursor.com 配置 Automatic**，用上面"推荐配置一"的 prompt
4. **手动跑一次**：先 trigger 一次验证全链路（task → PR → validate → auto-merge）
5. **观察一周**：看看是不是真的能稳定地每天合一个 PR
6. **正式上线**：根据观察调整 prompt 或 schedule

---

## 已知受控放宽（重要 — 否则你会以为这些是 bug）

下面两处不是"漏拦"，是**有意识地降级**等独立 PR 升级后再收紧。每一处都被 REMEDIATION_PLAN 跟踪：

1. **validate / audit 用 `--audit-level=critical`，不是 `high`**

   - 原因：Next.js 14.2.x 残留 2 个 high CVE（cache poisoning + middleware bypass），只能升 Next 16 才能修。如果当前要求 high，所有 PR 永久红，cron 死锁。
   - 兜底：`nightly.yml` 仍用 high+ 全扫，发现就开 issue。
   - 跟踪：`docs/REMEDIATION_PLAN.md` R-131（升 Next 16 后改回 high）。

2. **validate / typecheck 不跑 mcp-server**

   - 原因：`@modelcontextprotocol/sdk@1.3.0` + Zod 3.x + TS 5.7 触发 TS2589（深度类型实例化爆炸），即使给 8 GB heap 仍 OOM。
   - 兜底：mcp-server 的 build 通过 esbuild 至少保证 syntax / module 解析正确；tests 跑得通。
   - 跟踪：`docs/REMEDIATION_PLAN.md` R-132（升 SDK 1.29+ 后恢复 typecheck）。

3. **ESLint `no-explicit-any` 规则关闭**
   - 原因：~27 处历史 `any` 用法（错误对象、AI prompt 入参、SDK 边界），全部改 `unknown` 是独立工程。
   - 兜底：`@typescript-eslint/no-unused-vars` 仍是 warn，新增 unused 变量会被拦。
   - 跟踪：`docs/REMEDIATION_PLAN.md` R-133（逐步消除 `any`，恢复规则）。

## 现有 `plansync-check.yml` 怎么办

那个 workflow 是用 `plansync/drift-check-action@v1` 做 PR drift gate 的，**和本套自动化没有冲突**。但 `docs/REMEDIATION_PLAN.md` 里 R-092、R-093、R-094 三条修复指出该 action 的 dist 没构建 + secret 没 mask + drift 范围太宽。等那三条做完，`plansync-check.yml` 才真正能 work。

短期内可以：

- 留着 `plansync-check.yml`，不会影响其他流水线（它要求的 secret 没配的话只是这个 job 失败，可以在 Branch protection 里不把它列为必需检查）
- 或把它改成 `if: secrets.PLANSYNC_API_URL != ''` 这样的条件，让缺 secret 时直接 skip
