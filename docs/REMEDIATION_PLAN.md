# PlanSync 修复路线图（Remediation Plan）

> **文档用途**：这是一份**可被 cron job 或自动化代理逐条消费**的修复清单，覆盖 2026-05-20 全量代码审计 + 2026-05-22 架构审计追加发现的所有问题（共 **181 条**，按 R-XXX 唯一 ID 编号；详见附录 A）。
>
> 每个条目都是**自包含、可独立验证**的工程任务，带稳定 ID、依赖关系、修复步骤和验证方法。

---

## 目录

1. [如何使用本文档（cron job / 代理消费指南）](#如何使用本文档)
2. [严重度与优先级框架](#严重度与优先级框架)
3. [批次划分总览](#批次划分总览)
4. [修复条目清单](#修复条目清单)
   - [B1 — Drift 进程中止与 AI 自处理消除](#b1--drift-进程中止与-ai-自处理消除)
   - [B2 — 执行所有权与凭证收紧](#b2--执行所有权与凭证收紧)
   - [B3 — MCP 客户端重连与重试](#b3--mcp-客户端重连与重试)
   - [B4 — 契约统一（shared ↔ API ↔ MCP ↔ Prisma）](#b4--契约统一)
   - [B5 — 嵌套资源 plan-project 一致性](#b5--嵌套资源-plan-project-一致性)
   - [B6 — 并发与唯一性](#b6--并发与唯一性)
   - [B7 — CLI 体验对齐文档](#b7--cli-体验对齐文档)
   - [B8 — 数据库索引、enum、FK](#b8--数据库索引enumfk)
   - [B9 — 事件总线生产可用](#b9--事件总线生产可用)
   - [B10 — 文档与脚本对齐](#b10--文档与脚本对齐)
   - [B11 — Activity log 与可观测性](#b11--activity-log-与可观测性)
   - [B12 — 测试补齐](#b12--测试补齐)
5. [Cron Job 调度建议](#cron-job-调度建议)
6. [附录 A — 完整问题索引（按 ID）](#附录-a--完整问题索引)
7. [附录 B — 已修复/已过期的旧报告条目](#附录-b--已修复已过期的旧报告条目)

---

## 如何使用本文档

### 条目格式

每个修复任务用如下格式描述：

```
### R-XXX [严重度] 标题
- **status**: pending | in_progress | done | blocked | cancelled
- **batch**: B1..B18
- **depends_on**: R-YYY, R-ZZZ
- **effort**: small (<2h) | medium (2-8h) | large (>1d)
- **files**: 受影响的文件路径列表
- **symptom**: 用户看到的现象
- **root_cause**: 一句话说清根因
- **fix_steps**: 1) ... 2) ... 3) ...
- **verification**: 怎么验证修好了（含具体测试用例）
- **rollback**: 如果出问题如何回滚
```

> **status 枚举权威定义**：
>
> - `pending` — 等待 cron 取项
> - `in_progress` — agent 已开 PR，等待合并
> - `done` — PR 已合并，目标行为已落地
> - `blocked` — 依赖外部修复或拆分中，cron 不取
> - `cancelled` — 已被 `supersedes` 链上的另一条目取代，**等同于 done**
>   作为 `depends_on` 满足条件（见下方 cron 解析约定）

### 给 cron job 的解析约定

- **ID 稳定**：`R-XXX` 永不复用，已完成的任务标 `status: done` 或 `cancelled` 而不删除。
- **依赖图（唯一权威源）**：cron 调度时**只看 `depends_on` 字段**。其全部条目为 `done` 或 `cancelled` 的 `pending` 条目即可 pickup。
  - 把 `cancelled` 视为依赖满足是为了避免 supersedes 链断裂：当 R-X.supersedes: R-Y 被 pickup 时 R-Y 被置为 cancelled，否则任何 `depends_on: R-Y` 的下游会永久阻塞。
  - `blocked` 与 `in_progress` **不**视为满足，避免在拆分中或外部依赖未到位时启动后继。
- **同一批次内可并行**：除非显式 `depends_on`。
- **跨批次调度**：**完全由 `depends_on` 决定**，不存在"B1 必须先于 B2"或"按字母顺序"的兜底。批次号仅用于人类阅读分组。

#### 去重 / 过渡 / 取代的三种字段语义

为了让 cron 自动化既能去重，又不会把"过渡条目"误杀，本文档使用三个互斥字段（**最多只能出现一个**）：

| 字段                    | 取值                                | cron 行为                                                                                                           | 典型用途                                                      |
| ----------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `superseded_by: R-YYY`  | 单个 R-ID（**机读，不带说明文本**） | **强语义**：cron **必须跳过**本条，无条件优先 pickup `R-YYY`。                                                      | 同目标的两条条目，新条目完全取代旧条目（如 R-144 → R-182）。  |
| `interim_for: R-YYY`    | 单个 R-ID                           | **弱语义 / 过渡条目**：仅当 `R-YYY.status ∈ {in_progress, done, cancelled}` 时 cron 跳过本条；否则本条仍可 pickup。 | 终态方案未启动前的过渡补丁（如 R-138/R-139/R-088 → 等 B14）。 |
| `supersedes: R-YYY[,…]` | 一个或多个 R-ID                     | cron pickup 本条时，**必须**把列出的每个 `R-YYY` 状态置为 `cancelled` 并加 `cancelled_by: R-本条` 字段。            | 终态方案对应的"宣告取代"链（如 R-182.supersedes: R-144）。    |

> **机读约束**：以上三个字段的值**必须只包含 R-ID（与逗号分隔）**，不允许内嵌中文说明或括号注释；如需补充说明，写到 `note` 字段或正文段落，不要污染机读字段。
>
> **互斥约束**：单条目最多只能出现以上三个字段之一。`scripts/lint-remediation.mjs` 在 CI 中强制此规则。
>
> **interim_for + depends_on 约束**：声明 `interim_for: R-Y` 的过渡条目**不应**同时把 `R-Y` 的同批次依赖（如 R-Y 本身的 `depends_on`）当作本条的 `depends_on`——否则当 R-Y 完成后过渡条目仍可能被错误地保留。规范是：过渡条目只声明 `interim_for: R-Y`，依赖只声明真正要求的前置 R-ID。
>
> 本规范在 2026-05-22 第二轮修订中引入；之前版本 `superseded_by` 的"软语义"用法已统一迁移到 `interim_for`。

### 推荐的 cron job 工作流

```bash
# 每天凌晨触发（伪代码，实际实现见文末 §Cron Job 调度建议）：
1. git pull origin master
2. 解析 docs/REMEDIATION_PLAN.md，对每个 #### R-XXX 段落抽取：
     status, depends_on, superseded_by, interim_for, supersedes, severity
3. 过滤候选集合：
     status == 'pending'
     AND superseded_by 为空                                # 强取代：直接跳过
     AND ( interim_for 为空
           OR lookup(interim_for).status NOT IN {in_progress, done, cancelled} )  # 过渡条目仅在终态未启动且未放弃时保留
     AND ALL(d in depends_on : lookup(d).status IN {done, cancelled})  # 依赖必须 done 或 cancelled（supersedes 链）
4. 按严重度（CRITICAL > HIGH > MEDIUM > LOW）降序排序后取最高优先级的 N 个；同等严重度时按 R-ID 自然序兜底
5. 为每个任务调用 cursor agent / Cloud Agent 执行；agent 必须：
     - 在开 PR 之前，若本条声明了 supersedes，把列出的每个 R-YYY 状态置为
       'cancelled' 并 commit（避免下一次 cron 仍把 R-YYY 当 pending）
     - 把本条 status: pending → in_progress + closed_in: <PR URL>
     - PR 合并后再改为 status: done
```

### 状态字段维护规则

- **agent 接手时**：把 `status: pending` 改为 `status: in_progress` 并 commit
- **PR 合并后**：把 `status: in_progress` 改为 `status: done`，加 `closed_in: PR#123`
- **发现需要拆分**：保持原条目 `status: blocked`，新增子条目 `R-XXX.a`, `R-XXX.b`
- **被 supersedes 取代**：`status: cancelled`，加 `cancelled_by: R-YYY`（指向取代它的条目）。cron 把 `cancelled` 视作 `done` 的等价依赖满足态，避免下游永久阻塞。

---

## 严重度与优先级框架

| 严重度       | 含义                               | 处理时限建议    |
| ------------ | ---------------------------------- | --------------- |
| **CRITICAL** | 数据损坏/越权/生产可见性失效       | 立即（独立 PR） |
| **HIGH**     | 功能行为严重不符预期、影响日常使用 | 一周内          |
| **MEDIUM**   | 边界情况、性能、UX 退化            | 一月内          |
| **LOW**      | 文档、命名、轻微体验               | 顺手修          |

---

## 批次划分总览

| 批次    | 主题                           | 条目数 | 关键交付                                  |
| ------- | ------------------------------ | ------ | ----------------------------------------- |
| **B1**  | Drift 进程中止与 AI 自处理消除 | 8      | 用户最痛的"rebind 后旧进程仍完成"彻底修好 |
| **B2**  | 执行所有权与凭证收紧           | 12     | 关闭跨用户劫持 run、master secret 滥用    |
| **B3**  | MCP 客户端重连与重试           | 6      | 解决"Not connected" 间歇失败              |
| **B4**  | 契约统一                       | 14     | shared/API/MCP schema drift 阻断          |
| **B5**  | 嵌套资源一致性                 | 7      | 跨项目越权读写关闭                        |
| **B6**  | 并发与唯一性                   | 11     | 多 active plan、重复 drift、TOCTOU        |
| **B7**  | CLI 体验对齐文档               | 16     | banner、phase、exec 入口、Ink 体验        |
| **B8**  | DB 索引/enum/FK                | 13     | 性能与数据完整性                          |
| **B9**  | 事件总线生产可用               | 4      | 多实例 SSE 不再丢消息                     |
| **B10** | 文档与脚本对齐                 | 12     | 删过期文档、补 env、平台兼容              |
| **B11** | Activity log 与可观测性        | 10     | 状态变更全部审计                          |
| **B12** | 测试补齐                       | 18+    | 关键路径回归保障                          |
| **B13** | Plan-as-code（结构化 plan 图） | 8      | 把 String[] plan 升级为可 FK 的关系图     |
| **B14** | Outbox + 持久事件流            | 7      | 干掉 in-memory EventBus / webhook 队列    |
| **B15** | Protocol-as-state-machine      | 7      | CLAUDE.md prose → MCP server 状态机强制   |
| **B16** | AI 从 gate 变 advisor          | 5      | 消除"AI 错杀合法提交"，引入声明式 rule    |
| **B17** | Git 真集成                     | 4      | task 状态由 PR/commit 推导，不再自报      |
| **B18** | Service 拆分 + view-model 共享 | 4      | API/Worker/Web 三进程，三 surface 单数据  |

> **新批次依赖关系**（最终权威以每条 `depends_on` 为准；下方为人类阅读摘要）：
>
> - B13 ← 入口 R-150 独立可启动；是 B17 的前置
> - B14 ← 入口 R-160 独立可启动；是 B15/B16/B17/B18 的事件层前置
> - B15 ← 入口 R-170/R-171 独立可启动；R-172/R-173/R-174 依赖 R-146（prompt 合并）
> - B16 ← R-180 依赖 R-143（AI observability 落地）；R-182 独立可启动
> - B17 ← R-190 依赖 R-160（outbox），R-191/R-192 进一步依赖 B13 deliverable schema
> - B18 ← R-202 依赖 R-138/R-166（worker 拆分）；R-200/R-201 依赖 R-027/R-030
>
> **首发推荐顺序（建议，非强制；cron 仍只看 `depends_on`）**：先 R-135..R-146 补丁清场 → 启动 B14 outbox 地基 → B13 plan 重模 → B15 协议化 → B16/B17 并行 → 最后 B18 拆服务

---

## 修复条目清单

---

### B1 — Drift 进程中止与 AI 自处理消除

> **目标**：让 drift 触发时正在跑的 execution 真正停下来，rebind 后旧进程不能 complete，并且 AI 不再自作主张解决 drift。

---

#### R-001 [CRITICAL] 禁用 AI 后台自动解决 drift

- **status**: done
- **closed_in**: PR#10
- **batch**: B1
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/src/lib/drift-engine.ts` (行 225-260)
- **symptom**: AI 算 compatibilityScore > 70 就静默把 drift 标 resolved、把 task 从 blocked 改回 in_progress，用户什么都没做就被代为决定
- **root_cause**: `enrichDriftAlertsWithAi` 里 `highCompatibility` 分支直接写 `status: 'resolved'`、`resolvedBy: 'system'`，并 `updateMany` 解锁 task
- **fix_steps**:
  1. 在 `drift-engine.ts:225-260` 删除 `highCompatibility ? { status: 'resolved', ... } : {}` 这段
  2. 仅保留 `compatibilityScore` / `impactAnalysis` / `suggestedAction` / `affectedAreas` / `planDiffId` 的写入
  3. 删除 `if (highCompatibility) { task.updateMany ... eventBus.publish('drift_resolved' ...) }`
  4. UI/CLI 显示 `suggestedAction + compatibilityScore` 作为建议
- **verification**:
  - 新增 vitest：`激活 v2，等 AI enrich 完成，driftAlert.status === 'open'`
  - 新增 vitest：`即使 score = 95, task.status 仍为 blocked / in_progress (不变)`
- **rollback**: 单文件改动，git revert 即可

---

#### R-002 [CRITICAL] drift 触发时取消正在跑的 ExecutionRun

- **status**: done
- **closed_in**: PR#13
- **batch**: B1
- **depends_on**: R-008
- **note**: R-008 introduces the `superseded` execution-run status that this entry uses; do not pickup R-002 until R-008 is done or cancelled.
- **effort**: medium
- **files**: `packages/api/src/lib/drift-engine.ts` (行 143-153), `packages/api/prisma/schema.prisma`
- **symptom**: rebind 之后 agent 内进程不受影响，继续按旧 plan 工作，最后还能 complete
- **root_cause**: `persistDriftAlerts` 注释里写明 _"running execution stays alive — agent must stop voluntarily"_，没有任何机制中止 run
- **fix_steps**:
  1. 在事务内追加：`await tx.executionRun.updateMany({ where: { taskId: { in: highSeverityTaskIds }, status: 'running' }, data: { status: 'superseded', endedAt: new Date() } })`
  2. 事务提交后 publish SSE `execution_superseded` 事件（每个 superseded run 一个）
  3. 在 webhook dispatch 列表里加 `execution_superseded`
- **verification**:
  - vitest：`激活 v2 → 受影响 task 的 running run.status === 'superseded'`
  - vitest：SSE 客户端能收到 `execution_superseded` 事件
- **rollback**: revert 单文件 + 不依赖 schema 变更

---

#### R-003 [CRITICAL] heartbeat / complete 加 run-task 版本对齐校验

- **status**: done
- **closed_in**: PR#13
- **batch**: B1
- **depends_on**: R-002
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/tasks/[taskId]/runs/[runId]/route.ts`
- **symptom**: rebind 后旧 run 仍可以 heartbeat 并 complete，最后 task 被标 done
- **root_cause**: PATCH 接口只看 `run.status === 'running'` 和 `openDrifts`；不检查 `run.boundPlanVersion === task.boundPlanVersion`
- **fix_steps**:
  1. 在 PATCH 头部统一加：
     ```ts
     if (run.status !== 'running') {
       throw new AppError(
         ErrorCode.STATE_CONFLICT,
         `Execution is ${run.status}. Restart with latest task pack.`,
         { runStatus: run.status },
       );
     }
     if (run.boundPlanVersion !== run.task.boundPlanVersion) {
       throw new AppError(
         ErrorCode.STATE_CONFLICT,
         `Run bound to plan v${run.boundPlanVersion}, task now v${run.task.boundPlanVersion}. Run is stale.`,
         { code: 'RUN_STALE_VERSION' },
       );
     }
     ```
  2. heartbeat / complete 两个分支都受此保护
- **verification**: vitest：rebind 后调 complete → 409 + code `RUN_STALE_VERSION`
- **rollback**: revert 单文件

---

#### R-004 [HIGH] rebind 行为升级为"显式重启"

- **status**: done
- **closed_in**: PR#643
- **batch**: B1
- **depends_on**: R-002, R-008
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/drifts/[driftId]/route.ts` (行 61-70), `packages/api/src/app/api/projects/[projectId]/tasks/[taskId]/rebind/route.ts`
- **symptom**: rebind 后 task 还在 `in_progress`，但应该重新走一遍
- **root_cause**: rebind 只改 `boundPlanVersion` + 把 `blocked → in_progress`；没有把过时的 run 标 superseded、没有把 task 还原到 `todo`
- **fix_steps**:
  1. `drifts/[driftId]` rebind 分支改为：`task.status = 'todo'`，并同步 `executionRun.updateMany running → superseded`
  2. `tasks/[taskId]/rebind` 同步同样的行为
  3. 文档化新语义：rebind 表示"基于新 plan 重新启动"
- **verification**:
  - vitest：rebind 后 task.status === 'todo'、旧 run.status === 'superseded'
  - vitest：rebind 后新 `execution_start` 能立刻开始（不卡 blocked）
- **rollback**: 两个 route 文件 revert

---

#### R-005 [HIGH] MCP heartbeat 把 superseded / RUN_STALE_VERSION 转为 agent abort

- **status**: in_progress
- **batch**: B1
- **depends_on**: R-003
- **effort**: medium
- **files**: `packages/mcp-server/src/tools/execution.ts` (心跳自动循环), `packages/cli/src/ai-loop.ts`
- **symptom**: 即使 API 拒绝心跳，agent 还在跑自己的 AI loop
- **root_cause**: 心跳失败只 logger.warn，没有反向通知 CLI 的 ai-loop
- **fix_steps**:
  1. MCP heartbeat 收到 `code: 'RUN_STALE_VERSION'` 或 `runStatus: 'superseded'` 时：
     - 调 `sendLoggingMessage` 推 `error` 级日志
     - 调 `heartbeatManager.stop(runId)` 释放心跳
     - 在 MCP server 进程内发一个全局事件（`process.emit('plansync:abort', { runId, reason })`）
  2. CLI 的 mcp-client 监听 `plansync:abort` notification，设置一个 `AbortController`
  3. ai-loop 在每轮 `streamOneTurn` 之间检查 `signal.aborted`，是则结束循环 + 红色提示
- **verification**:
  - 端到端：模拟 plan 激活 → ai-loop 在 30s 内自然终止 + 输出 `EXECUTION_SUPERSEDED` 提示
- **rollback**: 4 文件 revert，无 DB 变更

---

#### R-006 [HIGH] drift complete-gate 同时检查 run 版本

- **status**: in_progress
- **batch**: B1
- **depends_on**: R-003
- **effort**: small
- **files**: `runs/[runId]/route.ts` (行 56-71)
- **symptom**: drift 已被 AI 自动 resolve 后，gate 失效，任意旧 run 都能 complete
- **root_cause**: gate 只看 `driftAlert.status === 'open'`
- **fix_steps**: gate 改为 `(openDrifts.length > 0) || (run.boundPlanVersion !== run.task.boundPlanVersion)`（实际由 R-003 顶部检查覆盖；本条作为冗余校验保留）
- **verification**: vitest：drift 被外部 resolve（no_impact）但 run 仍是旧版本 → 仍 409
- **rollback**: revert 单文件

---

#### R-007 [MEDIUM] drift-engine 事件/邮件移到事务提交后

- **status**: done
- **closed_in**: PR#11 (implementation) + PR#12 (complementary tests)
- **batch**: B1
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/src/lib/drift-engine.ts`
- **symptom**: 事务回滚后仍发出"鬼通知"
- **root_cause**: `eventBus.publish` 和 `sendMail` 在 `tx` 内同步调用
- **fix_steps**: 把 alerts 列表 return 出事务，由 caller 在 `$transaction` resolve 后再 publish/send
- **verification**: vitest：mock `tx.task.updateMany` 抛错 → 应当**不**收到任何 SSE 事件
- **rollback**: 单文件

---

#### R-008 [HIGH] 新增 `superseded` execution run 状态

- **status**: done
- **closed_in**: PR#13
- **batch**: B1
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/prisma/schema.prisma` (model ExecutionRun), `packages/shared/src/schemas/execution.ts`, 新迁移
- **symptom**: 想表达"被新 plan 替代而中止"时缺少状态
- **root_cause**: 现有状态 `running | completed | failed | stale | cancelled` 没有 `superseded`
- **fix_steps**:
  1. 更新 schema.prisma 注释 + 新增迁移：CHECK 约束（如选 enum 化在 B8 一起做）
  2. shared 的 zod enum 加 `superseded`
  3. CLI/MCP 显示文案区分 superseded 和 cancelled
- **verification**: `prisma migrate deploy` 通过 + 单测 zod 接受新值
- **rollback**: 迁移可逆，删除该状态枚举值

---

### B2 — 执行所有权与凭证收紧

---

#### R-009 [CRITICAL] heartbeat/complete 接口加 executor 身份校验

- **status**: done
- **closed_in**: PR#14, PR#44
- **batch**: B2
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/tasks/[taskId]/runs/[runId]/route.ts` (行 22-203)
- **symptom**: 项目内任何 developer 可以心跳/完成别人的 run
- **root_cause**: 只做 `requireProjectRole(auth, projectId)`，未校验 `auth.userName === run.executorName` 或 `auth.execRunId === runId`
- **fix_steps**:
  ```ts
  const isOwner = member.projectRole === 'owner';
  const isExecutor = auth.userName === run.executorName;
  const isScoped = auth.execRunId === params.runId;
  if (!isOwner && !isExecutor && !isScoped) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      'Only the executor or project owner can update this run',
    );
  }
  ```
- **verification**: vitest：用 user B 的 key 给 user A 的 run 调 PATCH → 403
- **rollback**: 单文件

---

#### R-010 [CRITICAL] 生产环境拒绝 PLANSYNC_SECRET 默认值

- **status**: done
- **closed_in**: PR#16
- **batch**: B2
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/src/lib/env.ts`, `packages/api/src/lib/auth.ts`, `.env.example`
- **symptom**: 默认 `dev-secret` + master 模式 → 任意身份冒充
- **root_cause**: zod schema 默认值 `dev-secret`，且 `auth.ts` 只跳过 `=== 'dev-secret'`
- **fix_steps**:
  1. `env.ts`：把 `PLANSYNC_SECRET` 改为无默认，`min(32).refine(v => v !== 'dev-secret', ...)` 仅在 NODE_ENV=production 时强制
  2. 启动时检测：`if (NODE_ENV === 'production' && (!secret || secret === 'dev-secret')) process.exit(1)`
  3. `.env.example` 加 `PLANSYNC_SECRET=` 占位 + 注释生成方法
- **verification**: 启动测试：production + 默认值 → 进程立即退出
- **rollback**: env.ts revert

---

#### R-011 [HIGH] exec-scoped API key 绑定到 projectId

- **status**: done
- **closed_in**: PR#17
- **batch**: B2
- **depends_on**: —
- **effort**: medium
- **files**: `packages/api/src/lib/auth.ts` (行 118-126), `packages/api/src/lib/auth.ts` (`requireProjectRole`)
- **symptom**: 一个项目的 exec 凭证可以访问别的项目
- **root_cause**: `authenticate()` 返回的 auth 不携带 key 的 `projectId`；`requireProjectRole` 不验
- **fix_steps**:
  1. `authenticate` 中：从 ApiKey 行带出 `keyProjectId`
  2. `requireProjectRole` 中：`if (auth.execRunId && auth.keyProjectId && auth.keyProjectId !== projectId) throw FORBIDDEN`
- **verification**: vitest：项目 A 签发的 exec key 调项目 B 的 task → 403
- **rollback**: 两个函数 revert

---

#### R-012 [HIGH] execution_start 不再自动注册 agent 成员

- **status**: done
- **closed_in**: PR#18
- **batch**: B2
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/tasks/[taskId]/runs/route.ts` (行 72-81)
- **symptom**: 任意 developer 用一个新 agent 名字调 execution_start 就能把这个 agent 加进项目
- **root_cause**: `prisma.projectMember.upsert` 无条件创建
- **fix_steps**:
  1. 改为 `findUnique`，找不到则抛 `AppError(ErrorCode.NOT_FOUND, 'Agent member not registered; ask owner to add')`
  2. owner 想自动添加可以传 `?auto_register=true`，但仅 owner 可
- **verification**: vitest：未注册 agent → 404；owner + auto_register → 创建
- **rollback**: 单文件

---

#### R-013 [HIGH] 首次登录的开放注册改为受控

- **status**: done
- **closed_in**: PR#45
- **batch**: B2
- **depends_on**: —
- **effort**: medium
- **files**: `packages/api/src/app/api/auth/login/route.ts` (行 48-52)
- **symptom**: 第一个用任意密码登录某 username 的人就拥有它
- **root_cause**: 首次登录无邀请/验证就建账号
- **fix_steps**:
  1. 加 env `PLANSYNC_OPEN_REGISTRATION=true|false`（默认 false）
  2. false 时 first-login 返回 401 + message "Account must be created by admin"
  3. 提供 admin CLI `bin/ps-admin create-user <name>` 预创建账号
- **verification**: vitest：env 关 + 新用户名登录 → 401；env 开 → 创建
- **rollback**: env 默认 true 可保持旧行为

---

#### R-014 [MEDIUM] 密码 Bearer 模式仅在开发环境保留

- **status**: in_progress
- **batch**: B2
- **depends_on**: R-013
- **effort**: small
- **files**: `packages/api/src/lib/auth.ts` (行 100-115)
- **symptom**: 密码当作 Bearer 反复使用、缓存明文 5 分钟
- **root_cause**: 设计如此
- **fix_steps**:
  1. 仅 `NODE_ENV !== 'production'` 才允许密码 Bearer
  2. 生产强制使用 `ps_key_*`
- **verification**: integration：production env + 密码 Bearer → 401
- **rollback**: 解除 env gate

---

#### R-015 [HIGH] 给所有 owner-only 写路由加 `requireNotExecScoped`

- **status**: done
- **closed_in**: PR#65
- **batch**: B2
- **depends_on**: —
- **effort**: medium
- **files**: 多个路由（详见 fix_steps）
- **symptom**: exec key 可以 PATCH 计划/任务/项目，超出文档承诺的范围
- **root_cause**: 仅 5 个路由调用 `requireNotExecScoped`
- **fix_steps**: 在以下路由头部加 `requireNotExecScoped(auth)`：
  - `plans/[planId]/route.ts` (PATCH/DELETE)
  - `plans/[planId]/append/route.ts`
  - `projects/[projectId]/route.ts` (PATCH/DELETE)
  - `tasks/[taskId]/route.ts` (DELETE)
  - `members/route.ts` (POST), `members/[memberId]/route.ts` (PATCH/DELETE)
  - `webhooks/route.ts` (POST), `webhooks/[id]/route.ts`
  - `notify/route.ts` (POST)
- **verification**: integration：exec-scoped key 调以上每个路由 → 403
- **rollback**: 单点 revert

---

#### R-016 [HIGH] 委托模式 task tools 使用 `withUser`

- **status**: done
- **closed_in**: PR#20
- **batch**: B2
- **depends_on**: —
- **effort**: small
- **files**: `packages/mcp-server/src/tools/task.ts` (行 94-150)
- **symptom**: "work as <agent>" 流程把 task assignee 设成 owner
- **root_cause**: claim/decline/update 都用裸 `api`，不调用 `api.withUser(getDelegationAgent())`
- **fix_steps**:
  ```ts
  const effectiveApi = getDelegationAgent() ? api.withUser(getDelegationAgent()!) : api;
  ```
- **verification**: vitest：设置 delegation = "genie" → claim 后 task.assignee === "genie"
- **rollback**: 单文件

---

#### R-017 [HIGH] `withUser` 在普通 API key 下抛错或退化警告

- **status**: in_progress
- **batch**: B2
- **depends_on**: R-010
- **effort**: small
- **files**: `packages/mcp-server/src/api-client.ts` (行 22-27)
- **symptom**: 无 `PLANSYNC_SECRET` 配置时 `withUser` 静默退化为 key 拥有者
- **root_cause**: 没有显式失败
- **fix_steps**: `withUser` 在 `!this.config.delegationSecret` 时 throw `Error('Delegation requires PLANSYNC_SECRET')`
- **verification**: vitest：未设 secret + 调 withUser → 抛错
- **rollback**: 单文件

---

#### R-018 [HIGH] `my_work` 跨项目模式尊重 `agentName`

- **status**: done
- **closed_in**: PR#32
- **batch**: B2
- **depends_on**: —
- **effort**: small
- **files**: `packages/mcp-server/src/tools/status.ts` (行 147-154), `packages/api/src/app/api/my-work/route.ts`
- **symptom**: `plansync_my_work { agentName: 'genie' }` 不传 projectId 时返回当前用户的活
- **root_cause**: API `/api/my-work` 总用 `auth.userName`
- **fix_steps**:
  1. API 加 `?user=<name>` query 参数（仅 owner / master 可指定他人）
  2. MCP tool 传 `agentName` 时附加 `?user=...`
- **verification**: vitest：owner 调 `/api/my-work?user=genie` → 返回 genie 的工作
- **rollback**: API + MCP 双 revert

---

#### R-019 [MEDIUM] exec_context 区分 fatal/transient 错误

- **status**: done
- **closed_in**: PR#25
- **batch**: B2
- **depends_on**: —
- **effort**: small
- **files**: `packages/mcp-server/src/tools/execution.ts` (行 95-118)
- **symptom**: 环境变量已设但 task_pack fetch 失败时返回 `execMode: false` 误导 agent
- **root_cause**: catch 直接降级为非 exec 模式
- **fix_steps**: env 已设时返回 `{ execMode: true, error, runId, taskId, projectId, transient: true }`
- **verification**: vitest：mock fetch 抛 ECONNRESET → 返回 transient
- **rollback**: 单文件

---

#### R-020 [MEDIUM] exec_context 有 drift 时不启心跳

- **status**: pending
- **batch**: B2
- **depends_on**: R-005
- **effort**: small
- **files**: `packages/mcp-server/src/tools/execution.ts` (行 99-101)
- **symptom**: 进入 exec mode 时即使有未解 drift，心跳照样开始
- **root_cause**: 无条件 `heartbeatManager.start`
- **fix_steps**: `if (taskPack.driftAlerts?.length === 0) { heartbeatManager.start(...) } else { 返回 blocking + 提示先解 drift }`
- **verification**: vitest：有 open drift → 不启心跳，返回阻塞态
- **rollback**: 单文件

---

### B3 — MCP 客户端重连与重试

---

#### R-021 [CRITICAL] MCP 子进程崩溃可检测可自动恢复

- **status**: done
- **closed_in**: PR#33, PR#48
- **batch**: B3
- **depends_on**: —
- **effort**: medium
- **files**: `packages/cli/src/mcp-client.ts` (行 52-149)
- **symptom**: MCP server 崩溃后 CLI 不知道，所有工具调用挂 30s 超时
- **root_cause**: 只注册 `proc.on('error')`，无 `exit` / `close`
- **fix_steps**:
  1. 注册 `proc.on('exit', (code, signal) => { ... })`：
     - 把所有 `pending` reject，错误 message `MCP_CRASHED`
     - `this.proc = null`
     - logger.warn 报告
  2. `ensureRunning()` 检测到 null 时自动重启（带最多 3 次指数退避）
  3. 暴露 `isHealthy()` 给上层
- **verification**:
  - 单测：kill MCP 进程 → 下一次 callTool 重启并成功
  - 单测：连续 3 次崩溃 → 客户端报 unhealthy
- **rollback**: 单文件

---

#### R-022 [HIGH] MCP callTool 加单次重试

- **status**: in_progress
- **batch**: B3
- **depends_on**: R-021
- **effort**: small
- **files**: `packages/cli/src/mcp-client.ts` (行 122-128)
- **symptom**: transport 抖动直接抛错给 LLM
- **root_cause**: 单次 fetch，无 retry
- **fix_steps**: callTool 内 try / catch：transport error → `ensureRunning()` + 重试 1 次
- **verification**: 单测：第一次写 stdin 失败、第二次成功 → 工具调用返回成功
- **rollback**: 单文件

---

#### R-023 [HIGH] SSE listener 对 401/403 立刻提示用户

- **status**: done
- **closed_in**: PR#34, PR#51
- **batch**: B3
- **depends_on**: —
- **effort**: small
- **files**: `packages/cli/src/sse-listener.ts` (行 73-75, 123-131)
- **symptom**: 凭证失效后无限退避重连
- **root_cause**: 任何非 OK 都走通用 backoff
- **fix_steps**:
  1. 401/403 → 停止 listener、emit `authFailure` 事件、控制台红色提示"请重新登录"
  2. 5xx → 现有 backoff 保留
- **verification**: 集成：mock SSE 返回 401 → listener 停 + 控制台输出
- **rollback**: 单文件

---

#### R-024 [MEDIUM] MCP stop() 清理 pending requests

- **status**: in_progress
- **batch**: B3
- **depends_on**: R-021
- **effort**: small
- **files**: `packages/cli/src/mcp-client.ts` (行 135-138)
- **symptom**: stop 之后 pending Promise 永远不 resolve
- **root_cause**: 没 reject pending
- **fix_steps**: `stop()` 内 `pending.forEach((p) => p.reject(new Error('MCP shutdown'))); pending.clear()`
- **verification**: 单测：stop 后 await 之前的 callTool → reject
- **rollback**: 单文件

---

#### R-025 [HIGH] psRequest 检查 HTTP 状态码

- **status**: done
- **batch**: B3
- **depends_on**: —
- **effort**: small
- **files**: `packages/cli/src/commands.ts` (行 22-59)
- **symptom**: 401/500 被当作空数据处理，banner 显示"没有计划"而不是"未授权"
- **root_cause**: 直接 `JSON.parse(body)` 不看 statusCode
- **fix_steps**:
  1. 检查 `res.statusCode`
  2. 401/403 → emit `authFailure`，提示重新登录
  3. 5xx → 重试 1 次后向用户报错
  4. 200 + JSON 才解析
- **verification**: 单测：mock 401 → 抛 AuthError；mock 500 → 一次重试
- **rollback**: 单文件

---

#### R-026 [MEDIUM] CLI auth 用 URL 协议选择 http vs https

- **status**: done
- **closed_in**: PR#36, PR#56
- **batch**: B3
- **depends_on**: —
- **effort**: small
- **files**: `bin/plansync` (行 133-135, 173)
- **symptom**: `PLANSYNC_API_URL=https://...` 时凭证验证挂死
- **root_cause**: 硬编码 `require('http')`
- **fix_steps**: 根据 URL 协议选择 http/https 模块（参考 `exec.ts` 已有写法）
- **verification**: 手测：https 后端 → 登录成功
- **rollback**: 单文件

---

### B4 — 契约统一

> 目标：让 `@plansync/shared` 成为唯一真理源，shared/API/MCP/Prisma 之间任何字段漂移都在 CI 中红线阻断。

---

#### R-027 [HIGH] MCP `task_update` schema 复用 shared

- **status**: done
- **closed_in**: PR#57
- **batch**: B4
- **depends_on**: —
- **effort**: small
- **files**: `packages/mcp-server/src/tools/task.ts` (行 71-98)
- **symptom**: MCP 缺 type/branchName/prUrl/agentContext/expectedOutput/agentConstraints/startDate/dueDate
- **root_cause**: 手抄
- **fix_steps**: `import { updateTaskSchema } from '@plansync/shared'`，去掉本地重写；exec mode 限制改为 wrapper（只允许特定字段）
- **verification**: 单测 schema 字段集合等于 shared
- **rollback**: 单文件

---

#### R-028 [HIGH] MCP `task_create` 复用 shared

- **status**: done
- **closed_in**: PR#57
- **batch**: B4
- **depends_on**: —
- **effort**: small
- **files**: `packages/mcp-server/src/tools/task.ts` (行 49)
- **symptom**: 缺 `test`/`docs` 类型 + 缺日期字段
- **root_cause**: 手抄
- **fix_steps**: 同上，import `createTaskSchema`
- **verification**: 单测；并跑一个真实 task_create('test', ...)
- **rollback**: 单文件

---

#### R-029 [MEDIUM] MCP `project_create/update` 补 repoUrl/defaultBranch

- **status**: done
- **batch**: B4
- **depends_on**: —
- **effort**: small
- **files**: `packages/mcp-server/src/tools/project.ts` (行 29-33, 72-77)
- **symptom**: MCP 漏字段
- **root_cause**: 手抄
- **fix_steps**: import `createProjectSchema` / `updateProjectSchema`
- **verification**: 单测
- **rollback**: 单文件

---

#### R-030 [HIGH] shared `planReviewSchema` 补 `focusNotes`

- **status**: done
- **closed_in**: PR#55
- **batch**: B4
- **depends_on**: —
- **effort**: small
- **files**: `packages/shared/src/schemas/plan.ts` (行 54-62)
- **symptom**: Zod 解析 API 响应时 `focusNotes` 被剥离
- **root_cause**: 加字段时没更新 shared
- **fix_steps**: 加 `focusNotes: z.string().nullable().optional()`
- **verification**: 单测：parse 真实 API 响应不报错
- **rollback**: 单文件

---

#### R-031 [HIGH] shared `driftAlertSchema` 补 `affectedAreas` 与 `planDiffId`

- **status**: done
- **closed_in**: PR#41
- **batch**: B4
- **depends_on**: —
- **effort**: small
- **files**: `packages/shared/src/schemas/drift.ts` (行 12-28)
- **symptom**: 同上
- **root_cause**: 同上
- **fix_steps**: 添加两个字段
- **verification**: 单测
- **rollback**: 单文件

---

#### R-032 [MEDIUM] propose plan 接口建立 shared zod schema

- **status**: done
- **closed_in**: PR#42
- **batch**: B4
- **depends_on**: —
- **effort**: small
- **files**: `packages/shared/src/schemas/plan.ts`, `packages/api/src/app/api/projects/[projectId]/plans/[planId]/propose/route.ts` (行 19-25)
- **symptom**: 路由手解 body 无校验
- **root_cause**: 缺 schema
- **fix_steps**:
  1. shared 新增 `proposePlanSchema = z.object({ reviewers: z.array(reviewerSpecSchema).max(20).optional() })`
  2. route 改 `validateBody(req, proposePlanSchema)`
- **verification**: 单测：错误 reviewers 入参 → 400
- **rollback**: 双 revert

---

#### R-033 [MEDIUM] `createActivity` 强制 zod 校验 type

- **status**: done
- **closed_in**: PR#62
- **batch**: B4
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/src/lib/activity.ts` (行 4-11)
- **symptom**: 错别字直接落库
- **root_cause**: type 是 string
- **fix_steps**: `import { activityTypeSchema } from '@plansync/shared'`，函数顶 `activityTypeSchema.parse(params.type)`
- **verification**: 单测：错 type → 抛错
- **rollback**: 单文件

---

#### R-034 [HIGH] 增加 schema-drift CI 守门测试

- **status**: in_progress
- **batch**: B4
- **depends_on**: R-027, R-028, R-029, R-030, R-031, R-032, R-033
- **effort**: medium
- **files**: 新增 `packages/mcp-server/tests/schema-drift.test.ts`
- **symptom**: 字段在 shared 加了但 MCP 忘改
- **root_cause**: 没自动化对比
- **fix_steps**:
  1. 测试枚举 MCP 注册的所有 tool 输入 schema 的 keys
  2. 与 shared 对应 schema keys 比对（白名单允许差异）
  3. 不一致则 fail
- **verification**: 跑测试通过
- **rollback**: 删测试

---

#### R-035 [HIGH] env.ts 验证所有运行时使用的 env 变量

- **status**: done
- **closed_in**: PR#60
- **batch**: B4
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/src/lib/env.ts`, `.env.example`
- **symptom**: AI keys、EMAIL\_、PLANSYNC_SECRET 都被代码用但 env 没验
- **root_cause**: 只验了 5 个
- **fix_steps**:
  1. 添加：`LLM_API_KEY`, `LLM_API_BASE`, `ANTHROPIC_API_KEY`, `EMAIL_FROM`, `EMAIL_SENDMAIL`（全部 optional）
  2. `.env.example` 同步
- **verification**: 启动日志不报 undefined
- **rollback**: 单文件

---

#### R-036 [MEDIUM] 删除 MCP `plan_create` 客户端 draft guard 或在 API 实施

- **status**: done
- **closed_in**: PR#43
- **batch**: B4
- **depends_on**: —
- **effort**: small
- **files**: `packages/mcp-server/src/tools/plan.ts` (行 66-82), `packages/api/src/app/api/projects/[projectId]/plans/route.ts`
- **symptom**: MCP 阻挡而 API 放行，curl 可绕过
- **root_cause**: 一边检查一边不检查
- **fix_steps**: 把 guard 下沉到 API；MCP 删本地检查
- **verification**: vitest：API 端拒绝创建第二个 draft
- **rollback**: 双 revert

---

#### R-037 [MEDIUM] MCP tool 统一错误格式（isError + 结构化）

- **status**: done
- **closed_in**: PR#46
- **batch**: B4
- **depends_on**: —
- **effort**: medium
- **files**: `packages/mcp-server/src/index.ts` (行 141-160), 各 tools/\*.ts
- **symptom**: ApiError 未捕获 / 委托阻塞返回普通成功 / member_add 软失败返回纯文本
- **root_cause**: 没有统一 wrapper
- **fix_steps**:
  1. 在 `index.ts` 的 `registerTool` patch 出错时返回 `{ content: [...], isError: true }`
  2. 各 tool 内 throw `ApiError`，由 wrapper 转格式
- **verification**: 单测：模拟 ApiError → 客户端收到 isError: true
- **rollback**: index.ts revert

---

#### R-038 [MEDIUM] `review_reject` schema 强制 comment 非空

- **status**: done
- **closed_in**: PR#66
- **batch**: B4
- **depends_on**: —
- **effort**: small
- **files**: `packages/mcp-server/src/tools/plan.ts` (行 297, 305-317)
- **symptom**: 描述说 required 但 zod 是 optional
- **root_cause**: schema 不严
- **fix_steps**: reject 用 `z.string().min(1)`；approve 保留 optional
- **verification**: vitest：reject 不带 comment → 失败
- **rollback**: 单文件

---

#### R-039 [LOW] execution tools 错误统一为 JSON envelope

- **status**: in_progress
- **batch**: B4
- **depends_on**: R-037
- **effort**: small
- **files**: `packages/mcp-server/src/tools/execution.ts` (行 163-181, 255, 289)
- **symptom**: 不同失败分支格式不一（JSON / 纯文本）
- **root_cause**: 历史累积
- **fix_steps**: 统一返回 `{ error: { code, message, guidance } }`
- **verification**: 单测各失败分支
- **rollback**: 单文件

---

#### R-040 [LOW] api-client 启动时校验 token 配置

- **status**: in_progress
- **batch**: B4
- **depends_on**: R-010
- **effort**: small
- **files**: `packages/mcp-server/src/api-client.ts` (行 42-93), `packages/mcp-server/src/config.ts`
- **symptom**: 空 `PLANSYNC_API_KEY` 仍发 `Authorization: Bearer `
- **root_cause**: 不校验
- **fix_steps**: config 加载阶段：缺 token → 启动失败 + 明确错误消息
- **verification**: 启动 mcp-server with empty key → 立即退出
- **rollback**: 单文件

---

### B5 — 嵌套资源 plan-project 一致性

---

#### R-041 [HIGH] 所有 `/plans/[planId]/...` 路由验证 plan ∈ project

- **status**: done
- **closed_in**: PR#99
- **batch**: B5
- **depends_on**: —
- **effort**: medium
- **files**:
  - `packages/api/src/app/api/projects/[projectId]/plans/[planId]/route.ts`
  - `.../plans/[planId]/comments/route.ts` + `[commentId]`
  - `.../plans/[planId]/suggestions/route.ts` + `[suggestionId]`
  - `.../plans/[planId]/reviews/route.ts` + `[reviewId]`
  - `.../plans/[planId]/append/route.ts`
  - `.../plans/[planId]/diff/route.ts`
  - `.../plans/[planId]/propose/route.ts`
  - `.../plans/[planId]/activate/route.ts`
  - `.../plans/[planId]/reactivate/route.ts`
- **symptom**: 项目 A 成员能读/写项目 B 的 plan 子资源
- **root_cause**: 只查 `findUnique({ id: planId })`，不验 `plan.projectId === params.projectId`
- **fix_steps**:
  1. 抽一个 helper `requirePlanInProject(planId, projectId): Promise<Plan>`：找不到或 projectId 不符抛 404
  2. 每个 route 改为先调 helper
- **verification**: integration：跨项目访问 → 404
- **rollback**: 删 helper 重置

---

#### R-042 [HIGH] task 状态 / drift 状态 query 参数加 zod 校验

- **status**: done
- **closed_in**: PR#100
- **batch**: B5
- **depends_on**: —
- **effort**: small
- **files**:
  - `packages/api/src/app/api/projects/[projectId]/tasks/route.ts` (行 22-28)
  - `.../drifts/route.ts` (行 17-21)
- **symptom**: 任意 string 传 Prisma where → 空集
- **root_cause**: 无 enum 校验
- **fix_steps**: 用 shared `taskStatusSchema` / `driftStatusSchema` 校验，错误 → 400
- **verification**: 单测：?status=foo → 400
- **rollback**: 单点

---

#### R-043 [HIGH] webhook URL 校验防 SSRF

- **status**: done
- **closed_in**: PR#68
- **batch**: B5
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/webhooks/route.ts` (行 38-59)
- **symptom**: 可注册 `http://169.254.169.254/...`
- **root_cause**: 不验
- **fix_steps**:
  1. URL parse，要求 https（生产环境）
  2. 拒绝 host 落在私网段（10/8、172.16/12、192.168/16、169.254/16、127/8、::1、fc00::/7）
  3. 添加 env `PLANSYNC_WEBHOOK_ALLOWLIST` 可选
- **verification**: 单测：内网 URL → 400
- **rollback**: 单文件

---

#### R-044 [MEDIUM] notify 路由限流 + owner-only

- **status**: done
- **closed_in**: PR#69
- **batch**: B5
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/notify/route.ts` (行 14-57)
- **symptom**: 任意 developer 可触发邮件
- **root_cause**: 仅 requireProjectRole
- **fix_steps**:
  1. 检查 `member.projectRole === 'owner'`
  2. 加内存限流（每 user 5 分钟内最多 3 次）
- **verification**: 单测：developer 调 → 403；owner 第 4 次 → 429
- **rollback**: 单文件

---

#### R-045 [HIGH] human task PATCH `done` 需要 execution 或 owner

- **status**: done
- **closed_in**: PR#70
- **batch**: B5
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/tasks/[taskId]/route.ts` (行 66-78)
- **symptom**: 任何 developer 可 PATCH `human` task 到 done 绕过完成流程
- **root_cause**: 只对 agent task 强制 run
- **fix_steps**: PATCH `done` 时统一要求：`owner || 存在 completed run || 是当前 assignee 且类型 human`
- **verification**: 单测
- **rollback**: 单文件

---

#### R-046 [MEDIUM] complete-human 加 open drift gate

- **status**: done
- **closed_in**: PR#71
- **batch**: B5
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/tasks/[taskId]/complete-human/route.ts`
- **symptom**: 绕过 drift gate
- **root_cause**: 没检查
- **fix_steps**: 复用 `runs/[runId]` 完成路径的 drift gate
- **verification**: 单测：有 open drift → 409
- **rollback**: 单文件

---

#### R-047 [MEDIUM] DELETE task 拒绝有 running run 的请求

- **status**: done
- **closed_in**: PR#72
- **batch**: B5
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/tasks/[taskId]/route.ts` (行 145-157)
- **symptom**: 暴力级联删 run
- **root_cause**: 不检查
- **fix_steps**: 若有 running run → 409 + 提示先 cancel
- **verification**: 单测
- **rollback**: 单文件

---

### B6 — 并发与唯一性

---

#### R-048 [CRITICAL] plans 表加 partial unique "每项目一个 active"

- **status**: done
- **closed_in**: PR#73
- **batch**: B6
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/prisma/schema.prisma`, 新迁移
- **symptom**: 并发激活产生多个 active plan
- **root_cause**: schema 无约束
- **fix_steps**:
  1. 写迁移：`CREATE UNIQUE INDEX plans_one_active_per_project ON plans(project_id) WHERE status = 'active';`
  2. schema.prisma 注释中标注（Prisma 不直接支持 partial unique）
  3. `activate/route.ts` 处理 P2002 转 409
- **verification**: 并发 vitest 模拟两次激活
- **rollback**: drop index

---

#### R-049 [HIGH] task_claim 用 conditional `updateMany` 原子化

- **status**: done
- **closed_in**: PR#74, PR#198
- **batch**: B6
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/tasks/[taskId]/claim/route.ts` (行 19-41)
- **symptom**: 两个 claim 并发都通过
- **root_cause**: TOCTOU
- **fix_steps**:
  ```ts
  const res = await prisma.task.updateMany({
    where: { id: taskId, assignee: null, status: 'todo' },
    data: { assignee: auth.userName, status: 'in_progress' },
  });
  if (res.count === 0) throw STATE_CONFLICT;
  ```
- **verification**: vitest 并发 claim
- **rollback**: 单文件

---

#### R-050 [MEDIUM] plan 版本号生成放进事务

- **status**: done
- **closed_in**: PR#75
- **batch**: B6
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/plans/route.ts` (行 45-58)
- **symptom**: 并发 create 撞 unique
- **root_cause**: read-increment-write 非原子
- **fix_steps**: 包进 `$transaction`，捕获 P2002 重试一次
- **verification**: 单测
- **rollback**: 单文件

---

#### R-051 [HIGH] drift_alert 触发用 upsert 避免重复

- **status**: in_progress
- **batch**: B6
- **depends_on**: R-008
- **effort**: medium
- **files**: `packages/api/src/lib/drift-engine.ts` (行 74-85), schema + 迁移
- **symptom**: 多次激活产生重复 open 告警
- **root_cause**: 无 (taskId, status=open) 唯一性
- **fix_steps**:
  1. 加 partial unique：`CREATE UNIQUE INDEX drift_alerts_one_open_per_task ON drift_alerts(task_id) WHERE status = 'open';`
  2. `persistDriftAlerts` 改为先 supersede 旧的 open，再 createMany
- **verification**: 单测：连续两次激活 → 同一 task 只有一个 open
- **rollback**: drop index

---

#### R-052 [HIGH] reactivate 把 drift 扫描放回事务

- **status**: done
- **closed_in**: PR#76
- **batch**: B6
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/plans/[planId]/reactivate/route.ts` (行 29-70)
- **symptom**: plan active 但 drift 还未生成
- **root_cause**: 事务外调用
- **fix_steps**: 仿照 activate 路由把 `runDriftScan + persistDriftAlerts` 放进 `$transaction`
- **verification**: 单测：模拟 persistDriftAlerts 抛错 → plan 不留 active
- **rollback**: 单文件

---

#### R-053 [MEDIUM] suggestion accept 单事务 apply+update

- **status**: done
- **closed_in**: PR#77
- **batch**: B6
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[planId]/suggestions/[suggestionId]/route.ts` (行 87-103)
- **symptom**: plan 被修改但 suggestion 仍 pending
- **root_cause**: 两次独立写
- **fix_steps**: 包 `$transaction`
- **verification**: 单测
- **rollback**: 单文件

---

#### R-054 [HIGH] execution_start 拒绝 cancelled/blocked/done 任务

- **status**: done
- **closed_in**: PR#78
- **batch**: B6
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/tasks/[taskId]/runs/route.ts` (行 99-129)
- **symptom**: cancelled/done 任务能再开 run
- **root_cause**: 只判 `todo` / `in_progress` 分支
- **fix_steps**: 顶部 `if (!['todo', 'in_progress'].includes(task.status)) throw STATE_CONFLICT`
- **verification**: 单测覆盖每种状态
- **rollback**: 单文件

---

#### R-055 [HIGH] activate 路由要求非 0 reviewer 或 owner 强制

- **status**: done
- **closed_in**: PR#79
- **batch**: B6
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/plans/[planId]/activate/route.ts` (行 33-38)
- **symptom**: 0 reviewer 的 proposed plan 无审批直接激活
- **root_cause**: `plan.reviews.length > 0` 才走审批分支
- **fix_steps**: 改为 `reviews.length === 0 ? requireOwner(member) : requireAllApproved()`
- **verification**: 单测
- **rollback**: 单文件

---

#### R-056 [MEDIUM] heartbeat scanner 改为 DB advisory lock

- **status**: done
- **closed_in**: PR#80
- **batch**: B6
- **depends_on**: —
- **effort**: medium
- **files**: `packages/api/src/lib/heartbeat-scanner.ts`
- **symptom**: 多进程并发扫描同一行，重复 SSE/webhook
- **root_cause**: per-process singleton
- **fix_steps**: 扫描开始时 `SELECT pg_try_advisory_lock(...)`；拿不到 lock 直接跳过这一轮
- **verification**: 集成：启 2 个 process，观察 SSE 计数 = 单进程的 1 倍
- **rollback**: 单文件

---

#### R-057 [MEDIUM] stale 状态同步释放 task 与 exec-scoped key

- **status**: in_progress
- **batch**: B6
- **depends_on**: R-008
- **effort**: small
- **files**: `packages/api/src/lib/heartbeat-scanner.ts` (行 27-68)
- **symptom**: stale run 仍持有 task in_progress 假象，exec key 仍有效
- **root_cause**: 仅改 run.status
- **fix_steps**:
  1. stale 后：`task.status = 'blocked'`（仅当无其他 running run）
  2. `apiKey.deleteMany({ where: { execRunId } })`
- **verification**: 集成：触发 stale → task blocked + key 失效
- **rollback**: 单文件

---

#### R-058 [LOW] drift_engine 使用 tx 读取（保持事务一致性）

- **status**: blocked
- **blocked_reason**: fix_steps 引用的 `drift-engine.ts` 行 89-92 / 112-115 当前只剩注释；R-007 (PR #11) 的重构已经把所有裸 `prisma` 读移到 `dispatchDriftNotifications`（事务后调用），`runDriftScan` 与 `persistDriftAlerts` 当前已经 100% 使用 `tx`。无可改代码，问题已实质修复。
- **batch**: B6
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/src/lib/drift-engine.ts` (行 89-92, 112-115)
- **symptom**: 事务内用裸 prisma 读，可能脏读
- **root_cause**: 混用
- **fix_steps**: 全部用 `tx`
- **verification**: 单测
- **rollback**: 单文件

---

### B7 — CLI 体验对齐文档

---

#### R-059 [HIGH] CLI banner phase 改用 API 返回的 `project.phase`

- **status**: done
- **closed_in**: PR#82
- **batch**: B7
- **depends_on**: —
- **effort**: small
- **files**: `packages/cli/src/commands.ts` (行 114), `packages/cli/src/ui.ts`
- **symptom**: API phase=planning 但 banner 显示 [active]
- **root_cause**: CLI 自算
- **fix_steps**: `phase: project.phase`，不要自己推导；banner 单独再显示 plan 状态
- **verification**: 手测对照 API 响应
- **rollback**: 单文件

---

#### R-060 [HIGH] `/exec` 允许 human assignee

- **status**: done
- **closed_in**: PR#83
- **batch**: B7
- **depends_on**: —
- **effort**: small
- **files**: `packages/cli/src/exec.ts` (行 371-379)
- **symptom**: human task 拒绝 `/exec`
- **root_cause**: 强制 agent 类型
- **fix_steps**: 改为允许 `(assigneeType === 'agent') || (assigneeType === 'human' && assignee === cfg.user)`
- **verification**: 手测
- **rollback**: 单文件

---

#### R-061 [HIGH] worktree 失败时调用 failRun

- **status**: done
- **closed_in**: PR#84
- **batch**: B7
- **depends_on**: —
- **effort**: small
- **files**: `packages/cli/src/exec.ts` (行 995-1000), `packages/cli/src/commands.ts` (行 639-670)
- **symptom**: 早 return 留 in_progress 直到 stale
- **root_cause**: 缺 cleanup
- **fix_steps**: 在 catch 路径里调 `failRun(runId, 'worktree-setup-failed')`
- **verification**: 手测：故意 mkdir 失败 → API 看到 run.status = failed
- **rollback**: 单文件

---

#### R-062 [HIGH] 统一 `bin/plansync --exec` 与 CLI `/exec`

- **status**: in_progress
- **batch**: B7
- **depends_on**: R-060, R-061
- **effort**: medium
- **files**: `bin/plansync` (行 507-616), `packages/cli/src/exec.ts` (行 382-397)
- **symptom**: 两条入口行为分叉，shell 入口 agent 不进 exec mode
- **root_cause**: 各自实现
- **fix_steps**:
  1. 抽 CLI launchExec 的核心为可被 shell 调用的脚本（或 node CLI subcommand）
  2. shell `--exec` 改为代理调用
- **verification**: 手测两条入口 agent 都进 exec mode
- **rollback**: 双 revert

---

#### R-063 [HIGH] AI loop 保留 tool_use/tool_result 历史

- **status**: done
- **closed_in**: PR#85
- **batch**: B7
- **depends_on**: —
- **effort**: medium
- **files**: `packages/cli/src/index.ts` (行 349-354), `packages/cli/src/ai-loop.ts`
- **symptom**: 长对话越来越笨
- **root_cause**: 只存最终 assistant text
- **fix_steps**:
  1. 保留完整 assistant message content（含 tool 块）
  2. 限制 history 长度时按 token 估算 + 摘要最早消息
- **verification**: 手测：连续 2 个相关请求，第二个能引用第一个的工具结果
- **rollback**: 单文件

---

#### R-064 [HIGH] `!shell` 命令在 Ink 之前 pause/unmount

- **status**: done
- **closed_in**: PR#86
- **batch**: B7
- **depends_on**: —
- **effort**: small
- **files**: `packages/cli/src/index.ts` (行 246-258)
- **symptom**: shell 输出与 Ink 互相覆盖
- **root_cause**: 没 unmount
- **fix_steps**: 仿 `/code`：`pause() → execSync → resume()`
- **verification**: 手测 `!ls`
- **rollback**: 单文件

---

#### R-065 [MEDIUM] `/clear` `/verbose` 等无 unmount 的命令统一加入 unmount

- **status**: done
- **closed_in**: PR#87
- **batch**: B7
- **depends_on**: —
- **effort**: small
- **files**: `packages/cli/src/commands.ts` (行 299-311, 475-480)
- **symptom**: UI 错位
- **root_cause**: 直接 console.log
- **fix_steps**: 所有多行输出前 `ctx.rawInput.unmountForMenu()`
- **verification**: 手测
- **rollback**: 单文件

---

#### R-066 [MEDIUM] Ink 监听 SIGWINCH 重渲染

- **status**: done
- **closed_in**: PR#88
- **batch**: B7
- **depends_on**: —
- **effort**: small
- **files**: `packages/cli/src/prompt.tsx` (行 265-308)
- **symptom**: 调整窗口后分隔符错位
- **root_cause**: cols 只渲染时取
- **fix_steps**: useEffect 内 `process.stdout.on('resize', ...)` 触发 setState
- **verification**: 手测
- **rollback**: 单文件

---

#### R-067 [MEDIUM] Ink 支持 bracketed paste 多行提交

- **status**: done
- **closed_in**: PR#89
- **batch**: B7
- **depends_on**: —
- **effort**: medium
- **files**: `packages/cli/src/prompt.tsx`
- **symptom**: 粘贴多行行为不一致
- **root_cause**: Ink 路径未处理
- **fix_steps**: 启用 bracketed paste，识别 `\x1b[200~` … `\x1b[201~` 后整段提交
- **verification**: 手测 paste 多行文本
- **rollback**: 单文件

---

#### R-068 [MEDIUM] Ink 非 TTY fallback

- **status**: done
- **closed_in**: PR#90
- **batch**: B7
- **depends_on**: —
- **effort**: small
- **files**: `packages/cli/src/prompt.tsx` (行 358-360)
- **symptom**: 管道/CI 挂死
- **root_cause**: 默认 TTY
- **fix_steps**: `!stdin.isTTY` 时走 readline fallback（复用 RawInput.fallbackReadLine）
- **verification**: `echo hi | plansync`
- **rollback**: 单文件

---

#### R-069 [MEDIUM] AI loop maxTurns 用户可见警告

- **status**: done
- **closed_in**: PR#91
- **batch**: B7
- **depends_on**: —
- **effort**: small
- **files**: `packages/cli/src/ai-loop.ts` (行 301, 455-457)
- **symptom**: 静默退出
- **root_cause**: 没提示
- **fix_steps**: 达到上限 → print `⚠ 已达最大轮次 (12); 请尝试更具体的请求`
- **verification**: 手测
- **rollback**: 单文件

---

#### R-070 [MEDIUM] AI loop 添加 token 预算估算

- **status**: in_progress
- **batch**: B7
- **depends_on**: R-063
- **effort**: medium
- **files**: `packages/cli/src/ai-loop.ts`, `packages/cli/src/config.ts`
- **symptom**: 40 条历史无限增长导致 LLM 拒绝
- **root_cause**: 没估算
- **fix_steps**: 用粗略 char/4 估 token，超过阈值丢最早 / 摘要
- **verification**: 单测：构造长 history → 自动裁剪
- **rollback**: 单文件

---

#### R-071 [LOW] `/worker` Ctrl+C 中断子进程

- **status**: done
- **closed_in**: PR#92
- **batch**: B7
- **depends_on**: —
- **effort**: small
- **files**: `packages/cli/src/commands.ts` (行 567-570, 669-670)
- **symptom**: SIGINT 后 launchAutoExec 仍跑完
- **root_cause**: 没 kill 子进程
- **fix_steps**: 跟踪 child PID，SIGINT → `child.kill('SIGINT')`
- **verification**: 手测
- **rollback**: 单文件

---

#### R-072 [LOW] suggestion ↓ 从未选状态进入

- **status**: done
- **closed_in**: PR#93
- **batch**: B7
- **depends_on**: —
- **effort**: small
- **files**: `packages/cli/src/prompt.tsx` (行 153-171)
- **symptom**: ↓ 不进入建议列表
- **root_cause**: 仅当 `selIdx >= 0`
- **fix_steps**: `selIdx === -1` 时 ↓ 设为 0
- **verification**: 手测
- **rollback**: 单文件

---

#### R-073 [LOW] `/code` 退出不清屏

- **status**: done
- **closed_in**: PR#94
- **batch**: B7
- **depends_on**: —
- **effort**: small
- **files**: `packages/cli/src/exec.ts` (行 331)
- **symptom**: 清屏擦掉历史
- **root_cause**: `\x1b[2J\x1b[H`
- **fix_steps**: 改为打印分隔符
- **verification**: 手测
- **rollback**: 单文件

---

#### R-074 [MEDIUM] `/project <id>` 验证项目存在

- **status**: done
- **closed_in**: PR#95
- **batch**: B7
- **depends_on**: —
- **effort**: small
- **files**: `packages/cli/src/commands.ts` (行 442-444)
- **symptom**: 切到不存在的项目 banner 显示空
- **root_cause**: 不验证
- **fix_steps**: 先调 `/api/projects/:id` → 失败给红色提示
- **verification**: 手测
- **rollback**: 单文件

---

### B8 — 数据库索引、enum、FK

---

#### R-075 [HIGH] tasks 表加复合索引

- **status**: done
- **closed_in**: PR#96
- **batch**: B8
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/prisma/schema.prisma`, 新迁移
- **symptom**: 大量全表扫
- **root_cause**: 0 索引
- **fix_steps**:
  ```prisma
  @@index([projectId, status])
  @@index([projectId, assignee])
  ```
- **verification**: EXPLAIN ANALYZE
- **rollback**: drop index

---

#### R-076 [HIGH] drift_alerts 加复合索引

- **status**: done
- **closed_in**: PR#97
- **batch**: B8
- **depends_on**: —
- **effort**: small
- **files**: schema + 迁移
- **fix_steps**: `@@index([projectId, status])`, `@@index([taskId, status])`
- **rollback**: drop

---

#### R-077 [HIGH] api_keys.keyPrefix 加索引

- **status**: done
- **closed_in**: PR#98
- **batch**: B8
- **depends_on**: —
- **effort**: small
- **files**: schema + 迁移
- **fix_steps**: `@@index([keyPrefix])`
- **rollback**: drop

---

#### R-078 [MEDIUM] webhook_deliveries 加分页索引

- **status**: done
- **closed_in**: PR#101
- **batch**: B8
- **depends_on**: —
- **effort**: small
- **files**: schema + 迁移
- **fix_steps**: `@@index([webhookId, createdAt(sort: Desc)])`
- **rollback**: drop

---

#### R-079 [HIGH] 把 String 状态字段改为 Prisma enum

- **status**: blocked
- **blocked_reason**: B4 远未完成（R-027/028/030/031/032/033/034/036/037/038/039/040 仍在 in_progress/pending），且本条 rollback 显式建议"每个 enum 单独一批"与 autonomous run 的"1 PR 只实现 1 个 R-XXX"硬约束冲突；需先等 B4 收口并把本条拆成 12 个子条目（每个 enum 一条）再 unblock。
- **batch**: B8
- **depends_on**: R-027, R-028, R-031
- **note**: Logical dependency: every B4 schema-tightening entry (R-027..R-040). The three IDs above are the load-bearing ones that lock in the canonical task / drift status enums; the rest of B4 is taste / typing tightening that can land in either order.
- **effort**: large
- **files**: schema.prisma + 大迁移
- **symptom**: typo 落库
- **root_cause**: 全 String
- **fix_steps**:
  1. 一个个迁移：先加 CHECK 约束在生产兼容，逐步改为 enum
  2. enum：`ProjectPhase`, `PlanStatus`, `TaskStatus`, `TaskType`, `TaskPriority`, `RunStatus`, `DriftSeverity`, `DriftStatus`, `ReviewStatus`, `SuggestionStatus`, `MemberType`, `MemberRole`
- **verification**: 写入 typo 字符串 → DB 拒绝
- **rollback**: 大改动建议拆 PR，每个 enum 单独一批

---

#### R-080 [MEDIUM] ApiKey.execRunId FK 到 execution_runs

- **status**: done
- **closed_in**: PR#103
- **batch**: B8
- **depends_on**: —
- **effort**: small
- **files**: schema + 迁移
- **fix_steps**: 加 relation + `onDelete: SetNull`
- **rollback**: drop FK

---

#### R-081 [MEDIUM] DriftAlert.planDiffId FK 到 plan_diffs

- **status**: done
- **closed_in**: PR#104
- **batch**: B8
- **depends_on**: —
- **effort**: small
- **fix_steps**: 加 relation + `onDelete: SetNull`

---

#### R-082 [MEDIUM] PlanDiff.fromPlanId/toPlanId FK 到 plans

- **status**: done
- **closed_in**: PR#105
- **batch**: B8
- **depends_on**: —
- **effort**: small
- **fix_steps**: 加 relation

---

#### R-083 [MEDIUM] Task.boundPlanVersion 加复合 FK

- **status**: done
- **closed_in**: PR#306
- **batch**: B8
- **depends_on**: —
- **effort**: medium
- **files**: schema + 迁移
- **fix_steps**: 加 `@relation(fields: [projectId, boundPlanVersion], references: [projectId, version])`
- **rollback**: drop

---

#### R-084 [MEDIUM] schema.prisma 标注 partial unique index

- **status**: done
- **closed_in**: PR#122
- **batch**: B8
- **depends_on**: —
- **effort**: small
- **files**: schema.prisma
- **symptom**: SQL 文件里有索引但 schema 不见，新环境 `prisma db push` 丢失
- **root_cause**: Prisma 不直接支持 partial unique
- **fix_steps**: schema 头注释 + 在迁移 README 中标注；测试 e2e 重置流程验证仍存在
- **rollback**: 文档

---

#### R-085 [LOW] 统一所有 camelCase 列名为 snake_case `@map`

- **status**: done
- **closed_in**: PR#125
- **batch**: B8
- **depends_on**: —
- **effort**: medium
- **files**: schema + 迁移
- **fix_steps**: ApiKey 等迟到的表加 `@map`
- **rollback**: revert

---

#### R-086 [LOW] PlanComment.parent 关系 onDelete 显式

- **status**: done
- **closed_in**: PR#205
- **batch**: B8
- **depends_on**: —
- **effort**: small
- **fix_steps**: `onDelete: Restrict`（或软删级联）

---

#### R-087 [LOW] DriftAlert.severity 加 default + NOT NULL

- **status**: pending
- **batch**: B8
- **depends_on**: R-079
- **effort**: small

---

### B9 — 事件总线生产可用

---

#### R-088 [CRITICAL] EventBus 替换为 Postgres LISTEN/NOTIFY 或 Redis

- **status**: done
- **closed_in**: PR#126
- **batch**: B9
- **depends_on**: —
- **interim_for**: R-163
- **effort**: large
- **files**: `packages/api/src/lib/event-bus.ts` (行 134-136), 新文件 `event-bus-pg.ts`
- **symptom**: 生产多实例 SSE 客户端收不到跨实例事件
- **root_cause**: 内存 bus 实例隔离
- **note**: B14 outbox 地基（R-160 → R-163）落地后，SSE relay 改吃 outbox（R-163），本条作为过渡补丁可独立先合；当 R-163 进入 `in_progress` 或 `done` 时，cron 自动跳过本条。
- **fix_steps**:
  1. 新增 `EventBusPG` 实现：使用 `pg` 包的 LISTEN/NOTIFY；通道 `plansync_project_<id>` + `plansync_user_<name>`
  2. 现有 EventBus 接口保留为本地代理（前端 broadcast 仍要分发到本进程订阅）
  3. env 加 `PLANSYNC_EVENT_BUS=memory|postgres`，默认 postgres（NODE_ENV=production）
- **verification**: 启 2 个 API 进程，一个 publish，另一个 SSE 客户端能收到
- **rollback**: env 切回 memory

---

#### R-089 [MEDIUM] SSE 改用 cookie 鉴权，不再支持 `?token=`

- **status**: done
- **closed_in**: PR#133
- **batch**: B9
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/src/lib/auth.ts` (行 71-77), `packages/api/src/app/api/projects/[projectId]/events/route.ts`
- **symptom**: secret 出现在 URL/access log
- **root_cause**: EventSource 不能设 header → 妥协方案
- **fix_steps**: 强制使用 cookie `plansync-apikey` 鉴权；保留 `?user=` 仅用于 master mode
- **verification**: 单测：?token= 入参 → 401
- **rollback**: 暂时回滚为兼容

---

#### R-090 [MEDIUM] SSE 加 backpressure / slow client 处理

- **status**: in_progress
- **batch**: B9
- **depends_on**: R-088
- **effort**: medium
- **files**: `packages/api/src/app/api/projects/[projectId]/events/route.ts` (行 31-45), `event-bus.ts`
- **symptom**: 慢客户端阻塞
- **root_cause**: 同步 enqueue
- **fix_steps**: 每客户端环形缓冲 + 满了强制 reconnect
- **verification**: 集成：故意 throttle 一个客户端 → 不影响其他
- **rollback**: 单文件

---

#### R-091 [LOW] MAX_SSE_CLIENTS 改为按 project 计

- **status**: in_progress
- **batch**: B9
- **depends_on**: R-088
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/events/route.ts` (行 20-22)
- **fix_steps**: 计数从全局改为 `(projectId, count)`

---

### B10 — 文档与脚本对齐

---

#### R-092 [HIGH] 构建 GitHub Action `dist/index.js`

- **status**: blocked
- **blocked_reason**: fix_step 5 要求"恢复 `.github/workflows/plansync-check.yml`"，autonomous Cloud Agent 硬约束禁止改动 `.github/workflows/*` 任何文件（同 R-132）。同时 fix_step 4 "把 action 发布到独立仓库 `plansync/drift-check-action`" 需要跨仓库发布权限，agent 无法在单 PR 内完成。建议人工接手或拆分为可独立提交的子条目（例如：build.sh 加构建步骤 + dist/ 提交 + CI guard 可单独提 PR，发布动作仓库与工作流恢复另起 owner-only 任务）。
- **batch**: B10
- **depends_on**: —
- **effort**: small
- **files**: `scripts/build.sh`, `packages/integrations/github-action/package.json`, 提交 `dist/`
- **symptom**: action 直接报 missing module
- **root_cause**: build.sh 不构建；action 还**未发布到 `plansync/drift-check-action` 仓库**，原 `.github/workflows/plansync-check.yml` 引用的 `plansync/drift-check-action@v1` 解析直接失败 `Unable to resolve action ... repository not found`
- **fix_steps**:
  1. build.sh 加 `run_local_npm run build:action --workspace=@plansync/integrations`
  2. 把构建产物 commit（或建 release artifact）
  3. CI 加守门：每个 PR 检查 dist/ 与 src/ 同步
  4. 把 action 发布到独立仓库 `plansync/drift-check-action`（或用 `uses: ./packages/integrations/github-action` 本地引用）
  5. **恢复 `.github/workflows/plansync-check.yml`**（PR #9 中已删除，删除原因见下）
- **verification**: 远端 use action → 正常
- **rollback**: revert
- **historical_note**: 在 PR #9 (2026-05-21) 删除了 `.github/workflows/plansync-check.yml`，因为 `uses: plansync/drift-check-action@v1` 仓库不存在导致每个 PR 都假红，且 GH Actions 在 step 执行前就 fail（`if` 条件管不到 `uses:` 解析）。完成本条目后用 `git revert` 那个 commit 即可恢复。

---

#### R-093 [HIGH] action 输入 api-key 加 `core.setSecret`

- **status**: done
- **closed_in**: PR#144
- **batch**: B10
- **depends_on**: —
- **effort**: small
- **files**: `packages/integrations/github-action/index.ts`
- **symptom**: GitHub log 不会自动 mask 直传输入
- **root_cause**: 没 setSecret
- **fix_steps**: `core.setSecret(apiKey)` 在拿到输入后
- **verification**: 检查 action log
- **rollback**: 单文件

---

#### R-094 [HIGH] action drift gate 范围按 PR 任务过滤

- **status**: done
- **closed_in**: PR#145
- **batch**: B10
- **depends_on**: —
- **effort**: medium
- **files**: `packages/integrations/github-action/index.ts` (行 26-28)
- **symptom**: 任意 open drift 拒 PR
- **root_cause**: 检查项目级所有 drifts
- **fix_steps**: 通过 PR 标题/branchName 或显式 task-id 输入过滤
- **verification**: 集成
- **rollback**: 单文件

---

#### R-095 [HIGH] PG_BIN / port_in_use 平台化

- **status**: done
- **closed_in**: PR#151
- **batch**: B10
- **depends_on**: —
- **effort**: small
- **files**: `scripts/dev.sh` (行 6), `scripts/setup.sh`, `scripts/pg-start.sh`, `scripts/local-node-runtime.sh` (行 150-156)
- **symptom**: macOS/laptop 失败
- **root_cause**: 硬编码 + Linux-only
- **fix_steps**:
  1. PG_BIN 探测：`/tool/pandora64/bin` → `/usr/local/pgsql/bin` → `pg_config --bindir`
  2. `port_in_use` 加 `lsof -i:$port` fallback
- **verification**: macOS 跑通
- **rollback**: 单文件

---

#### R-096 [HIGH] 删除 README 中不存在的 demo 脚本引用

- **status**: done
- **closed_in**: PR#156
- **batch**: B10
- **depends_on**: —
- **effort**: small
- **files**: `README.md` (行 67, 306, 307), `README.zh-CN.md`
- **symptom**: 文档说有 `scripts/demo-terminal.sh` / `demo-webui.js`，文件不存在
- **fix_steps**: 删除引用，或补脚本
- **verification**: grep
- **rollback**: 单文件

---

#### R-097 [HIGH] CLAUDE.md 删除"exec mode 下 task_update 允许"虚假承诺

- **status**: done
- **closed_in**: PR#163
- **batch**: B10
- **depends_on**: —
- **effort**: small
- **files**: `CLAUDE.md` (行 141)
- **symptom**: agent 按文档调 tool not found
- **fix_steps**: 删除该承诺或在 EXEC_ALLOWED 实施（与 R-021 配套决定）
- **verification**: grep
- **rollback**: 单文件

---

#### R-098 [MEDIUM] CLAUDE.md "Three contexts produce comments" 文案修正

- **status**: done
- **closed_in**: PR#283
- **batch**: B10
- **depends_on**: —
- **effort**: small
- **files**: `CLAUDE.md` (行 308)
- **fix_steps**: 改为"Three contexts produce comments — two structured templates and one free-form. Pick the matching format."
- **verification**: 阅读
- **rollback**: 单文件

---

#### R-099 [MEDIUM] `.env.example` 补 PLANSYNC*SECRET / AUTH_DISABLED / AI keys / EMAIL*\*

- **status**: in_progress
- **batch**: B10
- **depends_on**: R-035
- **effort**: small
- **files**: `.env.example`
- **fix_steps**: 加占位
- **verification**: 跟 env.ts 对齐
- **rollback**: 单文件

---

#### R-100 [MEDIUM] bin/plansync 错误消息修正 `--format=cjs` → `--format=esm`

- **status**: done
- **closed_in**: PR#211
- **batch**: B10
- **depends_on**: —
- **effort**: small
- **files**: `bin/plansync` (行 416-417)
- **fix_steps**: 改文案
- **verification**: 阅读

---

#### R-101 [MEDIUM] start-mcp 自动构建逻辑也放到 CLI 启动路径

- **status**: done
- **closed_in**: PR#307
- **batch**: B10
- **depends_on**: —
- **effort**: small
- **files**: `packages/cli/src/index.ts` (行 99-110), `bin/start-mcp` (行 36-42)
- **fix_steps**: 抽出 ensure_mcp_build 函数
- **verification**: 手测

---

#### R-102 [MEDIUM] 默认 Genie 路径可配置 / 平台化

- **status**: done
- **closed_in**: PR#284
- **batch**: B10
- **depends_on**: —
- **effort**: small
- **files**: `packages/cli/src/config.ts` (行 34-37)
- **fix_steps**: 默认 `claude` PATH lookup，明确文档化 `PLANSYNC_CODE_BIN` env
- **rollback**: 单文件

---

#### R-103 [LOW] dev.sh 不再每次清 .next

- **status**: done
- **closed_in**: PR#285
- **batch**: B10
- **depends_on**: —
- **effort**: small
- **files**: `scripts/dev.sh` (行 37-41)
- **fix_steps**: 只在脚本检测到 next.config.js 变化时清
- **rollback**: 单文件

---

### B11 — Activity log 与可观测性

---

#### R-104 [HIGH] plan PATCH 写 activity

- **status**: in_progress
- **batch**: B11
- **depends_on**: R-033
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/plans/[planId]/route.ts` (行 57-98)
- **fix_steps**: 加 `createActivity({ type: 'plan_updated' ... })`；shared/activityTypeSchema 加该 type
- **verification**: 单测

---

#### R-105 [HIGH] task PATCH 写 activity

- **status**: in_progress
- **batch**: B11
- **depends_on**: R-033
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/tasks/[taskId]/route.ts`
- **fix_steps**: 写 `task_status_changed` / `task_reassigned`

---

#### R-106 [HIGH] task DELETE 写 activity

- **status**: in_progress
- **batch**: B11
- **depends_on**: R-033
- **effort**: small
- **files**: 同上

---

#### R-107 [HIGH] drift cancel action 写 activity

- **status**: in_progress
- **batch**: B11
- **depends_on**: R-033
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/drifts/[driftId]/route.ts` (行 71-79)
- **fix_steps**: cancel 分支额外写 `task_cancelled`

---

#### R-108 [HIGH] heartbeat-scanner stale/failed 写 activity

- **status**: in_progress
- **batch**: B11
- **depends_on**: R-033
- **effort**: small
- **files**: `packages/api/src/lib/heartbeat-scanner.ts` (行 46-68)

---

#### R-109 [HIGH] comment edit/delete 写 activity

- **status**: in_progress
- **batch**: B11
- **depends_on**: R-033
- **effort**: small

---

#### R-110 [HIGH] project PATCH 写 activity

- **status**: in_progress
- **batch**: B11
- **depends_on**: R-033
- **effort**: small

---

#### R-111 [MEDIUM] logger 中间件加 correlation id

- **status**: done
- **closed_in**: PR#292
- **batch**: B11
- **depends_on**: —
- **effort**: medium
- **files**: `packages/api/src/lib/logger.ts`, 新文件 `lib/request-context.ts`, `packages/api/src/middleware.ts`
- **symptom**: 无法 trace API → drift → webhook
- **fix_steps**:
  1. middleware 生成 reqId（uuid v4）写入 response header
  2. 用 AsyncLocalStorage 暴露给业务代码
  3. logger child 自动注入 reqId
- **verification**: 一次请求所有 log 共享 reqId

---

#### R-112 [LOW] logger 用 env.LOG_LEVEL 而不是 process.env

- **status**: pending
- **batch**: B11
- **depends_on**: R-035
- **effort**: small
- **files**: `packages/api/src/lib/logger.ts` (行 3-13)

---

#### R-113 [LOW] sendMail 异步队列化

- **status**: done
- **closed_in**: PR#377
- **batch**: B11
- **depends_on**: —
- **effort**: medium
- **files**: `packages/api/src/lib/email.ts`
- **fix_steps**: setImmediate + 内存队列；失败重试

---

### B12 — 测试补齐

---

#### R-114 [HIGH] complete-human 集成测试

- **status**: in_progress
- **batch**: B12
- **depends_on**: R-046
- **effort**: small

---

#### R-115 [HIGH] tasks/conflicts 集成测试

- **status**: done
- **closed_in**: PR#212
- **batch**: B12
- **depends_on**: —
- **effort**: small

---

#### R-116 [HIGH] chat / notify / ai-draft / ai-field 集成测试

- **status**: in_progress
- **batch**: B12
- **depends_on**: R-044
- **effort**: medium

---

#### R-117 [HIGH] auth login/password/verify/logout 集成测试（不走 AUTH_DISABLED）

- **status**: pending
- **batch**: B12
- **depends_on**: R-013, R-014
- **effort**: medium

---

#### R-118 [HIGH] exec-sessions issue/revoke token 直测

- **status**: in_progress
- **batch**: B12
- **depends_on**: R-011
- **effort**: small

---

#### R-119 [HIGH] MCP execution\_\* 工具单测

- **status**: pending
- **batch**: B12
- **depends_on**: R-005, R-019, R-020
- **effort**: medium

---

#### R-120 [HIGH] MCP drift_resolve / check_task_conflicts / delegation_clear 单测

- **status**: blocked
- **blocked_reason**: B1 batch not done (R-001..R-006/R-008 still pending/in_progress) and entry is a stub with no fix_steps / files / verification to follow
- **batch**: B12
- **depends_on**: R-001, R-002, R-008
- **effort**: small
- **note**: Logical dependency on the B1 batch landing — the three IDs above are the load-bearing ones that ship the new drift-cancel and superseded-run paths these tests need to exercise.

---

#### R-121 [HIGH] MCP plan*activate/reactivate/append/review*\* 单测

- **status**: done
- **closed_in**: PR#376
- **batch**: B12
- **depends_on**: —
- **effort**: medium

---

#### R-122 [MEDIUM] webhook delivery 单测（HMAC、retry、idempotency）

- **status**: done
- **closed_in**: PR#297
- **batch**: B12
- **depends_on**: —
- **effort**: medium

---

#### R-123 [MEDIUM] auth.ts 密码缓存边界单测

- **status**: done
- **closed_in**: PR#290
- **batch**: B12
- **depends_on**: —
- **effort**: small

---

#### R-124 [MEDIUM] AI 完成验证 - 提供 AI mock 让默认 CI 也跑

- **status**: done
- **closed_in**: PR#355
- **batch**: B12
- **depends_on**: —
- **effort**: medium
- **files**: `packages/api/tests/integration/ai.test.ts`
- **fix_steps**: 注入 aiClient mock，opt-in 真 LLM；CI 默认跑 mock 路径
- **verification**: CI 报告 ai.test 不再被 skip

---

#### R-125 [MEDIUM] activity.ts 单测覆盖

- **status**: in_progress
- **batch**: B12
- **depends_on**: R-033
- **effort**: small

---

#### R-126 [MEDIUM] B1 集成端到端测试

- **status**: blocked
- **blocked_reason**: depends_on 字段写的是文本 "B1 完成" 而不是机读 R-ID 列表；实际核对 B1 批次：R-001/R-008 仍 in_progress，R-002/R-003/R-004/R-005/R-006/R-142 仍 pending（仅 R-007 done），整个 B1 端到端流程（plan v2 激活 → run superseded → SSE 触发 → ai-loop abort → user rebind → task todo → 新 run 可启动）所依赖的代码路径并未全部落地，无法在当前 master 上写出可通过的 e2e 测试；同时 fix_steps 仅给出一行场景描述，没有具体测试文件路径、断言或 fixture 设计，需在 B1 整批 done 后由人工补充再 unblock。
- **batch**: B12
- **depends_on**: R-001, R-002, R-003, R-004, R-005, R-008
- **effort**: medium
- **note**: Logical dependency on the entire B1 batch landing — these six IDs together close the drift / superseded / abort / rebind loop that this end-to-end suite exercises.
- **fix_steps**:
  - 场景：plan v2 激活 → run.status → superseded → SSE 触发 → ai-loop abort → user 调 rebind → task todo → 新 run 可启动
- **verification**: e2e 通过

---

#### R-127 [MEDIUM] 并发 claim 压力测试

- **status**: in_progress
- **batch**: B12
- **depends_on**: R-049
- **effort**: small

---

#### R-128 [MEDIUM] 并发 plan activate 压力测试

- **status**: in_progress
- **batch**: B12
- **depends_on**: R-048
- **effort**: small

---

#### R-129 [MEDIUM] SSE 多实例端到端

- **status**: blocked
- **blocked_reason**: 条目缺少 fix_steps / verification / files —— 多实例 SSE 端到端测试涉及如何 spawn 多个 Next.js 实例、如何驱动 Postgres LISTEN/NOTIFY fan-out、断言哪些事件流，全部未定义；需作者补充测试设计与最小可观测断言后再 unblock。
- **batch**: B12
- **depends_on**: R-088
- **effort**: medium

---

#### R-130 [LOW] 文档示例代码可执行测试

- **status**: done
- **closed_in**: PR#380
- **batch**: B12
- **depends_on**: —
- **effort**: medium
- **fix_steps**: 抽取 README 中的命令示例，写 smoke 测试

---

#### R-131 [HIGH] 升级 Next.js 14 → 16（修复残留 high CVE）

- **status**: blocked
- **blocked_reason**: fix_step 5 要求修改 `.github/workflows/validate.yml`（恢复 audit-level=high），autonomous Cloud Agent 硬约束禁止改动 `.github/workflows/*`；此外 fix_step 3 "处理 App Router、middleware、Pages Router compatibility" 范围开放（涉及 Next 14→15→16 两个大版本跨越、React 18→19 升级，rollback 注释也明示"大 PR，建议单独 feature branch + 灰度 + revert plan"），不适合 autonomous run 一次完成，需人工分批分发后再 unblock。
- **batch**: B10
- **depends_on**: —
- **effort**: large
- **files**: `packages/api/package.json`, `packages/api/next.config.js`, 全部 `packages/api/src/app/**` 路由
- **symptom**: `npm audit --omit=dev --audit-level=high` 报 2 个 high CVE
  ([GHSA-wfc6-r584-vfw7](https://github.com/advisories/GHSA-wfc6-r584-vfw7) cache poisoning,
  [GHSA-36qx-fr4f-26g5](https://github.com/advisories/GHSA-36qx-fr4f-26g5) middleware bypass）
- **root_cause**: Next.js 14.2.x 仅维护到 14.2.35，2 个 CVE 仅在 16.x 修复
- **fix_steps**:
  1. 阅读 [Next 14 → 15 → 16 migration guide](https://nextjs.org/docs/app/building-your-application/upgrading)
  2. 升级 `next` 到 `~16.2.x`、`react` / `react-dom` 到对应版本
  3. 处理 App Router、middleware、Pages Router compatibility
  4. 重跑所有集成 + e2e 测试
  5. 升级后 validate.yml 的 audit-level 改回 `high`
- **verification**: `npm audit --omit=dev --audit-level=high` 通过 + 所有 e2e 通过
- **rollback**: 大 PR，建议单独 feature branch + 灰度 + revert plan
- **temporary_mitigation**: validate.yml 用 `--audit-level=critical`；nightly.yml 仍跑 high+ 严扫，发现就开 issue

---

#### R-132 [HIGH] 升级 MCP SDK 并恢复 mcp-server typecheck

- **status**: blocked
- **blocked_reason**: fix_step 5 要求修改 `.github/workflows/validate.yml`（恢复 mcp-server typecheck），autonomous Cloud Agent 硬约束禁止改动 `.github/workflows/*`；同时 fix_step 2 "处理 SDK 1.3 → 1.29 之间的 breaking API" 范围开放（`server.tool` 签名 / transport 接口的具体变化未在条目中给出），需人工调研后再分发。
- **batch**: B4
- **depends_on**: —
- **effort**: medium
- **files**: `packages/mcp-server/package.json`, `packages/mcp-server/src/**`, `.github/workflows/validate.yml`
- **symptom**: `tsc --noEmit --project packages/mcp-server` 在 8 GB heap 下 OOM
- **root_cause**: `@modelcontextprotocol/sdk@1.3.0` 的 `server.tool<Args extends ZodRawShape>(...)`
  泛型 + Zod 3.x 推断在 TS 5.7 触发 TS2589 / 类型递归爆炸
- **fix_steps**:
  1. `npm install @modelcontextprotocol/sdk@^1.29.0 --workspace=@plansync/mcp-server`
  2. 处理 SDK 1.3 → 1.29 之间的 breaking API（重点：`server.tool` 签名、transport 接口）
  3. 重跑 mcp-server tests 验证 runtime 不变
  4. 本地 `npx tsc --noEmit --project packages/mcp-server/tsconfig.json` 必须在 60s 内完成且 exit 0
  5. 在 `validate.yml` 的 `typecheck` job 恢复 mcp-server 那一行（删除 NOTE 注释）
- **verification**: 本地和 CI typecheck 通过
- **rollback**: 单文件 revert package.json + workflow + 任何 API 适配
- **temporary_mitigation**: validate.yml 已注释跳过 mcp-server 的 typecheck，仅依赖 esbuild bundle 时的 syntax 检查

---

#### R-133 [MEDIUM] 逐步消除 `any`，重新启用 `no-explicit-any` 警告

- **status**: done
- **closed_in**: PR#136
- **batch**: B4
- **depends_on**: —
- **effort**: medium（可拆 sub-tasks）
- **files**: `eslint.config.mjs`, `packages/api/src/lib/ai/**`, `packages/api/src/lib/errors.ts`, `packages/mcp-server/src/api-client.ts`, `packages/mcp-server/src/index.ts`, `packages/mcp-server/src/tools/execution.ts`
- **symptom**: 现存 ~27 处 `any` 使用，ESLint 规则被关闭
- **root_cause**: 历史代码（AI 入参、错误对象、SDK 边界）使用 `any` 简化类型
- **fix_steps**:
  1. 把 `errors.ts` 里的 `any` 改为 `unknown` + 类型 narrow
  2. AI prompt 模块的入参用 `Record<string, unknown>` + 内部 narrow
  3. mcp-server 的 `any` 等 R-132 SDK 升级后大多自然消失
  4. 最后在 `eslint.config.mjs` 里把 `'@typescript-eslint/no-explicit-any': 'off'` 改回 `'warn'`
- **verification**: `npx eslint packages/*/src --max-warnings 0` 通过
- **rollback**: 单文件改动，逐文件 revert

---

#### R-134 [MEDIUM] plans.test.ts 抽出 `resetDraftPlans` helper

- **status**: done
- **batch**: B12
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/tests/helpers/request.ts`, `packages/api/tests/integration/plans.test.ts`
- **symptom**: PR #42 (R-032) CI `test` job 红 — 新加的三个 R-032 测试没在创建 draft 前清理已有 draft，被 R-036 引入的 server-side "one draft per project" guard 挡了，`POST /plans` 返回 400 而非 201，下一行 `(await res.json()).data.id` 抛 TypeError。
- **root_cause**: R-036 (PR #43) 把"每项目唯一 active draft"做成 server-side hard guard 后，plans.test.ts 里 8 处建 draft 的测试都得手动 `prisma.plan.updateMany(...) → superseded` 清场。这段 inline snippet 重复 8 次，任何新加测试只要忘抄就 CI 红。
- **fix_steps**:
  1. 在 `tests/helpers/request.ts` 新增 `resetDraftPlans(projectId)` helper，封装上述 `updateMany` 调用
  2. 替换 plans.test.ts 里全部 8 处 inline 调用为 `await resetDraftPlans(projectId)`
- **verification**:
  - `npx vitest run tests/integration/plans.test.ts` → 16/16 通过（与原行为一致）
  - 后续新加测试只需一行 `await resetDraftPlans(projectId)` 即可避开 R-036 guard，不再静默 broken
- **rollback**: 两个文件 revert
- **closed_in**: 同 PR

---

## 2026-05-22 架构审计追加条目（R-135 起）

> **背景**：在原始 B1–B12 之外，对 plan 模型 / 协议层 / 事件流 / AI 使用 / 部署形态 / 安全边界做了一次完整复审，发现一类"补丁解决不了，必须架构跃迁"的问题。新条目分两类：
>
> - **R-135..R-146**：归入既有批次的**补丁型**修复（cron 可立刻 pickup）
> - **R-150..R-203**：6 个**全新批次 B13–B18**，目标是把产品从"prompt-engineered PM tool"升级为"protocol-engineered AI orchestration runtime"
>
> Cron flow 按原规则消费（仅看 `depends_on` + `superseded_by` + `interim_for`，详见 §"给 cron job 的解析约定"）。**B13、B14 入口条目 `depends_on` 为空，可立即并行启动**；B15/B16/B17/B18 的关键 cross-batch 依赖已写入对应条目的 `depends_on`，无需人工排批次顺序。

---

### B2/B5/B6/B8/B9/B10/B11 — 追加补丁条目（R-135..R-146）

> 挂在既有批次下，没有新概念，cron 可以立刻 pickup。

---

#### R-135 [CRITICAL] task-pack 加 task↔project 归属校验，关闭跨项目读取

- **status**: done
- **closed_in**: PR#432
- **batch**: B5
- **depends_on**: —
- **effort**: small
- **files**: `packages/api/src/lib/task-pack.ts`, 全文搜 `prisma.task.findUnique` 的所有调用点
- **symptom**: 拿到任意 `taskId` + 自己合法的 `projectId`，可以通过 `plansync_task_pack` 读出另一项目里的 task 标题 / agentContext / expectedOutput / plan 全文
- **root_cause**: `buildTaskPack(taskId, projectId)` 用 `prisma.task.findUnique({ id: taskId })`，**完全不校验 `task.projectId === projectId`**
- **fix_steps**:
  1. `buildTaskPack` 第一步改为 `prisma.task.findFirst({ where: { id: taskId, projectId } })`，找不到立即 `return null`
  2. 全局搜 `prisma.task.findUnique` → 每一处都附加 projectId 谓词
  3. 增加 audit log：caller 传的 projectId ≠ task.projectId 时写 `logger.warn({ suspectCrossProject: true })`
- **verification**:
  - vitest：用 owner A 的 token 调 `task_pack(taskB_in_projectB, projectA)` → 404
  - vitest：合法组合仍 200
- **rollback**: 单文件改动

---

#### R-136 [CRITICAL] PLANSYNC_SECRET 增加 audit / 范围限制 / 强制 TTL

- **status**: in_progress
- **closed_in**: PR#673
- **batch**: B2
- **depends_on**: R-010
- **effort**: medium
- **files**: `packages/api/src/lib/auth.ts`, `packages/api/src/lib/env.ts`, 新增 `master-audit.ts`, schema 新表 `master_delegations`
- **symptom**: `PLANSYNC_SECRET` + 任意 `X-User-Name` → 以该用户身份操作；env 泄露 = 全量横向移动；目前**无审计、无白名单、无受限用户列表**
- **root_cause**: master 路径设计为开发态调试工具，但 R-010 允许生产使用后没补滥用控制
- **fix_steps**:
  1. 新增 `master-audit.ts`：每次 master delegation 命中写 `master_delegations`（who, target, route, ip, ua, at, expires_at）
  2. env.ts 新增 `PLANSYNC_MASTER_ALLOWED_TARGETS`（CSV，未配置时**生产默认禁用 master**）
  3. 新增 `PLANSYNC_MASTER_DENY_TARGETS`
  4. master 命中后**只能用于读取与 comment 类 safe write**，不能 propose/activate plan
  5. 暴露 `/api/auth/master-audit?since=` owner-only 查询
  6. **强制 TTL**：env.ts 新增 `PLANSYNC_MASTER_DELEGATION_TTL_MIN`（默认 60，最大 1440）；
     - `master_delegations` 表加 `expires_at TIMESTAMPTZ NOT NULL`，由 INSERT 时 `now() + ttl` 计算
     - master 命中（同一 caller + targetUser）若 5 分钟内已有未过期 delegation → 复用，否则新插一行
     - 每次进入 master 路径都强制比对 `expires_at > now()`，过期立即 401 + 要求重新发起 delegation；过期行不复用
     - 后台 cron / scanner 每 10min 删除 `expires_at < now() - interval '7 days'` 的历史行
- **verification**:
  - vitest：未设 ALLOWED 时生产模式调用 → 403
  - vitest：deny list 命中 → 403
  - vitest：调 plan_propose → 403
  - vitest：TTL 默认 60min；伪造 `expires_at = now() - 1s` 的行被拒，返回 401 + `code: MASTER_DELEGATION_EXPIRED`
  - vitest：连续两次 master 命中 < 5min 内只 INSERT 一行；超过 TTL 后第三次命中新插一行
- **rollback**: env flag `PLANSYNC_MASTER_LEGACY=true` 临时跳过（仅开发环境允许）

---

#### R-137 [HIGH] exec-scoped key 在缺 execRunId 时也强制 keyProjectId 校验

- **status**: in_progress
- **batch**: B2
- **depends_on**: R-011
- **effort**: small
- **files**: `packages/api/src/lib/auth.ts`（line 148-178）
- **symptom**: 历史 ApiKey 行有 `projectId` 但 `execRunId` 为 null → `requireProjectRole` 不拦截跨项目，R-011 语义被绕过
- **root_cause**: 检查条件是 `if (auth.execRunId && auth.keyProjectId && ...)`，两者 AND 才校验
- **fix_steps**:
  1. 拆为独立检查：`auth.keyProjectId && auth.keyProjectId !== projectId` → 403；`auth.execRunId && !auth.keyProjectId` → 视为脏数据 → 403
  2. `verifyApiKey` 返回时若 `projectId == null && execRunId != null` → logger 标可疑
- **verification**:
  - vitest：构造 ApiKey { projectId: P1, execRunId: null } 访问 P2 → 403

---

#### R-138 [HIGH] heartbeat-scanner 从 instrumentation 解耦，改为显式 worker 入口

- **status**: done
- **closed_in**: PR#224
- **batch**: B10
- **depends_on**: —
- **interim_for**: R-166
- **effort**: small
- **files**: `packages/api/src/instrumentation.ts`, 新增 `packages/api/scripts/run-worker.ts`, `packages/api/package.json`
- **note**: B14 落地后 R-166 一次性完成进程拆分；本条是过渡补丁，可独立先合；R-166 进入 `in_progress` 或 `done` 时 cron 自动跳过本条。
- **symptom**: Next.js 每个 Node worker 进程都开 60s 定时器；advisory lock 已解决重复工作，但浪费资源 + serverless 部署完全不工作
- **root_cause**: `instrumentation.ts` 无条件 `startHeartbeatScanner()`，把后台 worker 与 API 进程绑死
- **fix_steps**:
  1. 抽出 `packages/api/scripts/run-worker.ts` 独立进程入口
  2. `instrumentation.ts` 仅当 `process.env.PLANSYNC_RUN_WORKER_IN_API === 'true'` 启动 scanner（保留单机部署体验）
  3. `package.json` 加 `"worker": "tsx scripts/run-worker.ts"`
  4. `scripts/dev.sh` 默认设 `PLANSYNC_RUN_WORKER_IN_API=true`
- **verification**: 未设 flag 起 API → ps 看不到 60s 定时器；`npm run worker` → scanner 正常工作
- **rollback**: 单文件 + 一行 env flag；保留旧行为只需删 if 分支

---

#### R-139 [HIGH] webhook 重试改为持久化队列

- **status**: in_progress
- **batch**: B9
- **depends_on**: R-138
- **interim_for**: R-164
- **effort**: medium
- **files**: `packages/api/prisma/schema.prisma`（新表 `webhook_jobs`）, `packages/api/src/lib/webhook.ts`, 新增 `packages/api/src/lib/webhook-worker.ts`
- **note**: B14 落地后 webhook dispatcher 改吃 outbox（R-164）；本条是过渡补丁，可独立先合；R-164 进入 `in_progress` 或 `done` 时 cron 自动跳过本条。
- **symptom**: API 进程在 1s/5s/30s 重试 sleep 期间重启 → 整张重试表蒸发；用户看到失败
- **root_cause**: `deliverWithRetry` 的 schedule 完全活在 `setTimeout` + Promise 内存里，进程级状态而非 DB 级
- **fix_steps**:
  1. 新表 `webhook_jobs { id, webhookId, event, body Json, attempt, nextAttemptAt, status }`
  2. `dispatchWebhooks` 改为只 INSERT 一行（不再 inline 发 HTTP）
  3. 新增 worker：每 1s 拉取 `status='pending' AND nextAttemptAt < now()`，advisory lock，发 HTTP；按 backoff 重排
  4. worker 入口接到 R-138 的 `run-worker.ts`
- **verification**:
  - vitest：插一行 → 杀进程 → 重启 → worker 续发
  - vitest：HTTP 500 三次后 attempt 计数正确，最后标 failed
- **rollback**: env flag `PLANSYNC_WEBHOOK_QUEUE=true` 才切到新路径，旧 `deliverWithRetry` 兜底

---

#### R-140 [HIGH] 新增 `task.executionGate` 字段，区分 system block 与 owner block

- **status**: in_progress
- **batch**: B6
- **depends_on**: R-002, R-008
- **effort**: medium
- **files**: schema, `drift-engine.ts`, `drifts/[driftId]/route.ts`
- **symptom**: drift 自动 block task.status，owner 看不出"系统因 drift"还是"owner 手动"
- **fix_steps**:
  1. schema 加 `Task.executionGate String?`（`null|drift_high|drift_medium|manual_block`）
  2. drift-engine 不改 task.status，改写 executionGate
  3. `execution_start` 路径：`executionGate != null` → 拒绝
  4. `drift_resolve` 清 executionGate，**不动 status**
  5. CLI/Web banner 区分显示
- **verification**:
  - vitest：plan v2 activate → task.status 不变、executionGate='drift_high'
  - vitest：drift_resolve rebind → executionGate=null

---

#### R-141 [MEDIUM] ApiKey scrypt 热路径优化（内存缓存）

- **status**: in_progress
- **batch**: B8
- **depends_on**: R-077
- **effort**: small
- **files**: `packages/api/src/lib/auth.ts`
- **symptom**: agent 每 30s heartbeat → 每次都跑 scrypt，CPU hot spot
- **fix_steps**:
  1. `_pwCache` 抽为通用 `_authCache`，key 用 `sha256(rawKey)`
  2. `verifyApiKey` 命中写 cache，TTL 5min
  3. `lastUsedAt` 改异步更新
  4. LRU max=10000
- **verification**: 微基准 1000 次同 key < 1ms；lastUsedAt 仍刷新

---

#### R-142 [HIGH] MCP `execution_aborted` 改为 protocol-level error

- **status**: pending
- **batch**: B1
- **depends_on**: R-005
- **effort**: medium
- **files**: `packages/mcp-server/src/index.ts`, `tool-wrapper.ts`, `abort-signal.ts`
- **symptom**: 通用 MCP 客户端把 `execution_aborted` 当 chat log 渲染，agent 继续跑
- **fix_steps**:
  1. abort 触发后，所有后续工具调用立即返回 `isError: true, code: RUN_ABORTED`
  2. `tool-wrapper.ts` 内加 `if (abortSignal.aborted) return abortErrorEnvelope(...)`
  3. 保留 `sendLoggingMessage` 作软提示
  4. README + AGENTS.md 加：返回 RUN_ABORTED → 立即停止该轮
- **verification**: vitest：触发 abort → 下一个工具调用 isError + code=RUN_ABORTED
- **rollback**: env flag `PLANSYNC_MCP_LEGACY_ABORT=true`

---

#### R-143 [HIGH] completion-verify 可观测：score / breakdown / model 写库

- **status**: done
- **closed_in**: PR#176
- **batch**: B4
- **depends_on**: —
- **effort**: small
- **files**: schema（ExecutionRun 加 4 个 ai\_\* 字段）, `runs/[runId]/route.ts`
- **symptom**: AI 把合法 evidence 评 74 分 → 用户 422 但**没法看到分数明细**
- **fix_steps**:
  1. ExecutionRun 加 `aiVerifyScore Float?` / `aiVerifyBreakdown Json?` / `aiVerifyFeedback String?` / `aiVerifyModel String?`
  2. 每次 verify 调用都写 4 个字段
  3. 422 响应 body echo `runId`
  4. UI ExecutionHistory 卡片显示 breakdown
- **verification**: vitest：422 case 后 DB 行有完整字段；LLM 返回 null 时 feedback='AI unavailable, allowed through'

---

#### R-144 [MEDIUM] 新增 `ai_calls` 表，所有 LLM 调用全链路记录

- **status**: pending
- **batch**: B11
- **depends_on**: —
- **superseded_by**: R-182
- **effort**: medium
- **files**: schema, `packages/api/src/lib/ai/client.ts`
- **fix_steps**:
  1. 新表 `ai_calls { id, purpose, provider, model, promptHash, latencyMs, inputTokens?, outputTokens?, ok, errorCode?, createdAt }`
  2. `aiClient.complete` 加 `purpose` 参数，每次 INSERT
  3. `/api/ai-usage?since=` owner-only 汇总
- **verification**: vitest：drift enrich → ai_calls 多一行 purpose='drift_impact'；provider 失败 → ok=false
- **note**: 与 B16/R-182 同目标，R-182 是最终版（`R-182.supersedes` 显式列出本条）。强语义：cron 必跳过本条，pickup R-182 时由 agent 把本条状态置为 `cancelled`。

---

#### R-145 [HIGH] `PlanDiff.changes` JSON 列强制 shared zod schema 校验

- **status**: pending
- **batch**: B4
- **depends_on**: R-034
- **effort**: small
- **files**: 新增 `packages/shared/src/schemas/plan-diff.ts`, `packages/api/src/lib/ai/plan-diff.ts`
- **symptom**: `PlanDiff.changes: Json` 没 schema；消费者各自做窄投影 → 静默错位
- **fix_steps**:
  1. shared 增加 `planDiffChangesSchema`
  2. `getOrCreatePlanDiff` 写库前 `parse`
  3. 读 hot path 用 `safeParse`，失败 → 视为 stale 重新计算
  4. CI 加 schema-drift test
- **verification**: vitest：写入畸形数据立即抛错；CI `plan-diff-schema-drift.test.ts`

---

#### R-146 [HIGH] CLAUDE.md / AGENTS.md / ai-loop prompt 合并到 single source

- **status**: blocked
- **blocked_reason**: fix_step 3 强制要求新增 CI lint workflow，autonomous agent 受 hard-rule 限制不得修改 `.github/workflows/*`；同时 fix_steps 涉及对 CLAUDE.md/AGENTS.md（workspace 级 agent rule 源）做整体重写并落地 protocol.md + render-prompts.ts 双轨工具链，跨工具链 + 多 surface 重构超出单 run 安全范围，需要架构方先做拆条目设计。
- **batch**: B10
- **depends_on**: —
- **effort**: medium
- **files**: 新增 `claude-md/protocol.md`, `scripts/render-prompts.ts`, 现 `CLAUDE.md` / `AGENTS.md` / `cli/src/ai-loop.ts`
- **symptom**: 三份 prompt 已互相矛盾（syntax-inconsistencies-report Finding 8）；改一处流程要改 3 处
- **fix_steps**:
  1. 抽出 `claude-md/protocol.md`（章节用 `<!-- @block:session-start -->` 划分）
  2. `scripts/render-prompts.ts` 根据 frontmatter map 生成 3 份目标
  3. CI 加 lint：render 后 `git diff --exit-code` 必须空
  4. ai-loop `buildSystemPrompt` 改为读 `generated/cli-loop.txt`
- **verification**: 改一处 protocol.md → 三个目标一致更新；CI 在未 render 的 PR 上失败

---

### B13 — Plan-as-code：把计划升级为结构化、可寻址、可 FK 的图

> **目标**：把 `Plan.constraints/standards/deliverables: String[]` 升级为**带稳定 ID + 版本 + 类型化引用**的关系图。task 通过 FK 引用 deliverable，drift 引擎变为纯粹的图 diff，alert fatigue 物理消除。
>
> **护城河价值**：让 "plan-aware execution" 从口号变成可验证的事实；GitHub Action drift-gate 升级为语义级判定。
>
> **风险**：schema 大改 + 跨 4 个 surface 适配；**R-150 → R-157 务必严格串行**。

---

#### R-150 [CRITICAL] 设计并落地 Deliverable / Constraint / Standard 分表 schema

- **status**: done
- **closed_in**: PR#420
- **batch**: B13
- **depends_on**: —
- **effort**: large
- **files**: `packages/api/prisma/schema.prisma`, 新增 migration `2026XXXX_plan_items_split`
- **symptom**: 当前 `String[]` 无法表达版本、状态机、引用关系、独立编辑历史
- **root_cause**: 早期 MVP 选了 array-of-strings；drift v2 ref-by-string 是补丁
- **fix_steps**:
  1. 新增三张同构表：`PlanDeliverable { id, planId, slug, title, body, refType?, refUri?, status, createdAt, supersededById? }`、`PlanConstraint { id, planId, slug, body, kind, createdAt }`、`PlanStandard { id, planId, slug, body, kind, createdAt }`
  2. `slug` 在 (planId, slug) 唯一；slug 是稳定可读 ID（如 `auth/oidc-callback`）
  3. `refType ∈ ('file_glob' | 'api_spec' | 'figma_frame' | 'notion_page' | 'free')`
  4. `status ∈ ('draft' | 'active' | 'done' | 'deprecated')`，独立于 plan.status
  5. 加 (planId, status) 索引
  6. **不删旧 String[] 列**，作为 derived view
- **verification**: migration up/down OK；prisma generate OK；smoke plan_show 仍返回旧 String[] 形状
- **rollback**: down migration 删 3 表

---

#### R-151 [CRITICAL] 历史 plan 数据双写迁移：String[] → 分表

- **status**: in_progress
- **closed_in**: PR#691
- **batch**: B13
- **depends_on**: R-150
- **effort**: large
- **files**: 新 migration `2026XXXX_plan_items_backfill`, 新增 `packages/api/src/lib/plan-items.ts`
- **fix_steps**:
  1. backfill：每个 plan 把 `deliverables: String[]` 转一行 `PlanDeliverable { slug: slugify(item, i), title: item, status: 'active', refType: 'free' }`
  2. 新增 `plan-items.ts` 暴露 `writeBoth(planId, patch)` 与 `readMerged(planId)`
  3. 所有写路径必须经过 `writeBoth`；CI invariant：随机抽 plan，String[] vs 分表 1:1
- **verification**: 现有 plan 测试全过；`plan-items-mirror.test.ts`
- **rollback**: 关 backfill；`writeBoth` 退化为只写 String[]

---

#### R-152 [HIGH] plan_update / propose / activate / append 全部改写新表

- **status**: pending
- **batch**: B13
- **depends_on**: R-151
- **effort**: large
- **files**: `packages/api/src/app/api/projects/[projectId]/plans/...` 全部 plan write 路由
- **fix_steps**:
  1. `writeBoth` 内部：先写分表（事务内）→ 再 derive String[] 写回 Plan 行
  2. activate：当前版本 deliverable.status='active'，老版本对应 slug 自动 `supersededById = 新 id`
  3. `append` 工具改为给分表加行
- **verification**: 端到端 propose → review → activate，PlanDeliverable.status 转换正确

---

#### R-153 [HIGH] Task→Deliverable FK 中间表

- **status**: pending
- **batch**: B13
- **depends_on**: R-151
- **effort**: large
- **files**: schema, `task-pack.ts`, 所有 task write 路由
- **fix_steps**:
  1. 新表 `TaskDeliverableLink { taskId, deliverableId, createdAt }`
  2. backfill：`Task.planDeliverableRefs: String[]` 按 slug 查 PlanDeliverable → 写中间表
  3. task_pack 用 JOIN 取回；旧字段降级为 derived
  4. drift v2 的 `refsFromTask` 改为读中间表
- **verification**: vitest：rename slug 后 task 仍 join；drift severity 分项级别准确

---

#### R-154 [HIGH] drift-engine 切换为图 diff：基于 Deliverable.id 而非文本哈希

- **status**: pending
- **batch**: B13
- **depends_on**: R-152, R-153
- **effort**: medium
- **files**: `drift-engine.ts`, `shared/src/drift/index.ts`
- **fix_steps**:
  1. `runDriftScan` 按 deliverable.id 比对 added/removed/modified
  2. severity：引用 removed/modified.body 的 → high；引用 modified.refUri → medium；其他 → low
  3. **空中间表 task → severity=low**（不再保守 high），消除 alert fatigue
- **verification**: vitest：rename title 但 id 不变 → 不触发 high；删除一条 deliverable → 仅引用它的 task 触发 high

---

#### R-155 [HIGH] 新增 `plansync_deliverable_*` MCP 工具集（list / show / create / update / supersede）

- **status**: pending
- **batch**: B13
- **depends_on**: R-152
- **effort**: medium
- **files**: 新增 `packages/mcp-server/src/tools/deliverable.ts`, 新路由 `.../plans/[planId]/deliverables/...`
- **fix_steps**:
  1. 5 个工具：list / show / create / update / supersede
  2. owner-only writes；plan_suggest 增加 `deliverableId?` 字段
- **verification**: MCP smoke 全过

---

#### R-156 [MEDIUM] Web UI Deliverable 状态时间线 + per-deliverable 评论

- **status**: pending
- **batch**: B13
- **depends_on**: R-155
- **effort**: medium
- **files**: 新增 `packages/api/src/components/plan/deliverable-timeline.tsx`, `packages/api/src/app/projects/[projectId]/plans/[planId]/deliverables/page.tsx`
- **fix_steps**:
  1. 每个 deliverable 一张卡片：status badge、引用它的 task 列表、historical superseded 链
  2. 挂 comment thread（PlanComment 加 `deliverableId`）
- **verification**:
  - playwright：打开计划页 → 看到 deliverable 卡片，状态 badge 与 API 返回一致
  - vitest：`PlanComment.deliverableId` 在创建评论后正确写入并能按 deliverable 过滤拉取

---

#### R-157 [HIGH] GitHub Action drift-gate 升级为语义 gate

- **status**: pending
- **batch**: B13
- **depends_on**: R-150, R-152, R-155
- **effort**: medium
- **files**: `packages/integrations/github-action/index.ts`, `action.yml`
- **symptom**: 当前 drift-gate 只做 "open drift count > 0?" 的二元判断，无法检测 "PR 修改的文件根本不属于任何 active deliverable" 这类语义 drift
- **root_cause**: GitHub Action 与 plan 语义脱节；plan 中也没有结构化的 file_glob 引用可消费——必须先有 R-150 schema、R-152 写路径、R-155 deliverable API 才能落地
- **fix_steps**:
  1. action 拉取 PR changed files
  2. 调 `/api/projects/.../deliverables?type=file_glob`（**该 API 由 R-155 引入**）获取 active glob 列表
  3. PR changed files 至少匹配一条？不匹配 → fail check + 评论 "修改的文件不在 deliverable 范围"
  4. 匹配但有 open drift → 旧逻辑保留
- **verification**: 改无关文件 → action 失败；改 glob 内文件 → 通过
- **rollback**: `action.yml` 提供 `legacyMode: true` 输入参数，回退到旧 "open drift count" 判定

---

### B14 — Outbox + 持久事件流：把 in-memory 事件总线送进土

> **目标**：每条 state-changing 事件在**同一个 DB 事务**里写进 `domain_events`；SSE / webhook / email / scanner 全部变成 outbox 消费者。
>
> **护城河价值**：消除 in-memory EventBus、in-memory webhook 重试、SSE 丢消息三类 bug；产品具备多副本能力 + 完整审计。

---

#### R-160 [CRITICAL] 新增 `domain_events` 表 + 事务内 Outbox writer API

- **status**: done
- **closed_in**: PR#250, PR#388
- **batch**: B14
- **depends_on**: —
- **effort**: medium
- **files**: schema, 新增 `packages/api/src/lib/outbox.ts`
- **fix_steps**:
  1. `DomainEvent { id bigserial, eventType, projectId?, userName?, payload Json, createdAt, deliveredAt?, attempt }`
  2. 索引 (deliveredAt is null, id ASC)
  3. `outbox.ts` 暴露 `await outbox.emit(tx, eventType, payload)`——只在 tx 内调用
  4. shared 加 `domainEventPayloadSchema`（discriminated union）
- **verification**: vitest：tx 内 emit + rollback → 不存在；commit 后存在且通过 schema

---

#### R-161 [CRITICAL] 全部 `eventBus.publish` 改写 `outbox.emit`

- **status**: blocked
- **blocked_reason**: 当前 fix_steps 让 R-161 单独发版会让 SSE/webhook/email/activity 在 R-162（worker）落地之前全部静默丢失；同时该改动需要重写 `drift-engine-side-effects.test.ts`、`drift-engine-notifications.test.ts`、`r052-reactivate-tx.test.ts`、`activity.test.ts` 等约 30 处 spy 断言，与 verification 字段只列 1 条 vitest 不匹配。建议把 R-161 + R-162 合并为一次原子迁移，或先引入 dual-write 过渡条目（同时调旧 sink 与 outbox.emit），再补 R-161 的最终切换。
- **batch**: B14
- **depends_on**: R-160
- **effort**: large
- **files**: 全部含 `eventBus.publish` 的 route.ts（~20 个）, `drift-engine.ts`, `heartbeat-scanner.ts`
- **fix_steps**:
  1. 全局搜替换：`eventBus.publish | dispatchWebhooks | sendMail | createActivity` → `outbox.emit(tx, ...)`
  2. tx 外的调用用 `outbox.emitOutOfTx(...)` 起独立 1-row tx
  3. 旧 sinks 暂时保留——由 worker 调用
- **verification**: vitest：plan_activate 后 domain_events 表有正确事件序列
- **rollback**: env flag 双路 dispatch

---

#### R-162 [CRITICAL] 新增 plansync-worker 进程：消费 outbox 扇出到旧 sinks

- **status**: pending
- **batch**: B14
- **depends_on**: R-161, R-138
- **effort**: large
- **files**: `packages/api/scripts/run-worker.ts`, 新增 `outbox-consumer.ts`
- **fix_steps**:
  1. worker 用 `LISTEN domain_events_new`（trigger NOTIFY on insert）+ fallback 1s 轮询
  2. FOR UPDATE SKIP LOCKED 取 batch，按 eventType dispatch
  3. 成功后 UPDATE deliveredAt=now()
  4. 失败 → attempt++，exponential 重试
- **verification**: 多副本 API → 单 worker fanout；杀 worker → 重启后未交付事件继续派发

---

#### R-163 [HIGH] SSE relay 改为 worker 推送 + 支持 `lastEventId` 回放

- **status**: pending
- **batch**: B14
- **depends_on**: R-162
- **effort**: medium
- **files**: `events/route.ts`, `user-events/route.ts`, `event-bus.ts`
- **fix_steps**:
  1. SSE 路由接 `Last-Event-ID` header → 先 SELECT 回放再 attach live
  2. SSE event id = DomainEvent.id（连续 bigserial）
  3. EventBus 改为 worker-only；API 进程不持 listeners
- **verification**: 断线 5s 重连不丢事件；vitest：Last-Event-ID 能拉到之前 10 条

---

#### R-164 [HIGH] Webhook dispatcher 改吃 outbox（取代 R-139 过渡）

- **status**: pending
- **batch**: B14
- **depends_on**: R-162, R-139
- **effort**: small
- **files**: `webhook-worker.ts`
- **fix_steps**:
  1. outbox-consumer 拉到匹配 event → 写 `webhook_jobs`
  2. webhook-worker 继续从 jobs 表消费
- **verification**: R-139 测试通过 + 多副本不重复

---

#### R-165 [HIGH] Email 改为 outbox 消费者，加去重 + 限流

- **status**: pending
- **batch**: B14
- **depends_on**: R-162
- **effort**: small
- **files**: `email.ts`, outbox-consumer
- **fix_steps**:
  1. Email 不再 inline send；worker pull `eventType IN (drift_detected | review_requested | ...)`
  2. 5min 内同 (user, eventType, taskId) 去重
- **verification**: vitest：5min 内同 user 多次 drift → 只发 1 封

---

#### R-166 [HIGH] 删除 instrumentation 启动 scanner，scanner 改吃 outbox

- **status**: pending
- **batch**: B14
- **depends_on**: R-138, R-162
- **effort**: small
- **files**: `instrumentation.ts`, `heartbeat-scanner.ts`
- **fix_steps**:
  1. scanner 移到 worker 进程独立 timer
  2. scanner state change（stale/failed/superseded）必须经 outbox
  3. 完全删除 `startHeartbeatScanner` 启动路径
- **verification**: 起 API 进程 → 无定时器；多 API 副本 + 单 worker → 不重复扫

---

### B15 — Protocol-as-state-machine：流程从 prose 变 mechanism

> **目标**：消除"agent 必须读 CLAUDE.md 才能做对事"。流程编码到 MCP server 状态机里，乱序调用直接 reject。
>
> **护城河价值**：把产品从"prompt-engineered"升级为"protocol-engineered"。

---

#### R-170 [CRITICAL] 设计 ExecContextToken + nextRequired 状态机协议

- **status**: done
- **closed_in**: PR#393
- **batch**: B15
- **depends_on**: —
- **effort**: medium
- **files**: 新增 `packages/shared/src/protocol/exec-state.ts`, `docs/PROTOCOL.md`
- **fix_steps**:
  1. 有限状态机：`UNINITIALIZED → CONTEXT_LOADED → PACK_FETCHED → RUN_STARTED → COMPLETED | ABORTED`
  2. 每个状态定义 `allowedTools: string[]` 与 `requiredNextOneOf: string[]`
  3. server 端返回 opaque `stateToken`（HMAC of {runId, state, ts}）
  4. 后续工具必须带 token；状态非 allowed → reject `OUT_OF_SEQUENCE`
  5. 文档化状态图
- **verification**: 设计 review 文档 merged

---

#### R-171 [HIGH] MCP server 实施 stateToken 校验 + OUT_OF_SEQUENCE error

- **status**: in_progress
- **closed_in**: PR#651
- **batch**: B15
- **depends_on**: R-170
- **effort**: large
- **files**: `tool-wrapper.ts`, 所有 `tools/*.ts`
- **fix_steps**:
  1. wrapper 内 `validateStateTransition(stateToken, toolName)` → 失败返回 OUT_OF_SEQUENCE + hint
  2. handler 完成后返回新 stateToken
  3. exec-mode 绑死 token
- **verification**: vitest：跳过 task_pack 直接 complete → OUT_OF_SEQUENCE；合法顺序无回归
- **rollback**: env flag

---

#### R-172 [HIGH] CLAUDE.md 重写为 thin pointer

- **status**: pending
- **batch**: B15
- **depends_on**: R-171, R-146
- **effort**: medium
- **files**: `CLAUDE.md`, `claude-md/protocol.md`
- **fix_steps**:
  1. CLAUDE.md 仅留产品介绍 + "流程错误以工具返回的 OUT_OF_SEQUENCE.nextRequired 为准"
  2. 删 ~400 行流程描述（协议已强制）
  3. 保留 comment 模板等内容质量指引
- **verification**: syntax-inconsistencies-report 中 5 条 HIGH 变成 N/A

---

#### R-173 [HIGH] AGENTS.md 与 CLAUDE.md 合并到 generated source

- **status**: pending
- **batch**: B15
- **depends_on**: R-146, R-172
- **effort**: small
- **files**: `claude-md/protocol.md`, `scripts/render-prompts.ts`, `CLAUDE.md`, `AGENTS.md`
- **fix_steps**: 一处权威源；render 输出 2 份目标
- **verification**: CI 强制 render 一致（`npm run render:prompts && git diff --exit-code` 必须空）

---

#### R-174 [MEDIUM] CLI ai-loop system prompt 从 generated source 注入

- **status**: pending
- **batch**: B15
- **depends_on**: R-146
- **effort**: small
- **files**: `packages/cli/src/ai-loop.ts`
- **fix_steps**: `buildSystemPrompt` 改为读 `generated/system-prompt.txt`
- **verification**: vitest：mock 文件读取 → `buildSystemPrompt` 输出与 generated 文件一致；缺文件时给出明确错误

---

#### R-175 [HIGH] MCP tool surface 收敛到 ≤ 12 个

- **status**: in_progress
- **closed_in**: PR#664
- **note**: Sliced into 3 PRs by fix*step number. step 1 (plan*_*append → plan_patch) is in flight in PR#664; steps 2 (execution*_ → run) and 3 (task\_\* → task) will each ship as separate follow-up PRs to keep merge-conflict surface bounded.
- **batch**: B15
- **depends_on**: R-027, R-030
- **effort**: large
- **files**: `packages/mcp-server/src/tools/*.ts`, `cli/src/ai-loop.ts`
- **fix_steps**:
  1. 合并 4 个 `*_append` → `plan_patch(planId, patch)`
  2. `execution_start/heartbeat/complete` → `run(runId, action)`
  3. `task_create/update/claim/decline/rebind` → `task(action, args)`
  4. 目标：`plan_show / plan_patch / plan_propose / plan_activate / task_show / task_patch / run / drift_resolve / comment / suggest / exec_context / status` ≤ 12
  5. 老工具名保留 deprecated alias 一个 release
- **verification**: tools/list ≤ 12；LLM eval：新接口准确率 ≥ 老接口

---

#### R-176 [MEDIUM] 文档↔工具一致性 contract test

- **status**: pending
- **batch**: B15
- **depends_on**: R-172, R-175
- **effort**: small
- **files**: 新增 `packages/mcp-server/tests/integration/docs-contract.test.ts`
- **fix_steps**: 扫 protocol.md / CLAUDE.md / AGENTS.md 抽 `plansync_*` 与 tools/list 比对
- **verification**: CI 红 → 任一边漂移立刻发现

---

### B16 — AI 从 gate 变 advisor：消除"AI 错杀合法提交"

> **目标**：LLM 只写建议、生成评语；真正的 gate 是**规则化、可编辑、可解释**的 verifier。

---

#### R-180 [HIGH] completion-verify 改为 advisory：永不 422

- **status**: pending
- **batch**: B16
- **depends_on**: R-143
- **effort**: small
- **files**: `runs/[runId]/route.ts`
- **fix_steps**:
  1. 删除 422 分支
  2. AI score < 75 → 写 `RunReview { runId, kind: 'ai_verification', score, feedback }`
  3. complete 永远放行（hard gate 转给 R-181）
- **verification**: 旧"AI 评 74 拒绝" case 现在 complete 成功 + 留下 advisory 评论

---

#### R-181 [HIGH] 声明式 `verification_rules` 表 + 评估器

- **status**: pending
- **batch**: B16
- **depends_on**: R-180
- **effort**: large
- **files**: schema, 新增 `packages/api/src/lib/verification-rules.ts`, owner UI
- **fix_steps**:
  1. `VerificationRule { id, projectId, scope, scopeValue?, kind, params Json }`
  2. kind: `require_files_changed` / `require_commits_on_branch` / `require_pr_merged` / `require_deliverable_evidence_for_each_ref` / `min_output_summary_chars`
  3. complete 调评估器 → 失败 422 + 列出失败规则
  4. owner UI 编辑规则
- **verification**: vitest：require_files_changed 在空 filesChanged 时拒绝；规则可被 owner 关闭

---

#### R-182 [HIGH] ai_calls 表 + provider observability（合并/取代 R-144）

- **status**: done
- **closed_in**: PR#398, PR#508
- **batch**: B16
- **depends_on**: —
- **supersedes**: R-144
- **effort**: medium
- **files**: schema 新表 `ai_calls`（同 R-144），`packages/api/src/lib/ai/client.ts`
- **note**: pickup 本条时，agent 必须同步把 R-144 状态置为 `cancelled (superseded_by R-182)` 并 commit，避免重复 migration / 重复 PR；详见 §"给 cron job 的解析约定"。
- **symptom**: LLM 调用全无 observability：无 cost / latency / model / dedup；无法 ROI 评估；同 input 重复打到 provider
- **root_cause**: `aiClient.complete` 只 logger.warn 失败，不记录任何成功调用元数据
- **fix_steps**:
  1. 实现 R-144 全部 fix_steps（新表 + INSERT + `/api/ai-usage`）
  2. 额外字段：`inputHash`（sha256 of system+user）、`outputHash`、`promptVersion`
  3. `/api/ai-usage` 按 purpose 聚合（count / p50 latency / total token / cache hit ratio）
  4. R-183 缓存逻辑可直接 key=inputHash
- **verification**:
  - vitest：同一 prompt 第二次调用 → cache 命中（依赖 R-183 实现后验证），ai_calls 行 `cacheHit=true`
  - vitest：provider 切换时新行 `provider` 字段正确
- **rollback**: 单表 + 单文件；env flag `PLANSYNC_AI_OBSERVABILITY=false` 关闭 INSERT

---

#### R-183 [MEDIUM] AI provider fallback + 限流 + 缓存

- **status**: in_progress
- **batch**: B16
- **depends_on**: R-182
- **effort**: medium
- **files**: `packages/api/src/lib/ai/client.ts`
- **fix_steps**:
  1. provider 改为有序数组 `[AMD, Anthropic]`，第一个失败/限流 → fallback
  2. 同 inputHash + purpose 5min 内复用结果
  3. token-bucket 限流（per purpose）
- **verification**: mock AMD 限流 → 命中 Anthropic；缓存命中计数器 +1

---

#### R-184 [MEDIUM] UI/CLI 区分 "AI 建议" vs "规则 gate"

- **status**: pending
- **batch**: B16
- **depends_on**: R-180, R-181
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/tasks/[taskId]/runs/[runId]/route.ts`, `packages/api/src/components/run/run-status.tsx`, `packages/cli/src/commands.ts`
- **fix_steps**:
  1. complete 失败 error envelope 区分 `gate: 'rule'` vs `advisory: 'ai_low_score'`
  2. UI 不同颜色 / icon
  3. CLI `/explain rule <id>`
- **verification**:
  - vitest：rule gate 命中 → 422 body `{ gate: 'rule', ruleId: ... }`；AI 评低分 → 200 但响应含 `advisory.kind === 'ai_low_score'`
  - playwright：UI 在两种场景渲染不同 badge

---

### B17 — Git 真集成：让 plan-aware 与 code-aware 闭环

> **目标**：commit / PR / merge 状态作为 task 状态的输入源；不再依赖 agent 自报 filesChanged。

---

#### R-190 [HIGH] 接收 GitHub webhook：push / pull_request / pull_request_review

- **status**: pending
- **batch**: B17
- **depends_on**: R-160
- **effort**: medium
- **files**: 新增 `packages/api/src/app/api/integrations/github/webhook/route.ts`
- **fix_steps**:
  1. 验证 GitHub HMAC
  2. 解析事件 → 写 `domain_events`（eventType=`github_push` 等）
  3. 项目级配置 `Project.githubRepo` + `Project.githubWebhookSecret`
- **verification**: vitest：错 HMAC → 401；正确 push → `domain_events` 表新增一行 `eventType='github_push'`；payload 字段 schema-parse 通过

---

#### R-191 [HIGH] commit↔deliverable 关联表 + 自动推导

- **status**: pending
- **batch**: B17
- **depends_on**: R-190, R-150
- **effort**: medium
- **files**: schema 新表 `CommitDeliverableLink { sha, deliverableId, matchedBy }`, 新增 `packages/api/src/lib/git/link-commits.ts`
- **fix_steps**:
  1. worker 消费 `github_push` → 对每个 commit 比对文件 vs deliverable.refUri → 写关联
  2. commit message 含 `[deliverable:<slug>]` 时强匹配优先
- **verification**: vitest：构造一个 push 事件 → 文件命中 deliverable A 的 glob → 写入 `CommitDeliverableLink(sha, A, matchedBy='glob')`；带 `[deliverable:slug]` 的 commit → `matchedBy='message'`

---

#### R-192 [HIGH] task 状态从 git + verification rules 自动推导

- **status**: pending
- **batch**: B17
- **depends_on**: R-181, R-191
- **effort**: medium
- **files**: `packages/api/src/app/api/projects/[projectId]/tasks/[taskId]/runs/[runId]/route.ts`, `packages/api/src/lib/task-state-machine.ts`
- **fix_steps**:
  1. task.complete 不再由 agent 单方面发起；改 `request_complete` → 系统判 (PR merged) ∧ (deliverable evidence) ∧ (no drift) → auto done
  2. 任一未达成 → status='awaiting_evidence' + 列出缺失项
- **verification**: vitest：PR 未合并 → status='awaiting_evidence'，response.missing 包含 `pr_merged`；全部命中 → status='done'

---

#### R-193 [MEDIUM] PR template 自动注入 deliverable refs + drift 状态

- **status**: pending
- **batch**: B17
- **depends_on**: R-157, R-191
- **effort**: small
- **files**: `packages/integrations/github-action/src/index.ts`, `packages/integrations/github-action/action.yml`
- **fix_steps**: GitHub Action 在 PR 创建/更新时，update PR body 一段 `<!-- plansync-status -->...<!-- /plansync-status -->`
- **verification**: action 集成测试：构造 PR 事件 → 调用 mock GitHub API → 看到 PR body 被注入 `<!-- plansync-status -->` 块；二次运行只更新块内内容、不重复追加

---

### B18 — Service 拆分 + view-model 共享：让三个 surface 一致

> **目标**：消除 Web/CLI/MCP 三 surface 各自实现一遍业务逻辑的 N=3 重复。
>
> **护城河价值**：B7（CLI 体验对齐）这类 batch 不再需要——一处修改、三处生效。

---

#### R-200 [HIGH] 抽出 `@plansync/client-core` view-model 包

- **status**: in_progress
- **batch**: B18
- **depends_on**: R-027, R-030
- **effort**: large
- **files**: 新建 `packages/client-core/`
- **fix_steps**:
  1. 暴露 `ProjectStore` / `PlanStore` / `TaskStore` / `DriftStore` / `RunStore`，状态机驱动
  2. 内置 SSE 订阅、增量更新、optimistic update
  3. 接口 `api: ApiClient`，三 surface 各实现 transport
- **verification**: vitest：mock api → store 状态变化符合预期

---

#### R-201 [HIGH] Web 与 CLI 改用 client-core

- **status**: pending
- **batch**: B18
- **depends_on**: R-200
- **effort**: large
- **files**: `packages/api/src/components/**`, `packages/cli/src/commands.ts`, `packages/cli/src/ai-loop.ts`, `packages/cli/src/sse-listener.ts`, 新增 `packages/client-core/`（由 R-200 提供）
- **fix_steps**:
  1. Web RSC + client components 改用 client-core stores
  2. CLI commands.ts / ai-loop.ts / sse-listener.ts 改用同组 store
  3. **B7 中 CLI/Web 不一致条目** → 大量 close as cancelled
- **verification**: 全包 `npm run build`、`npm run test` 全绿；旧 fetch 直调代码搜不到（`[ "$(grep -rc 'psRequest' packages/cli/src/commands.ts)" -eq 0 ]`）

---

#### R-202 [HIGH] 拆 plansync-web 为独立部署单元

- **status**: pending
- **batch**: B18
- **depends_on**: R-166
- **effort**: large
- **files**: 新建 `packages/web/`
- **note**: R-138 是 R-166 的 interim_for 过渡条目；`depends_on` 不应同时列出二者，否则当 R-166 先 done 时 R-138 自动 cancelled，cron 把它视为依赖满足是正确行为，但同时列出会让人误以为 R-138 必须独立完成。规范由本条改为只依赖终态条目 R-166。
- **fix_steps**:
  1. API 包仅保留 `/api/*` + worker
  2. web 包保留 RSC + 客户端组件，调 API via env URL
  3. 部署文档：单机用 next.js + worker；多机/serverless 用三服务
- **verification**: `packages/web` 可在没有 `packages/api` 同进程的情况下启动；e2e：通过 env `PLANSYNC_API_URL` 指向 API 实例时 UI 流程不回归

---

#### R-203 [MEDIUM] 部署拓扑文档化 + docker-compose / k8s helm chart

- **status**: pending
- **batch**: B18
- **depends_on**: R-202
- **effort**: medium
- **files**: 新增 `deploy/docker-compose.yml`, `deploy/helm/`
- **fix_steps**:
  1. 三服务：plansync-api, plansync-web, plansync-worker
  2. 一份 Postgres、可选 Redis
  3. README 增加部署矩阵
- **verification**: `docker-compose up` 三服务全部 healthy；`helm template deploy/helm` 输出通过 `kubectl --dry-run=client apply -f -` 校验

---

## Cron Job 调度建议

### 推荐节奏

| 频率             | 任务                                                                         |
| ---------------- | ---------------------------------------------------------------------------- |
| **每天 02:00**   | 拉一次 master，扫描 `pending` 任务，按严重度+依赖筛出 3-5 个，开 Cloud Agent |
| **每天 18:00**   | 检查 PR 状态，自动 merge 通过 CI 的 draft → ready                            |
| **每周一 09:00** | 输出本周 burn-down 报告（已 done / 仍 pending）                              |

### 简单实现思路（伪代码）

> 实现完整去重过滤：`status=pending` ∧ `superseded_by` 为空 ∧（`interim_for` 为空 ∨ 目标条目状态 ∉ {in_progress, done, cancelled}）∧ 全部 `depends_on` 已 `done` 或 `cancelled`，并按严重度降序取首个。
>
> Bash 解析能力有限，**生产请改用** `scripts/lint-remediation.mjs --dispatch`（Node 解析器，按本文档的机读字段语义工作）。下面是仅供说明的最小可运行示例。

```bash
#!/usr/bin/env bash
# /opt/plansync-cron/dispatch.sh
# Production-quality dispatcher. Prefers the Node helper for correctness;
# falls back to the in-script bash logic only when node is unavailable
# (e.g. minimal cron host). Both paths implement the same spec from
# §"给 cron job 的解析约定".
set -euo pipefail
cd /opt/plansync-repo
git fetch origin && git checkout master && git pull

# ---- Preferred path: scripts/lint-remediation.mjs --dispatch ---------------
# Pure-Node parser, fully tested in CI; output is the chosen R-ID on stdout
# (or empty if there is no pickable candidate). Lint errors abort the run.
if command -v node >/dev/null 2>&1 && [ -f scripts/lint-remediation.mjs ]; then
  PICK="$(node scripts/lint-remediation.mjs --dispatch || exit 99)"
  case "${PICK:-}" in
    R-[0-9][0-9][0-9]) ;;             # ok
    "")    echo "No pickable entry"; exit 0 ;;
    *)     echo "lint-remediation --dispatch returned unexpected: '$PICK'"; exit 1 ;;
  esac
else
  # ---- Fallback: pure bash (POSIX awk only, no gawk extensions) ------------
  field_of() {
    local id="$1" key="$2"
    # POSIX awk: no gawk-specific match($0, re, m) third arg. We walk from
    # the section header to the next ^#### R- (exclusive) and capture the
    # field value with sub().
    awk -v id="$id" -v key="$key" '
      BEGIN { inside = 0 }
      /^#### R-[0-9]+ / {
        if (inside) exit
        if ($2 == id) { inside = 1; next }
      }
      inside && $0 ~ "^- \\*\\*" key "\\*\\*:" {
        sub("^- \\*\\*" key "\\*\\*:[[:space:]]*", "")
        print
        exit
      }
    ' docs/REMEDIATION_PLAN.md
  }
  status_of()        { field_of "$1" status | awk '{print $1}'; }
  deps_of()          { field_of "$1" depends_on; }
  superseded_by_of() { field_of "$1" superseded_by; }
  interim_for_of()   { field_of "$1" interim_for; }

  sev_weight() {
    case "$1" in
      CRITICAL) echo 4 ;; HIGH) echo 3 ;; MEDIUM) echo 2 ;; LOW) echo 1 ;;
      *)        echo 0 ;;
    esac
  }

  # POSIX awk: extract R-ID + severity from headers. The previous draft of
  # this loop used gawk's `match(...,m)` 3-arg form, which is not portable
  # (#357). Use sub() instead.
  CANDIDATES=$(awk '
    /^#### R-[0-9]+ \[[A-Z]+\] / {
      sev = $0
      sub(/^.*\[/, "", sev); sub(/\].*$/, "", sev)
      print $2 " " sev
    }
  ' docs/REMEDIATION_PLAN.md)

  PICK=""
  PICK_WEIGHT=-1
  while IFS=' ' read -r ID SEV; do
    [ -z "$ID" ] && continue
    [ "$(status_of "$ID")" = "pending" ] || continue
    SUP=$(superseded_by_of "$ID")
    [ -n "$SUP" ] && [ "$SUP" != "—" ] && continue
    INT=$(interim_for_of "$ID")
    if [ -n "$INT" ] && [ "$INT" != "—" ]; then
      case "$(status_of "$INT")" in
        in_progress|done|cancelled) continue ;;
      esac
    fi
    DEPS=$(deps_of "$ID")
    if [ -n "$DEPS" ] && [ "$DEPS" != "—" ]; then
      UNMET=0
      for D in $(echo "$DEPS" | tr ',' ' '); do
        D=$(echo "$D" | xargs)
        [ -z "$D" ] && continue
        case "$(status_of "$D")" in
          done|cancelled) ;;
          *) UNMET=1; break ;;
        esac
      done
      [ $UNMET -eq 1 ] && continue
    fi
    # Candidate. R-ID natural-order tie-break on equal severity (#328): we
    # only update PICK when the new weight is STRICTLY greater, so the
    # first R-ID at any given weight wins; since CANDIDATES is emitted in
    # file order (R-001, R-002, ...) this matches the spec.
    W=$(sev_weight "$SEV")
    if [ "$W" -gt "$PICK_WEIGHT" ]; then
      PICK="$ID"
      PICK_WEIGHT="$W"
    fi
  done <<<"$CANDIDATES"

  [ -z "$PICK" ] && { echo "No pickable entry"; exit 0; }
fi

# ---- Dispatch ---------------------------------------------------------------
# The agent prompt explicitly tells the agent to update supersedes targets
# to status: cancelled and add cancelled_by: $PICK to each — without that
# bookkeeping, the next cron tick would re-pickup the same R-YYY.
cursor-agent dispatch \
  --prompt "Implement task $PICK from docs/REMEDIATION_PLAN.md. Read the file, find the section for $PICK, follow fix_steps exactly, add verification tests, open a PR. If the entry has a 'supersedes:' field, for each listed R-YYY set status: cancelled and append cancelled_by: $PICK in the same PR. After PR is opened, update the entry to status: in_progress + closed_in: <PR URL>." \
  --base master \
  --branch "cursor/$PICK-auto"
```

### 安全栏

1. **永远不让 cron 自动 merge 涉及 CRITICAL 修复的 PR** —— 这些必须人工 review
2. **每次 cron 至少留 24h** 让 PR 进 CI、人工 review
3. **依赖图断裂时 cron 暂停**，避免乱序合并
4. **每周生成进度报告**，能看到 backlog 在缩

---

## 附录 A — 完整问题索引

| ID    | 严重度   | 批次 | 标题                                                                           |
| ----- | -------- | ---- | ------------------------------------------------------------------------------ |
| R-001 | CRITICAL | B1   | 禁用 AI 后台自动解决 drift                                                     |
| R-002 | CRITICAL | B1   | drift 触发时取消正在跑的 ExecutionRun                                          |
| R-003 | CRITICAL | B1   | heartbeat / complete 加 run-task 版本对齐校验                                  |
| R-004 | HIGH     | B1   | rebind 行为升级为"显式重启"                                                    |
| R-005 | HIGH     | B1   | MCP heartbeat 把 superseded 转 agent abort                                     |
| R-006 | HIGH     | B1   | drift complete-gate 同时检查 run 版本                                          |
| R-007 | MEDIUM   | B1   | drift-engine 事件/邮件移到事务提交后                                           |
| R-008 | HIGH     | B1   | 新增 `superseded` execution run 状态                                           |
| R-009 | CRITICAL | B2   | heartbeat/complete 接口加 executor 身份校验                                    |
| R-010 | CRITICAL | B2   | 生产环境拒绝 PLANSYNC_SECRET 默认值                                            |
| R-011 | HIGH     | B2   | exec-scoped API key 绑定到 projectId                                           |
| R-012 | HIGH     | B2   | execution_start 不再自动注册 agent 成员                                        |
| R-013 | HIGH     | B2   | 首次登录开放注册改为受控                                                       |
| R-014 | MEDIUM   | B2   | 密码 Bearer 模式仅开发环境保留                                                 |
| R-015 | HIGH     | B2   | 给所有 owner-only 写路由加 requireNotExecScoped                                |
| R-016 | HIGH     | B2   | 委托模式 task tools 使用 withUser                                              |
| R-017 | HIGH     | B2   | withUser 在普通 API key 下抛错                                                 |
| R-018 | HIGH     | B2   | my_work 跨项目模式尊重 agentName                                               |
| R-019 | MEDIUM   | B2   | exec_context 区分 fatal/transient 错误                                         |
| R-020 | MEDIUM   | B2   | exec_context 有 drift 时不启心跳                                               |
| R-021 | CRITICAL | B3   | MCP 子进程崩溃可检测可自动恢复                                                 |
| R-022 | HIGH     | B3   | MCP callTool 加单次重试                                                        |
| R-023 | HIGH     | B3   | SSE listener 对 401/403 立刻提示用户                                           |
| R-024 | MEDIUM   | B3   | MCP stop() 清理 pending requests                                               |
| R-025 | HIGH     | B3   | psRequest 检查 HTTP 状态码                                                     |
| R-026 | MEDIUM   | B3   | CLI auth 用 URL 协议选择 http vs https                                         |
| R-027 | HIGH     | B4   | MCP task_update schema 复用 shared                                             |
| R-028 | HIGH     | B4   | MCP task_create 复用 shared                                                    |
| R-029 | MEDIUM   | B4   | MCP project_create/update 补 repoUrl/defaultBranch                             |
| R-030 | HIGH     | B4   | shared planReviewSchema 补 focusNotes                                          |
| R-031 | HIGH     | B4   | shared driftAlertSchema 补 affectedAreas/planDiffId                            |
| R-032 | MEDIUM   | B4   | propose plan 建立 shared zod schema                                            |
| R-033 | MEDIUM   | B4   | createActivity 强制 zod 校验 type                                              |
| R-034 | HIGH     | B4   | 增加 schema-drift CI 守门测试                                                  |
| R-035 | HIGH     | B4   | env.ts 验证所有运行时使用的 env 变量                                           |
| R-036 | MEDIUM   | B4   | 删除 MCP plan_create 客户端 draft guard 或在 API 实施                          |
| R-037 | MEDIUM   | B4   | MCP tool 统一错误格式                                                          |
| R-038 | MEDIUM   | B4   | review_reject schema 强制 comment 非空                                         |
| R-039 | LOW      | B4   | execution tools 错误统一为 JSON envelope                                       |
| R-040 | LOW      | B4   | api-client 启动时校验 token 配置                                               |
| R-041 | HIGH     | B5   | 所有 /plans/:planId/... 路由验证 plan ∈ project                                |
| R-042 | HIGH     | B5   | task/drift 状态 query 参数 zod 校验                                            |
| R-043 | HIGH     | B5   | webhook URL 校验防 SSRF                                                        |
| R-044 | MEDIUM   | B5   | notify 路由限流 + owner-only                                                   |
| R-045 | HIGH     | B5   | human task PATCH done 需要 execution 或 owner                                  |
| R-046 | MEDIUM   | B5   | complete-human 加 open drift gate                                              |
| R-047 | MEDIUM   | B5   | DELETE task 拒绝有 running run 的请求                                          |
| R-048 | CRITICAL | B6   | plans 表加 partial unique 每项目一个 active                                    |
| R-049 | HIGH     | B6   | task_claim 用 conditional updateMany 原子化                                    |
| R-050 | MEDIUM   | B6   | plan 版本号生成放进事务                                                        |
| R-051 | HIGH     | B6   | drift_alert 触发用 upsert 避免重复                                             |
| R-052 | HIGH     | B6   | reactivate 把 drift 扫描放回事务                                               |
| R-053 | MEDIUM   | B6   | suggestion accept 单事务 apply+update                                          |
| R-054 | HIGH     | B6   | execution_start 拒绝 cancelled/blocked/done 任务                               |
| R-055 | HIGH     | B6   | activate 路由要求非 0 reviewer 或 owner                                        |
| R-056 | MEDIUM   | B6   | heartbeat scanner 改为 DB advisory lock                                        |
| R-057 | MEDIUM   | B6   | stale 状态同步释放 task 与 exec-scoped key                                     |
| R-058 | LOW      | B6   | drift_engine 使用 tx 读取                                                      |
| R-059 | HIGH     | B7   | CLI banner phase 改用 API 返回的 project.phase                                 |
| R-060 | HIGH     | B7   | /exec 允许 human assignee                                                      |
| R-061 | HIGH     | B7   | worktree 失败时调用 failRun                                                    |
| R-062 | HIGH     | B7   | 统一 bin/plansync --exec 与 CLI /exec                                          |
| R-063 | HIGH     | B7   | AI loop 保留 tool_use/tool_result 历史                                         |
| R-064 | HIGH     | B7   | !shell 命令在 Ink 之前 pause/unmount                                           |
| R-065 | MEDIUM   | B7   | /clear /verbose 无 unmount 命令统一加入 unmount                                |
| R-066 | MEDIUM   | B7   | Ink 监听 SIGWINCH 重渲染                                                       |
| R-067 | MEDIUM   | B7   | Ink 支持 bracketed paste 多行提交                                              |
| R-068 | MEDIUM   | B7   | Ink 非 TTY fallback                                                            |
| R-069 | MEDIUM   | B7   | AI loop maxTurns 用户可见警告                                                  |
| R-070 | MEDIUM   | B7   | AI loop 添加 token 预算估算                                                    |
| R-071 | LOW      | B7   | /worker Ctrl+C 中断子进程                                                      |
| R-072 | LOW      | B7   | suggestion ↓ 从未选状态进入                                                    |
| R-073 | LOW      | B7   | /code 退出不清屏                                                               |
| R-074 | MEDIUM   | B7   | /project <id> 验证项目存在                                                     |
| R-075 | HIGH     | B8   | tasks 表加复合索引                                                             |
| R-076 | HIGH     | B8   | drift_alerts 加复合索引                                                        |
| R-077 | HIGH     | B8   | api_keys.keyPrefix 加索引                                                      |
| R-078 | MEDIUM   | B8   | webhook_deliveries 加分页索引                                                  |
| R-079 | HIGH     | B8   | 把 String 状态字段改为 Prisma enum                                             |
| R-080 | MEDIUM   | B8   | ApiKey.execRunId FK                                                            |
| R-081 | MEDIUM   | B8   | DriftAlert.planDiffId FK                                                       |
| R-082 | MEDIUM   | B8   | PlanDiff.fromPlanId/toPlanId FK                                                |
| R-083 | MEDIUM   | B8   | Task.boundPlanVersion 加复合 FK                                                |
| R-084 | MEDIUM   | B8   | schema.prisma 标注 partial unique index                                        |
| R-085 | LOW      | B8   | 统一 camelCase 列名                                                            |
| R-086 | LOW      | B8   | PlanComment.parent onDelete 显式                                               |
| R-087 | LOW      | B8   | DriftAlert.severity 加 default                                                 |
| R-088 | CRITICAL | B9   | EventBus 替换为 Postgres LISTEN/NOTIFY                                         |
| R-089 | MEDIUM   | B9   | SSE 改用 cookie 鉴权                                                           |
| R-090 | MEDIUM   | B9   | SSE 加 backpressure / slow client 处理                                         |
| R-091 | LOW      | B9   | MAX_SSE_CLIENTS 按 project 计                                                  |
| R-092 | HIGH     | B10  | 构建 GitHub Action dist/index.js                                               |
| R-093 | HIGH     | B10  | action 输入 api-key 加 core.setSecret                                          |
| R-094 | HIGH     | B10  | action drift gate 按 PR 任务过滤                                               |
| R-095 | HIGH     | B10  | PG_BIN / port_in_use 平台化                                                    |
| R-096 | HIGH     | B10  | 删除 README 不存在的 demo 脚本引用                                             |
| R-097 | HIGH     | B10  | CLAUDE.md 删除 task_update 虚假承诺                                            |
| R-098 | MEDIUM   | B10  | CLAUDE.md Three contexts 文案修正                                              |
| R-099 | MEDIUM   | B10  | .env.example 补缺失变量                                                        |
| R-100 | MEDIUM   | B10  | bin/plansync 错误消息 --format 修正                                            |
| R-101 | MEDIUM   | B10  | start-mcp 自动构建放到 CLI 启动路径                                            |
| R-102 | MEDIUM   | B10  | 默认 Genie 路径平台化                                                          |
| R-103 | LOW      | B10  | dev.sh 不再每次清 .next                                                        |
| R-104 | HIGH     | B11  | plan PATCH 写 activity                                                         |
| R-105 | HIGH     | B11  | task PATCH 写 activity                                                         |
| R-106 | HIGH     | B11  | task DELETE 写 activity                                                        |
| R-107 | HIGH     | B11  | drift cancel action 写 activity                                                |
| R-108 | HIGH     | B11  | heartbeat-scanner stale/failed 写 activity                                     |
| R-109 | HIGH     | B11  | comment edit/delete 写 activity                                                |
| R-110 | HIGH     | B11  | project PATCH 写 activity                                                      |
| R-111 | MEDIUM   | B11  | logger 中间件加 correlation id                                                 |
| R-112 | LOW      | B11  | logger 用 env.LOG_LEVEL                                                        |
| R-113 | LOW      | B11  | sendMail 异步队列化                                                            |
| R-114 | HIGH     | B12  | complete-human 集成测试                                                        |
| R-115 | HIGH     | B12  | tasks/conflicts 集成测试                                                       |
| R-116 | HIGH     | B12  | chat/notify/ai-draft/ai-field 集成测试                                         |
| R-117 | HIGH     | B12  | auth login/password/verify/logout 集成测试                                     |
| R-118 | HIGH     | B12  | exec-sessions issue/revoke token 直测                                          |
| R-119 | HIGH     | B12  | MCP execution\_\* 工具单测                                                     |
| R-120 | HIGH     | B12  | MCP drift_resolve / check_task_conflicts 单测                                  |
| R-121 | HIGH     | B12  | MCP plan*activate/reactivate/append/review*\* 单测                             |
| R-122 | MEDIUM   | B12  | webhook delivery 单测                                                          |
| R-123 | MEDIUM   | B12  | auth.ts 密码缓存边界单测                                                       |
| R-124 | MEDIUM   | B12  | AI mock 让默认 CI 跑 ai.test                                                   |
| R-125 | MEDIUM   | B12  | activity.ts 单测                                                               |
| R-126 | MEDIUM   | B12  | B1 端到端集成测试                                                              |
| R-127 | MEDIUM   | B12  | 并发 claim 压力测试                                                            |
| R-128 | MEDIUM   | B12  | 并发 plan activate 压力测试                                                    |
| R-129 | MEDIUM   | B12  | SSE 多实例端到端                                                               |
| R-130 | LOW      | B12  | 文档示例代码可执行测试                                                         |
| R-131 | HIGH     | B10  | 升级 Next.js 14 → 16（修复 2 个残留 high CVE）                                 |
| R-132 | HIGH     | B4   | 升级 @modelcontextprotocol/sdk 1.3 → 1.29+ 并恢复 mcp-server typecheck         |
| R-133 | MEDIUM   | B4   | 逐步把 `any` 替换为 `unknown`/具体类型，重新启用 ESLint `no-explicit-any` 警告 |
| R-134 | MEDIUM   | B12  | plans.test.ts 抽出 `resetDraftPlans` helper（避免 R-036 guard 漏 cleanup）     |
| R-135 | CRITICAL | B5   | task-pack 加 task↔project 归属校验                                            |
| R-136 | CRITICAL | B2   | PLANSYNC_SECRET 增加 audit / 范围限制 / 强制 TTL                               |
| R-137 | HIGH     | B2   | exec-scoped key 在缺 execRunId 时也强制 keyProjectId 校验                      |
| R-138 | HIGH     | B10  | heartbeat-scanner 从 instrumentation 解耦                                      |
| R-139 | HIGH     | B9   | webhook 重试改为持久化队列                                                     |
| R-140 | HIGH     | B6   | 新增 task.executionGate 字段区分 system block                                  |
| R-141 | MEDIUM   | B8   | ApiKey scrypt 热路径优化（内存缓存）                                           |
| R-142 | HIGH     | B1   | MCP execution_aborted 改 protocol error                                        |
| R-143 | HIGH     | B4   | completion-verify 可观测：score/breakdown/model 写库                           |
| R-144 | MEDIUM   | B11  | 新增 ai_calls 表，所有 LLM 调用持久化                                          |
| R-145 | HIGH     | B4   | PlanDiff.changes 强制 shared zod schema                                        |
| R-146 | HIGH     | B10  | CLAUDE.md/AGENTS.md/ai-loop prompt 合并 single source                          |
| R-150 | CRITICAL | B13  | 设计 Deliverable/Constraint/Standard 分表 schema                               |
| R-151 | CRITICAL | B13  | 历史 plan 数据双写迁移                                                         |
| R-152 | HIGH     | B13  | plan_update/propose/activate 改写新表                                          |
| R-153 | HIGH     | B13  | Task→Deliverable FK 中间表                                                     |
| R-154 | HIGH     | B13  | drift-engine 切换为图 diff                                                     |
| R-155 | HIGH     | B13  | 新增 plansync_deliverable\_\* MCP 工具                                         |
| R-156 | MEDIUM   | B13  | Web UI Deliverable 状态时间线                                                  |
| R-157 | HIGH     | B13  | GitHub Action drift-gate 升级为语义 gate                                       |
| R-160 | CRITICAL | B14  | 新增 domain_events 表 + 事务内 Outbox writer                                   |
| R-161 | CRITICAL | B14  | 全部 eventBus.publish 改写 outbox.emit                                         |
| R-162 | CRITICAL | B14  | 新增 plansync-worker 消费 outbox                                               |
| R-163 | HIGH     | B14  | SSE relay 支持 lastEventId 回放                                                |
| R-164 | HIGH     | B14  | Webhook dispatcher 改吃 outbox                                                 |
| R-165 | HIGH     | B14  | Email 改为 outbox 消费者 + 去重                                                |
| R-166 | HIGH     | B14  | 删除 instrumentation 启动 scanner，scanner 改吃 outbox                         |
| R-170 | CRITICAL | B15  | 设计 ExecContextToken + nextRequired 状态机                                    |
| R-171 | HIGH     | B15  | MCP server 实施 stateToken 校验                                                |
| R-172 | HIGH     | B15  | CLAUDE.md 重写为 thin pointer                                                  |
| R-173 | HIGH     | B15  | AGENTS.md 与 CLAUDE.md 合并到 generated source                                 |
| R-174 | MEDIUM   | B15  | CLI ai-loop system prompt 从 generated 注入                                    |
| R-175 | HIGH     | B15  | MCP tool surface 收敛到 ≤ 12 个                                                |
| R-176 | MEDIUM   | B15  | 文档↔工具一致性 contract test                                                 |
| R-180 | HIGH     | B16  | completion-verify 改为 advisory：永不 422                                      |
| R-181 | HIGH     | B16  | 声明式 verification_rules 表 + 评估器                                          |
| R-182 | HIGH     | B16  | ai_calls 表 + provider observability                                           |
| R-183 | MEDIUM   | B16  | AI provider fallback + 限流 + 缓存                                             |
| R-184 | MEDIUM   | B16  | UI/CLI 暴露 AI 建议 vs 规则 gate 区分                                          |
| R-190 | HIGH     | B17  | 接收 GitHub webhook                                                            |
| R-191 | HIGH     | B17  | commit↔deliverable 关联表 + 自动推导                                          |
| R-192 | HIGH     | B17  | task 状态从 git + verification rules 自动推导                                  |
| R-193 | MEDIUM   | B17  | PR template 自动注入 deliverable refs                                          |
| R-200 | HIGH     | B18  | 抽出 @plansync/client-core view-model 包                                       |
| R-201 | HIGH     | B18  | Web/CLI 改用 client-core                                                       |
| R-202 | HIGH     | B18  | 拆 plansync-web 独立部署                                                       |
| R-203 | MEDIUM   | B18  | 部署拓扑文档 + docker-compose / helm chart                                     |

**统计**（含 2026-05-22 追加；与正文 `^#### R-XXX [SEVERITY]` 标题精确一致）：

- CRITICAL: 8 + 8 = **16**
- HIGH: 62 + 30 = **92**
- MEDIUM: 50 + 9 = **59**
- LOW: 14 + 0 = **14**
- **合计 181 条**（其中 2026-05-22 追加 47 条）

> 新增条目按"补丁先行 / 架构串行"原则消费，详见批次总览表下方的依赖关系。

---

## 附录 B — 已修复/已过期的旧报告条目

来自 `syntax-inconsistencies-report.md` 的部分发现已经在后续提交中解决，本路线图未重复：

- ✅ `plansync_plan_update` 已实现（见 `plan.ts`）
- ✅ `plansync_project_update` 已实现（见 `project.ts`）
- ✅ `plansync_task_update` 已实现（但 exec mode 行为见 R-097）
- ✅ `plansync_delegation_clear` 已实现（见 `status.ts`）
- ✅ `plansync_review_approve / review_reject` 已实现（见 `plan.ts`，但 reject schema 见 R-038）
- ✅ `plansync_plan_diff` `compareWith` 自动选择 v-1 已修复
- ⚠ Finding 10（`plansync_who` 不返回 runId）→ 演化为 R-? 已纳入 B2 之外，详见 R-?；目前未单独列项，可作为新条目 R-131 在后续追加

---

## 文档维护规则

1. **本文档是单一真理源**：所有"PlanSync 还有什么要修"的问题都加到这里，不另开 issue tracker（如果用 GitHub Issues，请双向链接）。
2. **条目 ID 永不复用**。
3. **状态字段必须及时更新**：PR 合并 → done；废弃 → cancelled；拆分 → blocked 并新增子条目。
4. **新发现的问题**追加到对应批次末尾，ID 顺延（R-131, R-132 …）。
5. **季度回顾**：每季度跑一次 burn-down，估算遗留风险。

---

**报告生成时间**：2026-05-20（首发）/ 2026-05-22（追加 R-135..R-203 共 47 条新条目）
**生成方式**：4 个并行 explore subagent 全量扫描 + 关键路径人工核对；2026-05-22 追加由架构审计 agent 补齐"补丁解决不了"的条目
**预计总工作量**：

- 旧 134 条：~40-60 PR
- 新 47 条：~30-50 PR（B13/B14/B15 各按 1 个里程碑 PR 更合理）
- 总和：~70-110 PR；按 cron 每天 1 PR、人工 review，整体 backlog 清完约 3-5 个月。

**消费策略建议**：

1. **R-135..R-146 补丁组**：可立刻并行派 5 个 cursor agent，48h 内全部 PR 完成
2. **B14 outbox 地基**：1 个里程碑 PR（R-160 → R-166 一次性合并），独立 reviewer 团评 1 周
3. **B13 plan-as-code**：先 R-150 schema PR、再 R-151 backfill PR、之后 R-152..R-157 可并行
4. **B15 协议化**：与 B13 解耦，可并行启动；R-170 设计 PR 必须先于 R-171
5. **B16/B17/B18**：作为下一季度的护城河工程，启动前确认 B13/B14 已稳定
