# PlanSync 修复路线图（Remediation Plan）

> **文档用途**：这是一份**可被 cron job 或自动化代理逐条消费**的修复清单，覆盖 2026-05-20 全量代码审计中发现的所有问题（共 130+ 条）。
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
- **status**: pending | in_progress | done | blocked
- **batch**: B1..B12
- **depends_on**: R-YYY, R-ZZZ
- **effort**: small (<2h) | medium (2-8h) | large (>1d)
- **files**: 受影响的文件路径列表
- **symptom**: 用户看到的现象
- **root_cause**: 一句话说清根因
- **fix_steps**: 1) ... 2) ... 3) ...
- **verification**: 怎么验证修好了（含具体测试用例）
- **rollback**: 如果出问题如何回滚
```

### 给 cron job 的解析约定

- **ID 稳定**：`R-XXX` 永不复用，已完成的任务标 `status: done` 而不删除
- **依赖图**：cron 调度时优先取 `depends_on` 全部为 `done` 的 `pending` 条目
- **同一批次内可并行**：除非显式 `depends_on`
- **跨批次串行**：建议批次按字母顺序推进（B1 全完成再开 B2）

### 推荐的 cron job 工作流

```bash
# 每天凌晨触发：
1. git pull origin master
2. grep "status: pending" docs/REMEDIATION_PLAN.md → 取所有候选
3. 过滤 depends_on 已 done 的
4. 按严重度排序，取最高 N 个
5. 为每个任务调用 cursor agent / Cloud Agent 执行
6. agent 完成后：开 PR + 把文档里对应条目改 status: done + commit
```

### 状态字段维护规则

- **agent 接手时**：把 `status: pending` 改为 `status: in_progress` 并 commit
- **PR 合并后**：把 `status: in_progress` 改为 `status: done`，加 `closed_in: PR#123`
- **发现需要拆分**：保持原条目 `status: blocked`，新增子条目 `R-XXX.a`, `R-XXX.b`

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

---

## 修复条目清单

---

### B1 — Drift 进程中止与 AI 自处理消除

> **目标**：让 drift 触发时正在跑的 execution 真正停下来，rebind 后旧进程不能 complete，并且 AI 不再自作主张解决 drift。

---

#### R-001 [CRITICAL] 禁用 AI 后台自动解决 drift

- **status**: in_progress
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

- **status**: pending
- **batch**: B1
- **depends_on**: R-008（先加 superseded 状态）
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

- **status**: pending
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

- **status**: pending
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

- **status**: pending
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

- **status**: pending
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: pending
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: pending
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: pending
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

- **status**: in_progress
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

- **status**: pending
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: pending
- **batch**: B4
- **depends_on**: R-027..R-033
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: pending
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

- **status**: pending
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: pending
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: pending
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

- **status**: pending
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

- **status**: pending
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

- **status**: in_progress
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

- **status**: pending
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

- **status**: pending
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: pending
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
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

- **status**: in_progress
- **batch**: B8
- **depends_on**: —
- **effort**: small
- **files**: schema + 迁移
- **fix_steps**: `@@index([projectId, status])`, `@@index([taskId, status])`
- **rollback**: drop

---

#### R-077 [HIGH] api_keys.keyPrefix 加索引

- **status**: in_progress
- **batch**: B8
- **depends_on**: —
- **effort**: small
- **files**: schema + 迁移
- **fix_steps**: `@@index([keyPrefix])`
- **rollback**: drop

---

#### R-078 [MEDIUM] webhook_deliveries 加分页索引

- **status**: in_progress
- **batch**: B8
- **depends_on**: —
- **effort**: small
- **files**: schema + 迁移
- **fix_steps**: `@@index([webhookId, createdAt(sort: Desc)])`
- **rollback**: drop

---

#### R-079 [HIGH] 把 String 状态字段改为 Prisma enum

- **status**: pending
- **batch**: B8
- **depends_on**: B4 完成
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

- **status**: pending
- **batch**: B8
- **depends_on**: —
- **effort**: small
- **files**: schema + 迁移
- **fix_steps**: 加 relation + `onDelete: SetNull`
- **rollback**: drop FK

---

#### R-081 [MEDIUM] DriftAlert.planDiffId FK 到 plan_diffs

- **status**: pending
- **batch**: B8
- **depends_on**: —
- **effort**: small
- **fix_steps**: 加 relation + `onDelete: SetNull`

---

#### R-082 [MEDIUM] PlanDiff.fromPlanId/toPlanId FK 到 plans

- **status**: pending
- **batch**: B8
- **depends_on**: —
- **effort**: small
- **fix_steps**: 加 relation

---

#### R-083 [MEDIUM] Task.boundPlanVersion 加复合 FK

- **status**: pending
- **batch**: B8
- **depends_on**: —
- **effort**: medium
- **files**: schema + 迁移
- **fix_steps**: 加 `@relation(fields: [projectId, boundPlanVersion], references: [projectId, version])`
- **rollback**: drop

---

#### R-084 [MEDIUM] schema.prisma 标注 partial unique index

- **status**: pending
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

- **status**: pending
- **batch**: B8
- **depends_on**: —
- **effort**: medium
- **files**: schema + 迁移
- **fix_steps**: ApiKey 等迟到的表加 `@map`
- **rollback**: revert

---

#### R-086 [LOW] PlanComment.parent 关系 onDelete 显式

- **status**: pending
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

- **status**: pending
- **batch**: B9
- **depends_on**: —
- **effort**: large
- **files**: `packages/api/src/lib/event-bus.ts` (行 134-136), 新文件 `event-bus-pg.ts`
- **symptom**: 生产多实例 SSE 客户端收不到跨实例事件
- **root_cause**: 内存 bus 实例隔离
- **fix_steps**:
  1. 新增 `EventBusPG` 实现：使用 `pg` 包的 LISTEN/NOTIFY；通道 `plansync_project_<id>` + `plansync_user_<name>`
  2. 现有 EventBus 接口保留为本地代理（前端 broadcast 仍要分发到本进程订阅）
  3. env 加 `PLANSYNC_EVENT_BUS=memory|postgres`，默认 postgres（NODE_ENV=production）
- **verification**: 启 2 个 API 进程，一个 publish，另一个 SSE 客户端能收到
- **rollback**: env 切回 memory

---

#### R-089 [MEDIUM] SSE 改用 cookie 鉴权，不再支持 `?token=`

- **status**: pending
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

- **status**: pending
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

- **status**: pending
- **batch**: B9
- **depends_on**: R-088
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/events/route.ts` (行 20-22)
- **fix_steps**: 计数从全局改为 `(projectId, count)`

---

### B10 — 文档与脚本对齐

---

#### R-092 [HIGH] 构建 GitHub Action `dist/index.js`

- **status**: pending
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

- **status**: pending
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

- **status**: pending
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

- **status**: pending
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

- **status**: pending
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

- **status**: pending
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

- **status**: pending
- **batch**: B10
- **depends_on**: —
- **effort**: small
- **files**: `CLAUDE.md` (行 308)
- **fix_steps**: 改为"Three contexts produce comments — two structured templates and one free-form. Pick the matching format."
- **verification**: 阅读
- **rollback**: 单文件

---

#### R-099 [MEDIUM] `.env.example` 补 PLANSYNC*SECRET / AUTH_DISABLED / AI keys / EMAIL*\*

- **status**: pending
- **batch**: B10
- **depends_on**: R-035
- **effort**: small
- **files**: `.env.example`
- **fix_steps**: 加占位
- **verification**: 跟 env.ts 对齐
- **rollback**: 单文件

---

#### R-100 [MEDIUM] bin/plansync 错误消息修正 `--format=cjs` → `--format=esm`

- **status**: pending
- **batch**: B10
- **depends_on**: —
- **effort**: small
- **files**: `bin/plansync` (行 416-417)
- **fix_steps**: 改文案
- **verification**: 阅读

---

#### R-101 [MEDIUM] start-mcp 自动构建逻辑也放到 CLI 启动路径

- **status**: pending
- **batch**: B10
- **depends_on**: —
- **effort**: small
- **files**: `packages/cli/src/index.ts` (行 99-110), `bin/start-mcp` (行 36-42)
- **fix_steps**: 抽出 ensure_mcp_build 函数
- **verification**: 手测

---

#### R-102 [MEDIUM] 默认 Genie 路径可配置 / 平台化

- **status**: pending
- **batch**: B10
- **depends_on**: —
- **effort**: small
- **files**: `packages/cli/src/config.ts` (行 34-37)
- **fix_steps**: 默认 `claude` PATH lookup，明确文档化 `PLANSYNC_CODE_BIN` env
- **rollback**: 单文件

---

#### R-103 [LOW] dev.sh 不再每次清 .next

- **status**: pending
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

- **status**: pending
- **batch**: B11
- **depends_on**: R-033
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/plans/[planId]/route.ts` (行 57-98)
- **fix_steps**: 加 `createActivity({ type: 'plan_updated' ... })`；shared/activityTypeSchema 加该 type
- **verification**: 单测

---

#### R-105 [HIGH] task PATCH 写 activity

- **status**: pending
- **batch**: B11
- **depends_on**: R-033
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/tasks/[taskId]/route.ts`
- **fix_steps**: 写 `task_status_changed` / `task_reassigned`

---

#### R-106 [HIGH] task DELETE 写 activity

- **status**: pending
- **batch**: B11
- **depends_on**: R-033
- **effort**: small
- **files**: 同上

---

#### R-107 [HIGH] drift cancel action 写 activity

- **status**: pending
- **batch**: B11
- **depends_on**: R-033
- **effort**: small
- **files**: `packages/api/src/app/api/projects/[projectId]/drifts/[driftId]/route.ts` (行 71-79)
- **fix_steps**: cancel 分支额外写 `task_cancelled`

---

#### R-108 [HIGH] heartbeat-scanner stale/failed 写 activity

- **status**: pending
- **batch**: B11
- **depends_on**: R-033
- **effort**: small
- **files**: `packages/api/src/lib/heartbeat-scanner.ts` (行 46-68)

---

#### R-109 [HIGH] comment edit/delete 写 activity

- **status**: pending
- **batch**: B11
- **depends_on**: R-033
- **effort**: small

---

#### R-110 [HIGH] project PATCH 写 activity

- **status**: pending
- **batch**: B11
- **depends_on**: R-033
- **effort**: small

---

#### R-111 [MEDIUM] logger 中间件加 correlation id

- **status**: pending
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

- **status**: pending
- **batch**: B11
- **depends_on**: —
- **effort**: medium
- **files**: `packages/api/src/lib/email.ts`
- **fix_steps**: setImmediate + 内存队列；失败重试

---

### B12 — 测试补齐

---

#### R-114 [HIGH] complete-human 集成测试

- **status**: pending
- **batch**: B12
- **depends_on**: R-046
- **effort**: small

---

#### R-115 [HIGH] tasks/conflicts 集成测试

- **status**: pending
- **batch**: B12
- **depends_on**: —
- **effort**: small

---

#### R-116 [HIGH] chat / notify / ai-draft / ai-field 集成测试

- **status**: pending
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

- **status**: pending
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

- **status**: pending
- **batch**: B12
- **depends_on**: B1 完成
- **effort**: small

---

#### R-121 [HIGH] MCP plan*activate/reactivate/append/review*\* 单测

- **status**: pending
- **batch**: B12
- **depends_on**: —
- **effort**: medium

---

#### R-122 [MEDIUM] webhook delivery 单测（HMAC、retry、idempotency）

- **status**: pending
- **batch**: B12
- **depends_on**: —
- **effort**: medium

---

#### R-123 [MEDIUM] auth.ts 密码缓存边界单测

- **status**: pending
- **batch**: B12
- **depends_on**: —
- **effort**: small

---

#### R-124 [MEDIUM] AI 完成验证 - 提供 AI mock 让默认 CI 也跑

- **status**: pending
- **batch**: B12
- **depends_on**: —
- **effort**: medium
- **files**: `packages/api/tests/integration/ai.test.ts`
- **fix_steps**: 注入 aiClient mock，opt-in 真 LLM；CI 默认跑 mock 路径
- **verification**: CI 报告 ai.test 不再被 skip

---

#### R-125 [MEDIUM] activity.ts 单测覆盖

- **status**: pending
- **batch**: B12
- **depends_on**: R-033
- **effort**: small

---

#### R-126 [MEDIUM] B1 集成端到端测试

- **status**: pending
- **batch**: B12
- **depends_on**: B1 完成
- **effort**: medium
- **fix_steps**:
  - 场景：plan v2 激活 → run.status → superseded → SSE 触发 → ai-loop abort → user 调 rebind → task todo → 新 run 可启动
- **verification**: e2e 通过

---

#### R-127 [MEDIUM] 并发 claim 压力测试

- **status**: pending
- **batch**: B12
- **depends_on**: R-049
- **effort**: small

---

#### R-128 [MEDIUM] 并发 plan activate 压力测试

- **status**: pending
- **batch**: B12
- **depends_on**: R-048
- **effort**: small

---

#### R-129 [MEDIUM] SSE 多实例端到端

- **status**: pending
- **batch**: B12
- **depends_on**: R-088
- **effort**: medium

---

#### R-130 [LOW] 文档示例代码可执行测试

- **status**: pending
- **batch**: B12
- **depends_on**: —
- **effort**: medium
- **fix_steps**: 抽取 README 中的命令示例，写 smoke 测试

---

#### R-131 [HIGH] 升级 Next.js 14 → 16（修复残留 high CVE）

- **status**: pending
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

- **status**: pending
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

- **status**: pending
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

## Cron Job 调度建议

### 推荐节奏

| 频率             | 任务                                                                         |
| ---------------- | ---------------------------------------------------------------------------- |
| **每天 02:00**   | 拉一次 master，扫描 `pending` 任务，按严重度+依赖筛出 3-5 个，开 Cloud Agent |
| **每天 18:00**   | 检查 PR 状态，自动 merge 通过 CI 的 draft → ready                            |
| **每周一 09:00** | 输出本周 burn-down 报告（已 done / 仍 pending）                              |

### 简单实现思路（伪代码）

```bash
#!/usr/bin/env bash
# /opt/plansync-cron/dispatch.sh
set -euo pipefail
cd /opt/plansync-repo
git fetch origin && git checkout master && git pull

# 抽出 pending 任务的 ID 列表
PENDING=$(grep -E "^- \*\*status\*\*: pending" docs/REMEDIATION_PLAN.md \
  | head -200 | awk -F'R-' '{print "R-"$2}' | awk '{print $1}')

for ID in $PENDING; do
  # 检查依赖是否已 done
  DEPS=$(sed -n "/### $ID /,/^### /p" docs/REMEDIATION_PLAN.md \
    | grep "depends_on" | sed 's/.*depends_on\*\*: //')
  if [ "$DEPS" != "—" ]; then
    UNMET=0
    for D in $(echo "$DEPS" | tr ',' ' '); do
      D=$(echo "$D" | xargs)
      STATUS=$(sed -n "/### $D /,/^### /p" docs/REMEDIATION_PLAN.md \
        | grep "^\- \*\*status\*\*" | head -1 | awk '{print $NF}')
      [ "$STATUS" != "done" ] && UNMET=1
    done
    [ $UNMET -eq 1 ] && continue
  fi

  # 调 Cloud Agent
  cursor-agent dispatch \
    --prompt "Implement task $ID from docs/REMEDIATION_PLAN.md. Read the file, find the section for $ID, follow fix_steps exactly, add verification tests, open a PR. After PR is opened, update the entry to status: in_progress + closed_in: <PR URL>." \
    --base master \
    --branch "cursor/$ID-auto"

  # 一次只派一个，避免并发冲突
  break
done
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

**统计**：

- CRITICAL: 7
- HIGH: 62
- MEDIUM: 51
- LOW: 14
- **合计 134 条**

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

**报告生成时间**：2026-05-20
**生成方式**：4 个并行 explore subagent 全量扫描 + 关键路径人工核对
**预计总工作量**：~40-60 个 PR；按 cron 每天 1 PR、人工 review，整个 backlog 清完约 2-3 个月。
