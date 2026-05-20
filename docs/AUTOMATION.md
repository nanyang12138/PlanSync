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

## 三个 workflow 各自的职责

### 1. `.github/workflows/validate.yml` — 质量门槛

**触发**：每个 PR、每次 push 到 master、可手动跑（workflow_dispatch）。

**4 个并行 job**：

| Job | 内容 | 失败影响 |
|---|---|---|
| `lint` | `npx eslint packages/*/src` | 拦截 |
| `format-check` | `npx prettier --check packages/*/src/**` | 拦截 |
| `build` | `shared → mcp-server → cli → api` 顺序构建 | 拦截 |
| `test` | PG 16 容器 + `prisma migrate deploy` + `npm run test --workspaces` | 拦截 |

任何一个 job 失败 → auto-merge 不会触发，PR 保持 draft 等人工处理。

**为什么这样设计**：

- **`concurrency`**：同一个 PR 多次 push 时取消旧 run，省 minutes
- **PG service container**：避免依赖 `.local-runtime` 那一套（NFS / 集群路径）；用 GitHub 官方 postgres:16 image
- **port 15432**：和测试 setup.ts 里的默认端口一致，无需改测试代码
- **AUTH_DISABLED=true**：复用项目既有测试约定（注意：CI 上这是测试模式专用，不是生产配置）

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

### 3. `.github/workflows/cursor-review.yml` — AI 自动 code review

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

## 失败处理 / 安全栏

| 情况 | 系统响应 | 是否需要人工介入 |
|---|---|---|
| Cloud Agent 实现失败 / 编译不过 | validate.yml 红 → auto-merge 不触发，PR 留 draft | 是 |
| 测试 flaky 失败 | rerun 一次；仍失败 → 同上 | 是 |
| 实现破坏既有测试 | validate.yml 红 | 是（需要 revert 或修测试） |
| 修改了文档里其他条目（违反约束） | cursor-review 会标记；但 validate 不拦截 | 建议人工 |
| Critical 任务被自动合并 | **不应发生**：要求 prompt 加 do-not-merge | 立即 revert |
| Cron 调度过密 / Agent 太多并发 | 文档合并冲突 | Cursor Automatic 改 schedule 间隔 |

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
  - 必选：`validate / lint`、`validate / build`、`validate / test`
  - 可选：`cursor-review`
- ☑ Require branches to be up to date before merging
- ☑ Require linear history（配合 squash merge）
- ☐ Require pull request reviews before merging（**关掉**，否则 auto-merge 永远等人审批）
  - 如果想保留：勾选 ☑ Allow specified actors to bypass required pull requests，把 `cursor[bot]` 加进去

### Secrets and variables → Actions

| Secret name | 是否必须 | 用途 |
|---|---|---|
| `CURSOR_API_KEY` | 可选 | cursor-review.yml 需要 |
| `PLANSYNC_API_URL` | 已用 | plansync-check.yml（旧 workflow） |
| `PLANSYNC_API_KEY` | 已用 | plansync-check.yml（旧 workflow） |
| `PLANSYNC_PROJECT_ID` | 已用 | plansync-check.yml（旧 workflow） |

### General → Pull Requests

- ☑ Allow squash merging
- ☐ Allow merge commits（关掉）
- ☐ Allow rebase merging（关掉，保持 history 干净）
- ☑ Always suggest updating pull request branches
- ☑ Automatically delete head branches（合并后自动删 cursor/* 分支）

---

## 推进计划

1. **合本 PR**（CI 自动化基础设施）
2. **合 REMEDIATION_PLAN.md PR**（任务列表，#4）
3. **在 cursor.com 配置 Automatic**，用上面"推荐配置一"的 prompt
4. **手动跑一次**：先 trigger 一次验证全链路（task → PR → validate → auto-merge）
5. **观察一周**：看看是不是真的能稳定地每天合一个 PR
6. **正式上线**：根据观察调整 prompt 或 schedule

---

## 现有 `plansync-check.yml` 怎么办

那个 workflow 是用 `plansync/drift-check-action@v1` 做 PR drift gate 的，**和本套自动化没有冲突**。但 `docs/REMEDIATION_PLAN.md` 里 R-092、R-093、R-094 三条修复指出该 action 的 dist 没构建 + secret 没 mask + drift 范围太宽。等那三条做完，`plansync-check.yml` 才真正能 work。

短期内可以：

- 留着 `plansync-check.yml`，不会影响其他流水线（它要求的 secret 没配的话只是这个 job 失败，可以在 Branch protection 里不把它列为必需检查）
- 或把它改成 `if: secrets.PLANSYNC_API_URL != ''` 这样的条件，让缺 secret 时直接 skip
