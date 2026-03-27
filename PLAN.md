# PlanSync — AI 团队协作的方案对齐平台

## 一句话

> 当 Lead 把方案从 JWT 改成 OAuth，PlanSync **1 秒内**通知正在写代码的 Agent 暂停，告诉 Lead 谁受影响、影响多大，并在 Web Dashboard 上实时展示全局——它是 AI 多 agent 时代的**方案协调层**。

---

## Executive Summary

**PlanSync 解决什么问题？** 2-5 人团队 + 多个 AI agent 同时开发时，方案频繁变更导致 agent 按旧方案写废代码、团队成员信息不同步、drift 直到 PR review 才发现。现有工具（Jira/Git/Slack/AI 编码工具）均不覆盖"方案版本协调"这一层。

**核心差异化：** 不只检测 drift，还**主动通知正在运行的 Agent**——这是现有任何工具都没有做的 AI agent 间运行时协调。

**产品形态：** MCP Server（集成到 Genie/Cursor/Claude Code 等 AI 编码工具）+ Web Dashboard + 开放 API + GitHub/Slack 集成。

**技术栈：** Node.js MCP Server + Next.js API + PostgreSQL（本地）+ SSE 实时推送。

**四个阶段：**

| Phase | 核心交付 | 时间 |
|-------|---------|------|
| **1** | MCP + API + Drift Engine — CLI 完整闭环 | 2-3 周 |
| **2** | Agent 实时协调 + Web Dashboard — 核心差异化 | 2-3 周 |
| **3** | 开放 API + GitHub/Slack/Webhook — 生态壁垒 | 1-2 周 |
| **4** | LLM 语义 diff + 影响评估 — 体验加分项 | 1-2 周 |

**关键风险：** MCP notification 在各宿主上的支持程度（已设计降级方案）；SSE 长连接在 Serverless 平台的部署限制（已规划替代方案）。

**壁垒排序：** Agent 运行时协调（无竞品）> 生态集成（切换成本）> 工作流设计 > 智能层（LLM 调用，2 小时可复刻，不是壁垒）。

---

## 核心问题

2-5 人团队 + 多个 AI agent 同时开发，**方案频繁变更**时：

- 谁还在按旧方案做？ → **直到 PR review 才发现**
- Agent 在按旧方案写代码，怎么让它停？ → **没有办法，只能等它写完再扔掉**
- 当前生效的是哪个方案？ → **方案一天改三次，找不到**
- 方案改了影响哪些任务？ → **靠人肉判断**
- 新人加入该做什么？ → **没有统一入口**

**现有工具都不解决：** Jira 管任务不管方案版本；Git 管代码不管计划变更；Slack 管沟通不管执行追踪；AI 编码工具管写代码不管多 agent 协调。

---

## 产品定位

**五层产品价值，按优先级排序：**

| 优先级 | 层 | 能力 | 壁垒 |
|--------|-----|------|------|
| **L1** | **检测** | Drift Engine — 方案一改，秒级告警 | 中（工作流设计 + 数据模型） |
| **L2** | **协调** | Agent 实时通知 + 打断 — 方案改了，正在跑的 Agent 立刻知道 | **高（没有人在做 agent 间运行时协调）** |
| **L3** | **集成** | 开放 API + GitHub/Slack/Webhook — 融入现有工具链 | **高（生态 + 切换成本）** |
| **L4** | **可视化** | Web Dashboard — 实时状态、drift 操作、Plan 时间线 | 中（让产品可感知、可演示） |
| **L5** | **智能** | LLM 语义 diff + 影响评估 + 冲突预测 | 低（调 API，谁都能做）→ 加分项 |

> **关键认知修正：** 智能层（LLM 调用）不是护城河。Semantic diff 本质是一个 Claude API 调用 + 一个 prompt，2 小时就能复刻。真正的差异化是 **L2 Agent 协调**（没人做）和 **L3 生态集成**（需要时间积累）。

```
┌────────────────────────────────────────────────────────────────┐
│                      PlanSync Platform                         │
│                                                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │ MCP 入口  │  │ Web 入口  │  │  Slack   │  │ GitHub/API   │   │
│  │ CLI 用户  │  │ Lead/PM  │  │  通知     │  │ CI/CD 集成   │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘   │
│       │             │             │               │            │
│       └─────────────┴──────┬──────┴───────────────┘            │
│                            ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                PlanSync Core Engine                       │  │
│  │  ├ Plan 版本管理 + 审批流                      (L1)      │  │
│  │  ├ Task 绑定 & 执行追踪                       (L1)      │  │
│  │  ├ ★ Drift Detection                         (L1)      │  │
│  │  ├ ★ Agent Real-time Coordination            (L2)      │  │
│  │  ├ ★ Event Stream (SSE) + Webhooks           (L3)      │  │
│  │  ├ Semantic Diff + Impact Analysis            (L5)      │  │
│  │  └ Activity Stream                                      │  │
│  └──────────────────────────────────────────────────────────┘  │
│                            │                                   │
│             PostgreSQL + SSE/WebSocket (实时推送)               │
└────────────────────────────────────────────────────────────────┘
```

---

## 需要想清楚的问题

在进入开发之前，以下六个问题必须有明确答案：

### 问题 1：Agent 打断机制——核心差异化怎么实现？

**当前设计的致命漏洞：**
```
Agent-2 在按 v1 写代码
Lead 激活 v2
PlanSync 生成 drift alert
→ 然后呢？Agent-2 还在按 v1 写代码！它根本不知道方案改了！
```

**解决方案：MCP Server 维持与 API 的 SSE 长连接**
```
MCP Server 启动时：
  1. 连接 GET /api/projects/:id/events (SSE)
  2. 持续监听事件

当收到 plan_activated 事件：
  1. 检查当前是否有 running task
  2. 如果有，且 boundPlanVersion != 新 active version：
     a. 通过 MCP 的 notification 机制发送提醒给 AI
     b. AI 收到提醒后告知用户：
        "⚠ 方案刚刚从 v1 改成了 v2！你当前任务可能受影响。
         建议暂停当前工作，等 Lead 确认后再继续。"
     c. 或者（更激进）：自动暂停当前任务

这是别人没做的事：不只是"检测"drift，而是"主动通知正在运行的 Agent"。
```

**MCP Notification 支持：** MCP 协议支持 server → client 的 notification。MCP Server 可以主动发送 `notifications/message` 给宿主 AI，AI 会看到这个消息并做出反应。

**⚠ 关键风险与降级方案：**

MCP notification 是核心差异化的技术基础，但各宿主对 notification 的支持程度不同，需要分级应对：

```
优先级 1（理想方案）：MCP notifications/message
  - MCP Server 收到 SSE 事件 → 发送 notification → 宿主 AI 收到并反应
  - 需要验证：宿主是否在 AI 执行工具调用链时接收外部 notification？
  - 验证方法：Phase 2 Day 1 先做 PoC，在目标宿主上测试

优先级 2（降级方案 A）：Tool 调用时拦截
  - 每次 MCP 工具被调用时，先检查是否有未处理的 drift alert
  - 如果有，在工具返回结果中附加 drift 警告信息
  - 优点：100% 可行，不依赖 notification 能力
  - 缺点：不能"打断"AI，只能在下一次工具调用时通知

优先级 3（降级方案 B）：Polling 模式
  - MCP Server 注册一个 plansync_heartbeat 工具
  - CLAUDE.md 指令告诉 AI "每完成一个步骤后调用 heartbeat"
  - heartbeat 返回时携带 drift 信息
  - 缺点：依赖 AI 遵循指令，有延迟

实施策略：
  Phase 1 默认使用降级方案 A（零风险，保证基本功能）
  Phase 2 Day 1 做 MCP notification PoC
  PoC 成功 → 升级为理想方案
  PoC 失败 → 继续使用降级方案 A，用户体验稍差但功能完整
```

### 问题 2：Alert 疲劳

**风险：** Plan 一天改三次，每次生成一堆 drift alert，用户被告警淹没。

**解决方案：**
- 告警分级过滤：默认只推送 HIGH（有 running agent），MEDIUM/LOW 不主动打断
- 静默时段：可配置"正在密集迭代，暂时不告警"
- 自动合并：同一 task 的连续 drift 合并为一个 alert
- 智能降噪（Phase 4）：AI 判断"这个改动不影响你的任务"时自动标记 no_impact

### 问题 3：Plan 粒度

**问题：** Plan 太粗（"做一个认证系统"）→ drift 没意义。Plan 太细（每个函数签名）→ 太频繁。

**解决方案：定义 Plan 的标准结构**
```
Plan 应该包含：
  ✅ 技术选型（JWT vs OAuth）         — 改了就影响很大
  ✅ 架构约束（微服务 vs 单体）        — 改了就影响很大
  ✅ 关键接口（API contract）         — 改了影响实现
  ✅ 编码标准（命名规范、错误处理方式） — 改了需要统一
  ❌ 具体实现细节（函数名、变量名）    — 不该放在 Plan 里
  ❌ 时间安排（deadline）             — 用 Task 管理，不是 Plan

Goal: Plan 的粒度 = "改了会导致已有代码需要重写的决策"
```

### 问题 4：冷启动

**问题：** PlanSync 需要团队才有价值，一个人用没意义。

**策略：**
- **先做内部工具**：在自己团队/公司内用起来，积累反馈
- **找 2-3 人小团队做 Alpha 测试**：最小验证单元是 1 个 Lead + 1 个开发 + 1 个 AI agent
- **Demo 先行**：用 demo 证明价值，而不是等产品完美
- **开源**：降低试用门槛
- **Human + Agent 算团队**：一个人 + 2-3 个 AI agent 也是"多 agent 协作"场景（注意：这个场景下 drift 价值较弱，因为方案变更者和执行者是同一个人）

### 问题 5：Plan 回滚

**问题：** Plan 状态机是 `draft → proposed → active → superseded`，单向不可逆。如果 v2 激活后发现不对，想回到 v1 怎么办？

**解决方案：支持重新激活旧版本**

```
操作：plansync_plan_reactivate (version)
效果：
  1. 将 superseded 的 Plan 标记回 active
  2. 原 active Plan 标为 superseded
  3. 触发 Drift Engine 扫描（与普通 activate 逻辑一致）
  4. 写入 Activity (type='plan_reactivated')

状态机补充：
  draft → proposed → active → superseded
                       ↑          │
                       └──────────┘  (reactivate)

约束：
  - 只有 superseded 状态的 Plan 可以 reactivate
  - Reactivate 同样触发 drift 扫描
  - Activity 中记录 "从 v2 回滚到 v1" 的操作日志
```

### 问题 6：Plan 协作编辑——团队如何参与方案制定？

**问题：** 当前设计中只有 Lead 能创建 Plan，其他人只能 approve/reject。实际场景中，团队成员（包括 AI Agent）在开发过程中会发现方案需要调整。

**解决方案：Suggestion + Owner 审批（PR 风格）**

```
角色分工：
  Owner（Lead）：
    - 创建 Plan Draft
    - 直接编辑 Draft（PATCH）
    - 审查并 accept/reject Suggestion
    - 控制 propose → activate 流程

  Developer / Agent：
    - 提交 PlanSuggestion（建议修改 Plan 的某个字段）
    - 必须说明修改原因（reason 必填）
    - 不能直接修改 Draft 内容

工作流：
  1. Owner 创建 Plan v2 (draft)
  2. 团队成员（包括 AI Agent）通过 plansync_plan_suggest 提交建议
  3. Owner 在 Web Dashboard 或 CLI 逐条审查：
     - accept → 自动合入 Draft
     - reject → 标记拒绝并附回复
  4. Owner 也可以直接 PATCH Draft 做自己的修改
  5. 满意后 → propose → review → activate

冲突处理（Owner 裁决）：
  - 两个 append 建议（都是往数组追加）→ 不冲突，都可 accept
  - 两个 set 建议（都替换同一字段）→ accept 第一个后，第二个自动标记 conflict
  - conflict 状态需要 Owner 重新评估

AI Agent 的典型参与：
  Agent 执行任务时发现 "Plan 要求用 bcrypt，但 bcrypt 在当前环境不可用"
  → 自动调用 plansync_plan_suggest:
      field: 'constraints'
      action: 'set'
      value: '使用 argon2 替代 bcrypt（bcrypt 在当前 Node 18 环境有兼容问题）'
      reason: 'bcrypt 的 node-gyp 编译在当前 NFS 环境下失败'
  → Owner 收到通知，决定是否采纳
```

---

## 四个 Phase 总览

| Phase | 交付物 | 核心价值 | 天数 |
|-------|--------|---------|------|
| **Phase 1** | MCP Server + API + Drift Engine + Wrapper | CLI 完整闭环：检测 drift | Day 1-14（2 周） |
| **Phase 2** | Agent 实时协调 + Web Dashboard | 差异化：Agent 被主动通知；产品可视化 | Day 15-28（2 周） |
| **Phase 3** | 开放 API + GitHub/Slack 集成 + Webhook | 生态壁垒：融入现有工具链 | Day 29-38（~1.5 周） |
| **Phase 4** | 智能层（语义 diff + 影响评估 + 冲突预测） | 加分项：让 drift 更精准 | Day 39-48（~1.5 周） |

> **总计约 7 周。** 最初估计全部 4 个 Phase 只需 24 天（每 Phase 约 6 天），过于激进——仅 Phase 1 就包含 10 张表、30+ API、38 个 MCP 工具、Drift Engine、Wrapper 脚本，需要充足的时间确保质量。

---

# Phase 1：CLI 闭环（Day 1-14）

> 目标：MCP + API + Drift Engine，在终端里跑通完整工作流。

## 产品体验

用户用 `plansync` 启动（wrapper 模式），或直接配 MCP Server 到 Genie / Claude Code / Cursor。启动后就是增强版的 AI 编码工具——既能写代码，又能管理计划和任务，所有状态自动共享给团队。

### 场景 A：Plan 模式 — 对齐方案

```
$ plansync

→ AI: "你好 TeamLead，当前项目 AuthSystem 还没有激活的 Plan。要创建一个吗？"

→ 用户: "先把团队加进来：Alice 和 Bob 是开发者，Agent-1 和 Agent-2 也加上"
→ AI: 调用 plansync_member_add × 4
→ AI: "✓ 团队已就绪：
        👑 TeamLead (owner)
        Alice (developer), Bob (developer)
        Agent-1 (agent), Agent-2 (agent)"

→ 用户: "我们要做一个认证系统，用 JWT，bcrypt 加密，token 15 分钟过期"
→ AI: 调用 plansync_plan_create，自动生成结构化 Plan v1
→ AI: "Plan v1 已创建 (draft)。要直接激活还是先让团队审核？
        团队成员也可以通过 plansync_plan_suggest 提出修改建议。"

→ 用户: "让 Alice 和 Bob 审核"
→ AI: 调用 plansync_plan_propose，提交审批

# Alice 启动 plansync
$ plansync
→ AI: "你好 Alice，有一个待审核的 Plan v1。要看一下吗？"
→ Alice: "可以，approve"
→ AI: 调用 plansync_review_approve

# Bob 也 approve 后，TeamLead：
→ 用户: "激活 plan"
→ AI: 调用 plansync_plan_activate
→ AI: "✓ Plan v1 已激活。现在可以创建任务了。"
```

### 场景 B：Task 模式 — 分配任务并写代码

```
# TeamLead
→ 用户: "创建 4 个任务：登录 API 给 Alice，Token 存储给 Agent-2，
         刷新逻辑给 Bob，登录页 UI 暂时不分配"
→ AI: 调用 plansync_task_create × 4，自动绑定 Plan v1

# Alice 启动 plansync
$ plansync
→ AI: "你好 Alice，你有一个任务 TASK-123 '实现登录 API'（Plan v1）。要开始吗？"
→ Alice: "开始"
→ AI: 调用 plansync_start_task，获取 Plan 上下文
→ AI: "好的，当前 Plan 要求用 JWT + bcrypt，token 15 分钟过期。
        我来帮你实现登录 API。先创建 route.ts..."
→ [正常写代码]

→ Alice: "写完了"
→ AI: 调用 plansync_complete_task，回传结果
→ AI: "✓ TASK-123 完成。3 个文件修改，分支 task/TASK-123-login-api"
```

### 场景 C：方案变更 → Drift 检测

```
# TeamLead 决定改方案
→ 用户: "创建新方案，把 JWT 改成 OAuth 2.0，用 NextAuth.js"
→ AI: 调用 plansync_plan_create，生成 Plan v2
→ 用户: "激活"
→ AI: 调用 plansync_plan_activate
→ AI: "✓ Plan v2 已激活。
        ⚠ 发现 2 个 drift：
        🔴 HIGH: TASK-127 'Token 存储' — Agent-2 正在按 v1 执行
        🟡 MEDIUM: TASK-124 '刷新逻辑' — Bob 待开始，绑定 v1
        要处理吗？"

→ 用户: "TASK-124 rebind 到 v2，TASK-127 取消重做"
→ AI: 调用 plansync_drift_resolve × 2
```

### 场景 D：查看状态

```
→ 用户: "大家进度怎么样？"
→ AI: 调用 plansync_status
→ AI: "AuthSystem 项目状态：
        Plan v2 (OAuth 2.0) 激活中
        ├ Alice    [human]  完成 TASK-123 (v1)
        ├ Agent-2  [agent]  执行中 TASK-127 (v1 ⚠ drift!)
        ├ Bob      [human]  空闲
        └ Drift: 1 open (🔴 HIGH)
        最近活动：10:30 TeamLead 激活了 Plan v2"
```

### 场景 E：新人加入

```
$ plansync
→ AI: "你好 NewPerson，这是你第一次使用 AuthSystem 项目。
        当前 Plan v2: OAuth 2.0 + refresh token
        有 1 个未分配任务：TASK-130 '登录页 UI'
        要领取吗？"
→ NewPerson: "好的，我来做"
→ AI: 调用 plansync_task_claim
→ AI: "✓ TASK-130 已分配给你，绑定 Plan v2。要开始吗？"
```

### 场景 F：★ 协作调整 Plan — Suggestion 工作流

```
# Agent-1 在执行 TASK-125 时发现问题
→ Agent-1 的 AI: "发现 Plan 要求用 bcrypt，但 bcrypt 的 node-gyp 在当前环境编译失败。
                   我来提交一个修改建议。"
→ AI: 调用 plansync_plan_suggest:
      field='constraints', action='set',
      value='使用 argon2 替代 bcrypt', reason='bcrypt node-gyp 编译在 NFS 环境失败'
→ AI: "✓ 建议已提交，等待 Lead 审查。我先继续做其他不受影响的部分。"

# Alice 也有想法
$ plansync
→ Alice: "我觉得 Plan v2 应该加上 httpOnly cookie 的约束"
→ AI: 调用 plansync_plan_suggest:
      field='constraints', action='append',
      value='token 必须存储在 httpOnly cookie 中', reason='防止 XSS 攻击窃取 token'
→ AI: "✓ 建议已提交。"

# TeamLead（owner）看到建议
$ plansync
→ AI: "你好 TeamLead，当前 Plan v2 有 2 个待处理的建议：
        💡 #1 Agent-1: 将 bcrypt 改为 argon2（bcrypt 编译失败）
        💡 #2 Alice: 追加 httpOnly cookie 约束（防 XSS）
        要处理吗？"
→ 用户: "Agent-1 的建议接受，Alice 的也接受"
→ AI: 调用 plansync_suggestion_accept × 2
→ AI: "✓ 两条建议已采纳并合入 Plan v2 Draft。
        当前 constraints 已更新：
        - 使用 argon2（替代 bcrypt）
        - token 必须存储在 httpOnly cookie 中
        要提交审批还是继续调整？"

# Web Dashboard 上也能看到 Suggestion 面板，实时更新
```

### 场景 G：★ Plan 讨论 — Comment 工作流

```
# TeamLead 在 Plan v2 draft 阶段发起讨论
$ plansync
→ 用户: "在 Plan v2 里发个评论，问下大家：JWT 还是 session-based？"
→ AI: 调用 plansync_plan_comment:
      planId=<Plan v2 的 cuid>, content='JWT 还是 session-based？大家怎么看'
→ AI: "✓ 评论已发布。"

# Alice 在自己的终端看到讨论
$ plansync
→ AI: "Plan v2 有 1 条新评论：
        💬 TeamLead: 'JWT 还是 session-based？大家怎么看'"
→ 用户: "回复一下，建议 JWT，我们前端是 SPA 适合无状态"
→ AI: 调用 plansync_plan_comment:
      planId=<Plan v2 的 cuid>, content='建议 JWT，我们前端是 SPA，适合无状态',
      parentId=<TeamLead 评论的 commentId>
→ AI: "✓ 回复已发布。"

# Agent-1 执行任务时也参与讨论
→ Agent-1 AI: 调用 plansync_plan_comment:
      planId=<Plan v2 的 cuid>, content='同意 Alice。补充：argon2 的 WASM 版不需要 node-gyp 编译，适合 NFS 环境',
      parentId=<TeamLead 评论的 commentId>

# 讨论形成共识后，TeamLead 提交正式修改
→ 用户: "好，那就 JWT。把这个加到 constraints 里"
→ AI: 调用 plansync_plan_update:
      fields={ constraints: [..., '认证方案使用 JWT'] }
→ AI: "✓ Plan v2 Draft 已更新。讨论中的共识已落地为正式约束。"

# 与 Suggestion 的区别：
#   Comment → 自由讨论，不改 Plan 内容
#   Suggestion → 结构化提案，accept 后自动合入
#   典型流程：先 Comment 讨论 → 形成共识 → 用 Suggestion 或直接 PATCH 落地
```

---

## Phase 1 架构

```
┌──────────────────────────────────────────────────────┐
│  plansync (Wrapper 脚本)                             │
│  ┌──────────────────────────────────────────────┐    │
│  │  Genie / Claude Code / Cursor / 任何 MCP 宿主 │    │
│  │  ├── 正常写代码能力                           │    │
│  │  └── PlanSync MCP Server (本地进程)           │    │
│  │      └── 38 个 MCP Tools                     │    │
│  └──────────────────────────────────────────────┘    │
│  + 心跳后台进程                                      │
│  + 启动/退出生命周期管理                              │
└──────────────────┬───────────────────────────────────┘
                   │ HTTP
┌──────────────────▼───────────────────────────────────┐
│  PlanSync API (Next.js API Routes)                   │
│  ├── Plan CRUD + 单 active 约束                      │
│  ├── Task CRUD + 自动版本绑定                        │
│  ├── ★ Drift Engine (Plan 激活时扫描)                │
│  ├── ExecutionRun + 心跳                             │
│  └── Activity 事件流                                 │
│                    │                                  │
│  PostgreSQL（本地 / 团队共享实例）                      │
└──────────────────────────────────────────────────────┘
```

### Wrapper 宿主兼容

两种使用方式，MCP Server 是核心：

```bash
# 方式 1：用 wrapper（自动启动 MCP Server + 注入配置 + 启动宿主）
$ plansync                     # 默认用 genie（Phase 1 聚焦）
$ plansync --host claude       # 用 claude code（Phase 2 适配）
$ plansync --host cursor       # 用 cursor（Phase 2 适配）

# 方式 2：直接配 MCP Server 到任何支持 MCP 的工具（推荐）
# settings.json / MCP 配置：
{
  "mcpServers": {
    "plansync": {
      "command": "node",
      "args": ["/path/to/plansync/mcp-server/dist/index.js"],
      "env": {
        "PLANSYNC_API_URL": "https://your-api.vercel.app",
        "PLANSYNC_USER": "alice",
        "PLANSYNC_PROJECT": "auth-system"
      }
    }
  }
}
```

> **Phase 1 策略：** 聚焦 Genie（`/proj/verif_release_ro/genie/current/bin/genie`）一个宿主做好 wrapper + MCP 集成，方式 2（直接配 MCP Server）天然兼容所有宿主。Phase 2 再适配 Claude Code 和 Cursor 的 wrapper。

### `plansync` Wrapper 启动流程

```
$ plansync [--host genie|claude|cursor] [宿主的原有参数...]

默认宿主：genie（路径：/proj/verif_release_ro/genie/current/bin/genie）

1. 读取 ~/.plansync/config.json（API URL, user name, active project）
2. 确保 nvm Node 18 已激活
3. 构建 MCP Server（如果 dist/ 不存在）
4. 注入 MCP 配置到宿主：
   - genie：使用 `genie scheme apply plansync`（声明式 MCP 配置）
     scheme 文件定义 MCP Server 路径、环境变量、启动参数
   - claude：写入 ~/.claude/settings.json 的 mcpServers 字段
   - cursor：写入 .cursor/mcp.json
5. 注入 AGENTS.md / CLAUDE.md 指令到项目目录
6. 启动宿主（透传所有参数）
   - genie：/proj/verif_release_ro/genie/current/bin/genie
   - claude：~/.npm-global/bin/claude
   - cursor：自动生效（已写入配置）
7. 启动后台心跳进程（如果有 active task）
8. 宿主退出后：
   a. 停止心跳
   b. 清理注入的配置文件（可选，保留也无害）
```

### Genie Scheme 配置

```yaml
# plansync-scheme.yaml — 供 `genie scheme apply` 使用
name: plansync
description: PlanSync MCP Server for plan coordination
plugins:
  plansync:
    type: mcp
    command: node
    args:
      - /path/to/plansync/packages/mcp-server/dist/index.js
    env:
      PLANSYNC_API_URL: "${PLANSYNC_API_URL}"
      PLANSYNC_USER: "${PLANSYNC_USER}"
      PLANSYNC_PROJECT: "${PLANSYNC_PROJECT}"
      PLANSYNC_SECRET: "${PLANSYNC_SECRET}"
```

### 跨 Server 共享

```
Server A (Phase 1)    Server B              Server C
  plansync              plansync              plansync
  ├ Genie ★             ├ Claude Code         ├ Cursor
  └ MCP Server ──┐      └ MCP Server ──┐      └ MCP Server ──┐
                 │                      │                      │
                 └──────────────────────┴──────────────────────┘
                                        │ HTTP
                                PlanSync API (Vercel)
                                        │
                                PostgreSQL（共享实例）
```

---

## MCP Tools（38 个）

### 项目管理（4 个）

| Tool | 参数 | 说明 |
|------|------|------|
| `plansync_project_create` | name, description?, repoUrl? | 创建项目（自动成为 owner） |
| `plansync_project_list` | — | 列出项目 |
| `plansync_project_show` | projectName? | 查看项目详情（默认当前活动项目） |
| `plansync_project_switch` | projectName | 切换活动项目（MCP 客户端本地状态，不调用 API） |

### ★ 成员管理（4 个）

| Tool | 参数 | 说明 |
|------|------|------|
| `plansync_member_add` | name, role: owner\|developer, type: human\|agent | 添加成员（owner 权限） |
| `plansync_member_list` | — | 列出项目成员及角色 |
| `plansync_member_update` | name, role: owner\|developer | 修改成员角色（owner 权限） |
| `plansync_member_remove` | name | 移除成员（owner 权限） |

### 计划管理（10 个）

| Tool | 参数 | 说明 |
|------|------|------|
| `plansync_plan_create` | title, goal, scope, constraints[], standards[], deliverables[], openQuestions[], changeSummary?, why? | 创建 plan draft |
| `plansync_plan_list` | — | 列出所有版本 |
| `plansync_plan_show` | version? | 查看 plan（默认 active；MCP 内部按 version 查 planId 再调 API） |
| `plansync_plan_update` | planId, fields: { goal?, scope?, constraints?, ... } | ★ 编辑 draft（仅 draft 状态，owner 权限） |
| `plansync_plan_propose` | planId, reviewers[] | 提交审批（owner 权限） |
| `plansync_plan_activate` | version? | ★ 激活（触发 drift 扫描，owner 权限；MCP 内部按 version 查 planId 再调 `/plans/:planId/activate`） |
| `plansync_plan_reactivate` | version | 回滚：重新激活旧版本（owner 权限；同上，version → planId 翻译） |
| `plansync_plan_suggest` | planId, field, action: set\|append\|remove, value, reason | ★ 提交修改建议（任何成员，含 Agent） |
| `plansync_review_approve` | planId, comment? | 批准（MCP 内部按 planId + 当前用户查找 reviewId，再调 API） |
| `plansync_review_reject` | planId, comment? | 拒绝（同上，MCP 做 planId → reviewId 翻译） |

### ★ 建议管理（3 个）

| Tool | 参数 | 说明 |
|------|------|------|
| `plansync_suggestion_list` | planId, status? | 列出 Plan 的建议（?status=pending） |
| `plansync_suggestion_accept` | suggestionId, comment? | 采纳建议（自动合入 draft，owner 权限） |
| `plansync_suggestion_reject` | suggestionId, comment? | 拒绝建议（owner 权限） |

### ★ Plan 讨论（4 个）

| Tool | 参数 | 说明 |
|------|------|------|
| `plansync_plan_comment` | planId, content, parentId? | 发表评论（支持回复，任何成员） |
| `plansync_plan_comments` | planId | 列出 Plan 的所有评论（含回复） |
| `plansync_comment_edit` | commentId, content | 编辑自己的评论 |
| `plansync_comment_delete` | commentId | 删除自己的评论（owner 可删任何人的） |

### 任务管理（6 个）

| Tool | 参数 | 说明 |
|------|------|------|
| `plansync_task_create` | title, description?, type?, priority?, assignee? | 创建任务（自动绑定 active plan） |
| `plansync_task_list` | status?, assignee? | 列出任务 |
| `plansync_task_show` | taskId | 查看任务详情（含 drift 状态） |
| `plansync_task_update` | taskId, fields: { title?, description?, priority?, assignee? } | 更新任务字段 |
| `plansync_task_claim` | taskId | 自己领取任务 |
| `plansync_task_rebind` | taskId | 重绑到 active plan version |

### 执行管理（2 个）

| Tool | 参数 | 说明 |
|------|------|------|
| `plansync_start_task` | taskId | 开始执行（返回 Plan 上下文 + 创建 ExecutionRun） |
| `plansync_complete_task` | taskId, summary?, filesChanged[]?, blockers[]? | 完成执行 |

### 状态查看（5 个）

| Tool | 参数 | 说明 |
|------|------|------|
| `plansync_status` | — | 项目总览（plan + tasks + executors + drift + suggestions） |
| `plansync_who` | — | 活跃执行人列表（聚合 GET /status 中的 executor 数据） |
| `plansync_drift` | — | drift 告警列表 |
| `plansync_drift_resolve` | alertId, action: rebind\|cancel\|no_impact | 解决 drift（owner 权限） |
| `plansync_log` | limit? | 最近活动 |

---

## CLAUDE.md 注入内容

```markdown
# PlanSync

你现在连接了 PlanSync 协作平台。你有以下能力：
- 管理项目计划（创建、审批、激活 Plan 版本）
- 管理任务（创建、分配、领取、执行）
- 查看团队状态（谁在做什么、drift 告警）
- ★ 对 Plan 提出修改建议（plansync_plan_suggest）
- ★ 在 Plan 下发表评论进行讨论（plansync_plan_comment）

你的角色取决于项目成员配置：
- owner：可以激活 Plan、编辑 Draft、采纳/拒绝建议、解决 drift
- developer：可以执行任务、提交建议、参与审批

启动时请：
1. 调用 plansync_status 获取当前项目状态
2. 告诉用户当前情况（active plan、待做任务、drift 告警、待处理的建议）
3. 询问用户想做什么

当用户开始执行任务时：
1. 调用 plansync_start_task 获取 Plan 上下文和任务详情
2. 按照 Plan 的 constraints 和 standards 写代码
3. 完成后调用 plansync_complete_task 回传结果

★ 当你在执行任务中发现 Plan 的约束有问题时：
1. 调用 plansync_plan_suggest 提出修改建议
2. 说明你发现了什么问题、建议怎么改、为什么要改
3. 继续执行任务（不要因为提了建议就停下来）
4. 如果问题是阻塞性的（无法按当前 Plan 继续），告知用户并等待 Lead 处理

★ 讨论 Plan 时：
1. 调用 plansync_plan_comment 发表评论或回复他人
2. 用于提问、分享发现、讨论设计决策等自由讨论（不改 Plan 内容）
3. 如果讨论后形成明确的修改意见，再用 plansync_plan_suggest 提交正式建议
```

---

## 数据模型（10 个对象）

```
Project
  ├── ProjectMember                  ← ★ 成员 + 角色（owner/developer）
  ├── Plan (v1, v2, v3...)           ← 唯一 active 约束，draft 阶段可编辑
  │     ├── PlanReview               ← 审批记录（propose 时自动创建）
  │     ├── PlanSuggestion           ← ★ 成员对 Plan 的修改建议
  │     └── PlanComment              ← ★ Plan 讨论评论（支持回复）
  ├── Task                           ← 绑定 boundPlanVersion
  │     ├── ExecutionRun             ← 执行记录
  │     └── DriftAlert ←──┐         ← Plan 变更时自动生成（同时关联 Project）
  └── Activity               │       ← 事件流（仅服务端内部写入）
                             │
  注：DriftAlert 同时持有 projectId 和 taskId 两个 FK
```

### Project
```typescript
{
  id: string,            // cuid
  name: string,          // 项目名，唯一
  description?: string,
  phase: string,         // 'planning' | 'active' | 'completed'
  repoUrl?: string,
  defaultBranch?: string,
  createdBy: string,     // 用户名
  createdAt: DateTime,
  updatedAt: DateTime
}
```

### ProjectMember
```typescript
{
  id: string,
  projectId: string,       // FK → Project
  name: string,            // 用户名（唯一于 project 内）
  role: 'owner' | 'developer',
  type: 'human' | 'agent',
  createdAt: DateTime
}
// 规则：
//   创建 Project 的人自动成为 owner
//   一个 Project 可以有多个 owner
//   owner 可以添加/移除成员
//   owner 也可以同时执行 Task（Lead + 开发者双重身份）
//
// 权限矩阵：
//                              owner    developer
//   激活/回滚 Plan              ✅        ❌
//   编辑 Draft (PATCH)          ✅        ❌
//   提交审批 (propose)          ✅        ❌
//   accept/reject Suggestion    ✅        ❌
//   解决 drift alert            ✅        ❌
//   管理成员                     ✅        ❌
//   创建 Plan draft             ✅        ✅
//   提交 Suggestion             ✅        ✅
//   review (approve/reject)     ✅        ✅
//   创建/claim/执行 Task        ✅        ✅
//   查看所有状态                 ✅        ✅
```

### Plan
```typescript
{
  id: string,
  projectId: string,     // FK → Project
  version: number,       // 自增，同 project 内唯一
  status: 'draft' | 'proposed' | 'active' | 'superseded',
  title: string,
  goal: string,          // 方案目标
  scope: string,         // 范围描述
  constraints: string[], // 技术约束（如 "必须用 bcrypt"）
  standards: string[],   // 编码标准
  deliverables: string[],// 交付物清单
  openQuestions: string[],// 待定问题
  changeSummary?: string,// 相比上一版改了什么
  why?: string,          // 为什么改
  requiredReviewers: string[], // 需要审批的人
  createdBy: string,
  activatedAt?: DateTime,
  activatedBy?: string,
  createdAt: DateTime,
  updatedAt: DateTime
}
// 约束：同一 project 只有 1 个 status='active'（DB partial unique index）
// 状态机：draft → proposed → active → superseded
//                              ↑          │
//                              └──────────┘  (reactivate)
// 快捷路径：draft 可跳过 proposed 直接 activate（无 reviewer 时）
// 回滚：superseded 可通过 reactivate 重新变为 active（触发 drift 扫描）
//
// ★ Draft 可编辑：
//   status='draft' 时，owner 可通过 PATCH 直接修改 Plan 内容
//   status='proposed'/'active'/'superseded' 时，Plan 内容不可变
//   Developer 不能直接编辑 Draft，只能通过 PlanSuggestion 提出修改建议
```

#### Plan 粒度标准

> 详见「问题 3：Plan 粒度」章节。核心原则：**Plan 的粒度 = "改了会导致已有代码需要重写的决策"**。

### PlanReview
```typescript
{
  id: string,
  planId: string,         // FK → Plan
  reviewerName: string,
  status: 'pending' | 'approved' | 'rejected',
  comment?: string,
  createdAt: DateTime,
  updatedAt: DateTime
}
// 规则：所有 reviewer 都 approved 后，Plan 可以 activate
```

### PlanSuggestion
```typescript
{
  id: string,
  planId: string,           // FK → Plan
  suggestedBy: string,      // 提议人（人类或 Agent 名）
  suggestedByType: 'human' | 'agent',
  field: string,            // 可建议修改的字段：'goal' | 'scope' | 'constraints' | 'standards' | 'deliverables' | 'openQuestions'
                           // 注意：title/changeSummary/why 属于元信息，不在建议范围内（由 owner 直接编辑 draft）
  action: 'set' | 'append' | 'remove',
  //   set:    将字段值替换为 value（用于 string 字段：goal, scope）
  //   append: 向数组字段追加 value（用于 array 字段：constraints, standards...）
  //   remove: 从数组字段移除 value
  value: string,            // 建议的内容
  reason: string,           // 为什么要改（必填，让 Lead 理解动机）
  status: 'pending' | 'accepted' | 'rejected' | 'conflict',
  resolvedBy?: string,      // owner 处理人
  resolvedComment?: string, // owner 的回复
  createdAt: DateTime,
  resolvedAt?: DateTime
}
// 规则：
//   任何成员（owner / developer / agent）都可以对 draft 或 proposed 的 Plan 提建议
//   只有 owner 可以 accept / reject
//   accept 后自动合入 Plan Draft（或由 owner 手动合入 proposed Plan）
//
// 冲突检测：
//   两个 suggestion 都是 append 到同一数组 → 不冲突，都可 accept
//   两个 suggestion 都是 set 同一字段 → accept 第一个后，第二个自动标记 conflict
//   conflict 状态的 suggestion 需要 owner 重新评估（reject 或修改后手动合入）
//
// AI Agent 典型使用场景：
//   Agent 执行 Task 时发现 Plan 约束有问题（如 "bcrypt 在当前环境不可用"）
//   → 自动调用 plansync_plan_suggest 提出修改建议
//   → Lead 在 Web Dashboard 或 CLI 审查并决定是否采纳
```

### PlanComment
```typescript
{
  id: string,
  planId: string,          // FK → Plan
  authorName: string,
  authorType: 'human' | 'agent',
  content: string,         // Markdown 格式的评论内容
  parentId?: string,       // FK → PlanComment（回复某条评论，null 表示顶层评论）
  isDeleted: boolean,      // 软删除标记（默认 false）
  createdAt: DateTime,
  updatedAt: DateTime
}
// 规则：
//   任何成员（owner / developer / agent）都可以评论
//   支持嵌套回复（一层，parentId 指向顶层评论）
//   Plan 任何状态下都可以评论（draft / proposed / active / superseded）
//   用途：讨论方案、提问、记录决策原因
//   与 PlanSuggestion 的区别：
//     Comment = 自由讨论（"为什么选 JWT？"）
//     Suggestion = 结构化修改提案（"把 JWT 改成 OAuth"）
//
// 软删除策略：
//   删除时：isDeleted = true，content 置为空字符串（保留记录占位）
//   有子回复的父评论被删除后，UI 显示「此评论已删除」占位，子回复正常展示
//   无子回复的评论被删除后，UI 可选择隐藏或显示占位
//   查询时默认包含 isDeleted=true 的记录（保持回复链完整）
```

### Task
```typescript
{
  id: string,
  projectId: string,      // FK → Project
  title: string,
  description?: string,
  type: 'code' | 'research' | 'design' | 'bug' | 'refactor',
  priority: 'p0' | 'p1' | 'p2',
  status: 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled',
  assignee?: string,      // 执行人名
  assigneeType: 'human' | 'agent' | 'unassigned',
  boundPlanVersion: number, // ★ 创建时自动绑定当前 active plan version
  branchName?: string,
  prUrl?: string,
  // Agent 专用字段
  agentContext?: string,    // 给 agent 的额外上下文
  expectedOutput?: string,  // 期望输出描述
  agentConstraints: string[], // agent 约束
  createdAt: DateTime,
  updatedAt: DateTime
}
```

### ExecutionRun
```typescript
{
  id: string,
  taskId: string,           // FK → Task
  executorType: 'human' | 'agent',
  executorName: string,
  boundPlanVersion: number, // 执行时的版本快照
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'stale',
  taskPackSnapshot: JSON,   // 完整上下文快照（Plan + Task 内容）
  lastHeartbeatAt?: DateTime,
  outputSummary?: string,
  filesChanged: string[],
  branchName?: string,
  blockers: string[],
  driftSignals: string[],
  startedAt: DateTime,
  endedAt?: DateTime
}
// 心跳机制：
//   MCP Server 每 30s 发 heartbeat
//   5min 无心跳 → status 标为 stale（UI 显示警告）
//   30min 无心跳 → status 自动设为 failed
```

### DriftAlert
```typescript
{
  id: string,
  projectId: string,        // FK → Project
  taskId: string,           // FK → Task
  type: 'version_mismatch', // Phase 1 只做这一种；Phase 4 加 'semantic_mismatch'
  severity: 'high' | 'medium' | 'low',
  reason: string,           // 人类可读的原因描述
  status: 'open' | 'resolved',
  resolvedAction?: 'rebind' | 'cancel' | 'no_impact',
  currentPlanVersion: number,  // 当前 active 版本
  taskBoundVersion: number,    // 任务绑定的版本
  // Phase 4 扩展字段（预留，Phase 1 不实现）
  compatibilityScore?: number,    // 0-100，AI 评估的兼容性
  impactAnalysis?: string,        // AI 生成的影响分析
  suggestedAction?: string,       // AI 建议
  createdAt: DateTime,
  resolvedAt?: DateTime,
  resolvedBy?: string
}
// Severity 计算规则（cancelled 的 Task 不参与扫描）：
//   有 running ExecutionRun → HIGH（正在按旧方案写代码）
//   Task status = in_progress | blocked | todo → MEDIUM
//   Task status = done → LOW（已完成，可能需要返工）
```

### Activity
```typescript
{
  id: string,
  projectId: string,        // FK → Project
  type: string,             // 'plan_created' | 'plan_activated' | 'task_started' | 'drift_detected' | ...
  actorName: string,
  actorType: 'human' | 'agent' | 'system',
  summary: string,          // 人类可读摘要
  metadata?: JSON,          // 附加数据
  createdAt: DateTime
}
```

---

## 工程规范

### API 输入校验（Zod）

所有 API 端点使用 `@plansync/shared` 中定义的 Zod schema 做运行时校验：

```typescript
// packages/shared/src/schemas/plan.ts
import { z } from 'zod';

export const PlanCreateSchema = z.object({
  title: z.string().min(1).max(200),
  goal: z.string().min(1),
  scope: z.string().min(1),
  constraints: z.array(z.string()).default([]),
  standards: z.array(z.string()).default([]),
  deliverables: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  changeSummary: z.string().optional(),
  why: z.string().optional(),
});

export type PlanCreateInput = z.infer<typeof PlanCreateSchema>;

// packages/api/src/lib/validate.ts — 通用校验 helper
import { NextRequest, NextResponse } from 'next/server';
import { ZodSchema, ZodError } from 'zod';
import { formatZodError } from '@plansync/shared';

export function validateBody<T>(schema: ZodSchema<T>, body: unknown): T {
  return schema.parse(body);  // 失败时抛出 ZodError → 被全局错误处理捕获
}

// API Route 中使用：
export async function POST(req: NextRequest) {
  const body = await req.json();
  const input = validateBody(PlanCreateSchema, body);
  // input 是类型安全的 PlanCreateInput
}
```

MCP Server 的 tool 参数也引用同一套 schema，保证 MCP 和 API 的校验规则完全一致。

### 统一 API 错误响应格式

```typescript
// packages/shared/src/errors.ts
export enum ErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  PLAN_NOT_ACTIVE = 'PLAN_NOT_ACTIVE',
  DRIFT_ALREADY_RESOLVED = 'DRIFT_ALREADY_RESOLVED',
  TASK_ALREADY_CLAIMED = 'TASK_ALREADY_CLAIMED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
  }
}

// 所有 API 错误响应统一为：
// {
//   error: {
//     code: "VALIDATION_ERROR",
//     message: "title 不能为空",
//     status: 400,
//     details: { field: "title", issue: "required" }
//   }
// }

// packages/api/src/lib/errors.ts — API 全局错误处理
export function handleApiError(error: unknown): NextResponse {
  if (error instanceof AppError) {
    return NextResponse.json({ error: { code: error.code, message: error.message, status: error.status, details: error.details } }, { status: error.status });
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: formatZodError(error), status: 400, details: error.errors } }, { status: 400 });
  }
  logger.error({ error }, 'Unhandled error');
  return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error', status: 500 } }, { status: 500 });
}
```

### 结构化日志

```typescript
// packages/api/src/lib/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development'
    ? { target: 'pino-pretty' }   // 开发环境：可读格式
    : undefined,                    // 生产环境：JSON 格式
});

// 使用方式：
logger.info({ projectId, planVersion }, 'Plan activated');
logger.error({ error, taskId }, 'Drift engine failed');

// 每个 API 请求自动注入 requestId（通过 middleware）：
// logger.child({ requestId: crypto.randomUUID() })
```

```typescript
// packages/mcp-server/src/logger.ts — MCP SDK 结构化日志
// 使用 MCP 协议标准的 notifications/message 发送日志
// 遵循 RFC 5424 级别：debug, info, notice, warning, error

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function createLogger(server: McpServer) {
  return {
    debug: (msg: string, data?: object) =>
      server.server.sendLoggingMessage({ level: 'debug', logger: 'plansync', data: { message: msg, ...data } }),
    info: (msg: string, data?: object) =>
      server.server.sendLoggingMessage({ level: 'info', logger: 'plansync', data: { message: msg, ...data } }),
    warn: (msg: string, data?: object) =>
      server.server.sendLoggingMessage({ level: 'warning', logger: 'plansync', data: { message: msg, ...data } }),
    error: (msg: string, data?: object) =>
      server.server.sendLoggingMessage({ level: 'error', logger: 'plansync', data: { message: msg, ...data } }),
  };
}
```

### MCP Server 错误处理规范

```typescript
// MCP 工具调用失败时，使用 SDK 标准的 McpError：
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// 校验失败 → InvalidParams
throw new McpError(ErrorCode.InvalidParams, 'title 不能为空');

// API 调用失败 → 根据 HTTP 状态码映射
function mapApiError(status: number, body: any): McpError {
  switch (status) {
    case 400: return new McpError(ErrorCode.InvalidParams, body.error?.message || 'Bad request');
    case 401: return new McpError(ErrorCode.InvalidRequest, '认证失败，请检查 PLANSYNC_SECRET');
    case 404: return new McpError(ErrorCode.InvalidParams, body.error?.message || 'Not found');
    case 409: return new McpError(ErrorCode.InvalidRequest, body.error?.message || 'Conflict');
    default:  return new McpError(ErrorCode.InternalError, `API error: ${status}`);
  }
}

// 网络错误 → InternalError + 友好提示
catch (error) {
  if (error.code === 'ECONNREFUSED') {
    throw new McpError(ErrorCode.InternalError, 'PlanSync API 不可用，请确认 API 已启动');
  }
  throw new McpError(ErrorCode.InternalError, `网络错误: ${error.message}`);
}
```

---

## Drift Engine（Phase 1 核心）

Plan 激活时在**同一个 DB 事务**内执行：

```
输入：projectId, newPlanId, activatedBy
事务内操作：
  1. 查询当前 active Plan → oldPlan（可能为 null）
  2. 如果 oldPlan 存在：oldPlan.status → 'superseded'
  3. newPlan.status → 'active'，设置 activatedAt, activatedBy
  4. 如果 oldPlan 存在：
     a. 查询 Task WHERE projectId = projectId
                  AND boundPlanVersion = oldPlan.version
                  AND status != 'cancelled'
     b. 对每个匹配的 Task，按以下优先级计算 severity：
        - 查询是否有 status='running' 的 ExecutionRun
        - if 有 running run → severity = 'high'
        - else if Task.status in ['in_progress','blocked','todo'] → severity = 'medium'
        - else (Task.status = 'done') → severity = 'low'（已完成，可能需要返工）
        - 创建 DriftAlert
     c. 如果生成了 DriftAlert：写入 Activity (type='drift_detected')
  5. 写入 Activity (type='plan_activated')
  6. 返回 { plan: newPlan, driftAlerts: DriftAlert[] }
```

### Drift 解决动作

| action | 效果 |
|--------|------|
| `rebind` | Task.boundPlanVersion → 当前 active version，DriftAlert → resolved |
| `cancel` | Task.status → 'cancelled'，running ExecutionRun → 'cancelled'，DriftAlert → resolved（需重新创建 Task 时由 owner 手动操作） |
| `no_impact` | 仅 DriftAlert → resolved（标记为不受影响） |

---

## API 端点

后端 API 供 MCP Server、Web Dashboard、第三方集成调用。

**Phase 1 认证：`X-User-Name` header 标识用户 + `Authorization: Bearer <SHARED_SECRET>` 防止未授权访问。API 根据 `X-User-Name` 查找 ProjectMember 记录来判断权限（owner/developer）。Phase 3 升级为 per-user API Key 认证。**

> **安全说明：** 纯本地开发时可关闭 Bearer 校验（`AUTH_DISABLED=true`）。部署到公网时必须设置 `PLANSYNC_SECRET` 环境变量，否则 API 拒绝启动。

```
Project:
  POST   /api/projects                          创建项目（创建者自动成为 owner）
  GET    /api/projects                          列出项目
  GET    /api/projects/:id                      项目详情
  PATCH  /api/projects/:id                      更新项目（description/repoUrl/defaultBranch，owner 权限，Web Dashboard 用，无对应 MCP 工具）
  GET    /api/projects/:id/status               聚合状态

★ ProjectMember（成员管理）:
  POST   /api/projects/:id/members              添加成员（owner 权限）
  GET    /api/projects/:id/members              列出成员
  PATCH  /api/projects/:id/members/:memberId    修改角色（owner 权限）
  DELETE /api/projects/:id/members/:memberId    移除成员（owner 权限）

Plan:
  POST   /api/projects/:id/plans                创建 draft
  GET    /api/projects/:id/plans                列出所有版本
  GET    /api/projects/:id/plans/active          获取当前 active plan
  GET    /api/projects/:id/plans/:planId         获取指定 plan
  ★ PATCH /api/projects/:id/plans/:planId       编辑 draft（仅 status=draft，owner 权限）
  POST   /api/projects/:id/plans/:planId/propose 提交审批（owner 权限）
  POST   /api/projects/:id/plans/:planId/activate ★ 激活（触发 drift，owner 权限）
  POST   /api/projects/:id/plans/:planId/reactivate  回滚（owner 权限）

★ PlanSuggestion（方案建议）:
  POST   /api/projects/:id/plans/:planId/suggestions         提交建议（任何成员）
  GET    /api/projects/:id/plans/:planId/suggestions         列出建议（?status=pending）
  POST   /api/plan-suggestions/:suggestionId/accept          采纳（owner 权限，自动合入 draft）
  POST   /api/plan-suggestions/:suggestionId/reject          拒绝（owner 权限）

★ PlanComment（讨论）:
  POST   /api/projects/:id/plans/:planId/comments         发表评论（任何成员）
  GET    /api/projects/:id/plans/:planId/comments         列出评论（?parentId= 筛选子回复）
  PATCH  /api/plan-comments/:commentId                    编辑自己的评论
  DELETE /api/plan-comments/:commentId                    删除自己的评论（owner 可删任何人的）

PlanReview（由 propose 自动创建，无需手动 POST 创建）:
  GET    /api/projects/:id/plans/:planId/reviews  列出审批记录（MCP 中由 plansync_plan_show 聚合返回）
  POST   /api/plan-reviews/:reviewId/approve      批准
  POST   /api/plan-reviews/:reviewId/reject       拒绝

Task:
  POST   /api/projects/:id/tasks                创建（自动绑定 active version）
  GET    /api/projects/:id/tasks                列出（?status=&assignee=）
  GET    /api/projects/:id/tasks/:taskId         详情
  PATCH  /api/projects/:id/tasks/:taskId         更新字段（title/description/priority/assignee）
  POST   /api/projects/:id/tasks/:taskId/claim   领取
  POST   /api/projects/:id/tasks/:taskId/rebind  重绑
  GET    /api/projects/:id/tasks/:taskId/pack    Task Pack

ExecutionRun（MCP 中 start_task/complete_task 封装了创建和完成，列表供 Web Dashboard 使用）:
  GET    /api/projects/:id/tasks/:taskId/runs    列出某 Task 的执行历史（Web Dashboard 用）
  POST   /api/projects/:id/tasks/:taskId/runs    创建执行记录
  POST   /api/runs/:runId/heartbeat              心跳（MCP Server 自动发送，无需手动调用）
  POST   /api/runs/:runId/complete               完成

DriftAlert:
  GET    /api/projects/:id/drift-alerts           列出（?status=open）
  POST   /api/drift-alerts/:alertId/resolve       解决（owner 权限）

Activity（仅服务端内部写入，无外部 POST 端点）:
  GET    /api/projects/:id/activities             列出（?limit=）
```

---

## 技术栈（Phase 1）

> **⚠ 版本约束：** 当前环境 Node 18.20.8 (nvm)。所有依赖版本已在此环境下验证通过，使用 `~` 锁定 minor 版本，禁止 `^` 范围。详见「包间依赖与版本锁定」。

| 层 | 选择 | 锁定版本 | 理由 |
|---|------|---------|------|
| Runtime | Node.js 18 (nvm) | v18.20.8 | 公司 nvm 最高可用版本 |
| Monorepo | npm workspaces | npm 10.8.2 | 原生支持，零额外安装 |
| Wrapper | Bash 脚本 | — | 轻量，无依赖 |
| MCP Server | @modelcontextprotocol/sdk | ~1.28.0 | MCP 官方 SDK, engines: node>=18 |
| API | Next.js App Router (API Routes) | ~14.2.28 | Phase 2 加页面零成本 |
| ORM | Prisma | ~6.4.1 | 类型安全，migration 管理（**7.x 要求 Node>=20，禁用**） |
| DB | PostgreSQL 13.2（本地） | — | 公司环境自带，数据不出内网 |
| 校验 | Zod | ~3.23.8 | API 输入校验 + 共享类型（**4.x API 大改，禁用**） |
| 日志 | pino (API) + MCP SDK logging | ~9.6.0 | 结构化日志（**10.x 要求 Node>=20，禁用**） |
| 语言 | TypeScript | ~5.7.3 | 类型安全（**6.x 未验证 Next.js 14 兼容性，禁用**） |
| 代码规范 | ESLint + Prettier | ~9.17 / ~3.4 | 统一代码风格 |
| 提交规范 | Husky + Commitlint | ~9.1 / ~19.6 | 规范 commit message |
| 部署 | 本地 dev / Vercel | — | Phase 1 可纯本地 |

---

## 环境前提条件验证结果

> 以下为实际环境验证结论，已将修复方案整合到 setup.sh 和 package.json 中。

### 已满足的前提条件（9 项）

| 条件 | 实测结果 | 状态 |
|------|---------|------|
| Node.js >= 18.18 | v18.20.8 (nvm) | ✓ |
| npm >= 10 | 10.8.2 | ✓ |
| PostgreSQL 13.2 工具链 | initdb/pg_ctl/psql/createdb/pg_isready 全部可用 | ✓ |
| PostgreSQL /tmp 启动 | 完整生命周期测试通过（init → start → createdb → query → stop） | ✓ |
| Git | 2.48.1 | ✓ |
| npm registry 网络 | HTTP 200，可正常下载包 | ✓ |
| MCP SDK | @modelcontextprotocol/sdk@1.28.0, engines: node>=18 | ✓ |
| Next.js 14 | 14.2.28+ 安装并通过基本测试 | ✓ |
| /tmp 磁盘空间 | 1.5TB，仅用 3%，充足 | ✓ |

### 已修复的阻塞级问题（2 项）

**B1: npm cache 在 NFS 上损坏 → `npm install` 失败**

- **根因：** `~/.npm/` 位于 NFS，NFS 的文件锁和缓存一致性不支持 npm content-addressable cache
- **修复：** 项目根目录 `.npmrc` 设置 `cache=/tmp/npm-cache-${USER}`；`setup.sh` 中额外保底 `npm config set cache`
- **验证：** `npm install --cache /tmp/npm-cache-nanyang2 zod` 成功

**B2: 未锁定依赖版本 → 拉到不兼容的最新版**

- **根因：** 默认 `npm install` 安装 prisma 7.x (Node>=20)、zod 4.x (API 大改)、typescript 6.x (未验证)
- **修复：** 所有 package.json 使用 `~` 锁定到 Node 18 验证通过的版本（详见「包间依赖与版本锁定」）
- **关键规则：** Zod 必须用 v3 API（本文档所有 `.parse()` / `.object()` / `.array()` 示例均为 v3 语法）

### 注意事项

- **NFS 限制：** 项目目录和 HOME 目录均在 NFS 上。PostgreSQL 数据、npm cache 必须放在 `/tmp`（本地 xfs）
- **/tmp 非持久化：** 机器重启后 `/tmp` 可能被清理。重建只需 `./scripts/setup.sh`（~30 秒）
- **端口冲突：** 共享机器上其他用户可能占用默认端口。`PG_PORT` 和 `PORT` 均通过环境变量配置

---

## 开发环境准备

### 前置条件

```bash
# 1. 激活 Node.js 18（必须！默认 Node 14 无法运行现代工具链）
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 18
# 验证：node --version → v18.20.8, npm --version → 10.8.2

# 2. 添加到 shell 配置（避免每次手动激活）
# 在 ~/.bashrc 或 ~/.zshrc 末尾添加：
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 18 > /dev/null 2>&1

# 3. 修复 npm cache（NFS 环境必须！否则 npm install 随机失败）
npm config set cache /tmp/npm-cache-$(whoami)
# setup.sh 会自动执行此步骤，但建议手动设一次以覆盖全局
```

### 一条命令初始化（首次）

```bash
cd /proj/gfx_gct_lec_user0/users/nanyang2/PlanSync
./scripts/setup.sh
```

`setup.sh` 自动完成所有初始化，无需手动操作。

### 一条命令启动（日常开发）

```bash
npm run dev
```

`npm run dev` 自动检查并启动 PostgreSQL、确认 migration 最新、然后启动 API 服务。

### 本地 PostgreSQL 数据库

当前公司环境自带 PostgreSQL 13.2（`/tool/pandora64/bin/`），可以直接在项目目录下启动本地实例，**数据完全在公司内网，零外泄风险**。

```bash
# scripts/setup.sh — 首次初始化，一条命令搞定所有事
#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PG_BIN=/tool/pandora64/bin
PG_PORT=${PG_PORT:-15432}
PG_DATA="/tmp/plansync-pgdata-$(whoami)"

cd "$PROJECT_DIR"

echo "========================================="
echo "  PlanSync 开发环境初始化"
echo "========================================="

# ① 检查并激活 Node 18
echo ""
echo "[1/7] 检查 Node.js 版本..."
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
NODE_MAJOR=$(node -v 2>/dev/null | cut -d. -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  echo "  当前 Node $(node -v)，切换到 Node 18..."
  nvm use 18
fi
echo "  ✓ Node $(node -v), npm $(npm -v)"

# ② 修复 npm cache 路径（NFS 不兼容 npm 缓存，必须移到本地磁盘）
echo ""
echo "[2/7] 修复 npm cache 路径..."
NPM_CACHE_DIR="/tmp/npm-cache-$(whoami)"
mkdir -p "$NPM_CACHE_DIR"
npm config set cache "$NPM_CACHE_DIR"
echo "cache=/tmp/npm-cache-\${USER}" > "$PROJECT_DIR/.npmrc"
echo "  ✓ npm cache 已设置为 $NPM_CACHE_DIR（避免 NFS 缓存损坏）"

# ③ 安装依赖
echo ""
echo "[3/7] 安装依赖（npm workspaces）..."
npm install --cache "$NPM_CACHE_DIR"
echo "  ✓ 依赖已安装"

# ④ 配置环境变量
echo ""
echo "[4/7] 配置环境变量..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  ✓ .env 已从模板创建（默认配置，通常不需要修改）"
else
  echo "  ✓ .env 已存在，跳过"
fi

# ⑤ 启动 PostgreSQL（本地磁盘，非 NFS）
echo ""
echo "[5/7] 启动 PostgreSQL..."
export PATH="$PG_BIN:$PATH"
if pg_isready -p "$PG_PORT" -q 2>/dev/null; then
  echo "  ✓ PostgreSQL 已在端口 $PG_PORT 运行"
else
  if [ ! -d "$PG_DATA" ]; then
    echo "  首次运行，初始化数据目录: $PG_DATA"
    initdb -D "$PG_DATA" > /dev/null 2>&1
  fi
  pg_ctl -D "$PG_DATA" -l "$PG_DATA/logfile" -o "-p $PG_PORT" start > /dev/null 2>&1
  echo "  ✓ PostgreSQL 已启动（端口 $PG_PORT）"
fi
# 确保数据库存在
createdb -p "$PG_PORT" plansync_dev 2>/dev/null || true
echo "  ✓ 数据库 plansync_dev 就绪"

# ⑥ 数据库 migration + seed
echo ""
echo "[6/7] 初始化数据库 schema..."
cd packages/api
npx prisma migrate deploy
npx prisma db seed 2>/dev/null || echo "  (seed 可选，跳过)"
cd "$PROJECT_DIR"
echo "  ✓ 数据库 schema 已就绪"

# ⑦ 完成
echo ""
echo "[7/7] 初始化 Git hooks..."
npx husky 2>/dev/null || true
echo "  ✓ Git hooks 已配置"

echo ""
echo "========================================="
echo "  ✓ 初始化完成！"
echo ""
echo "  启动开发：npm run dev"
echo "  停止数据库：npm run db:stop"
echo "  交互式 SQL：npm run db:psql"
echo "========================================="
```

```bash
# scripts/dev.sh — 智能启动开发环境
#!/bin/bash
set -e

PG_BIN=/tool/pandora64/bin
PG_PORT=${PG_PORT:-15432}
PG_DATA="/tmp/plansync-pgdata-$(whoami)"

# 检查 Node 版本
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
NODE_MAJOR=$(node -v 2>/dev/null | cut -d. -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  nvm use 18 > /dev/null 2>&1
fi

# 确保 npm cache 在本地磁盘（NFS 不兼容）
export npm_config_cache="/tmp/npm-cache-$(whoami)"

# 自动启动 PostgreSQL（如果没在运行）
export PATH="$PG_BIN:$PATH"
if ! pg_isready -p "$PG_PORT" -q 2>/dev/null; then
  if [ ! -d "$PG_DATA" ]; then
    echo "⚠ 数据库未初始化，请先运行: ./scripts/setup.sh"
    exit 1
  fi
  echo "启动 PostgreSQL..."
  pg_ctl -D "$PG_DATA" -l "$PG_DATA/logfile" -o "-p $PG_PORT" start > /dev/null 2>&1
fi

# 检查 migration 是否最新
cd packages/api
npx prisma migrate deploy
cd ../..

# 启动 Next.js dev server
exec npm run --workspace=@plansync/api dev
```

```bash
# scripts/pg-start.sh — 单独启动本地 PostgreSQL（不启动 API）
#!/bin/bash
set -e

PG_BIN=/tool/pandora64/bin
PG_PORT=${PG_PORT:-15432}
PG_DATA="/tmp/plansync-pgdata-$(whoami)"

export PATH="$PG_BIN:$PATH"

if pg_isready -p "$PG_PORT" -q 2>/dev/null; then
  echo "✓ PostgreSQL 已在端口 $PG_PORT 运行"
else
  if [ ! -d "$PG_DATA" ]; then
    echo "⚠ 数据库未初始化，请先运行: ./scripts/setup.sh"
    exit 1
  fi
  pg_ctl -D "$PG_DATA" -l "$PG_DATA/logfile" -o "-p $PG_PORT" start > /dev/null 2>&1
  echo "✓ PostgreSQL 已启动（端口 $PG_PORT）"
fi
```

```bash
# scripts/pg-stop.sh — 停止本地 PostgreSQL
#!/bin/bash
PG_BIN=/tool/pandora64/bin
PG_DATA="/tmp/plansync-pgdata-$(whoami)"
export PATH="$PG_BIN:$PATH"
if [ -d "$PG_DATA" ]; then
  pg_ctl -D "$PG_DATA" stop 2>/dev/null && echo "✓ PostgreSQL 已停止" || echo "PostgreSQL 未在运行"
else
  echo "未找到数据目录: $PG_DATA"
fi
```

```
npm scripts 配置（根 package.json）：
  "scripts": {
    "dev": "bash scripts/dev.sh",
    "setup": "bash scripts/setup.sh",
    "db:start": "bash scripts/pg-start.sh",
    "db:stop": "bash scripts/pg-stop.sh",
    "db:psql": "bash -c 'export PATH=/tool/pandora64/bin:$PATH && psql -p ${PG_PORT:-15432} plansync_dev'",
    "db:reset": "bash scripts/pg-stop.sh; rm -rf /tmp/plansync-pgdata-$(whoami) && npm run setup"
  }

连接信息：
  端口：15432（通过 PG_PORT 环境变量可配）
  数据库：plansync_dev
  认证：trust（本地连接免密码）
  DATABASE_URL=postgresql://localhost:15432/plansync_dev
  数据目录：/tmp/plansync-pgdata-$USER（本地 xfs 磁盘，非 NFS）

⚠ 重要说明：
  - 项目目录和 HOME 都是 NFS，PostgreSQL 数据必须在 /tmp（本地 xfs）
  - /tmp 重启后可能清理，重建只需 ./scripts/setup.sh（约 30 秒）
  - 每个开发者有独立的 DB（路径含 $USER），端口可配避免冲突
```

### 环境变量清单

```bash
# .env.example
# ─── 必填 ───
DATABASE_URL=postgresql://localhost:15432/plansync_dev   # 本地 PostgreSQL（数据在 /tmp，非 NFS）
PLANSYNC_SECRET=your-shared-secret-here                  # API 认证 Bearer token

# ─── 可选（有默认值）───
AUTH_DISABLED=false                        # true: 跳过认证（纯本地开发）
PORT=3000                                  # API 端口
LOG_LEVEL=info                             # debug | info | warn | error
NODE_ENV=development                       # development | test | production
PG_PORT=15432                              # 本地 PostgreSQL 端口

# ─── Phase 2 新增 ───
# NEXT_PUBLIC_API_URL=http://localhost:3000  # Web 前端 API 地址
# NEXT_PUBLIC_APP_URL=http://localhost:3000  # Dashboard 基础 URL（Slack 按钮跳转用）

# ─── Phase 4 新增 ───
# ANTHROPIC_API_KEY=sk-ant-xxx              # Claude API（语义 diff）
```

### 环境变量启动校验

```typescript
// packages/api/src/lib/env.ts — API 服务专用，启动时用 Zod 校验
// ⚠ 注意：此文件放在 @plansync/api 而非 @plansync/shared，
//   因为 DATABASE_URL/PG_PORT 等变量仅 API 服务需要。
//   如果放在 shared 并通过 index.ts 导出，MCP Server 导入 shared 时
//   会因缺少 DATABASE_URL 而崩溃。
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().startsWith('postgresql://'),
  PLANSYNC_SECRET: z.string().min(8),
  AUTH_DISABLED: z.enum(['true', 'false']).default('false'),
  PORT: z.string().default('3000'),
  PG_PORT: z.string().default('15432'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_PUBLIC_API_URL: z.string().url().optional(),
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
});

export const env = envSchema.parse(process.env);
// 缺少必要变量时，启动即报错并列出缺失项
```

---

## Phase 1 目录结构

```
plansync/
├── package.json                       # 根 package.json（npm workspaces 配置）
├── .nvmrc                             # node 版本锁定：18
├── .npmrc                             # ★ npm cache 路径（/tmp，避免 NFS 损坏）
├── .env.example                       # 环境变量模板
├── eslint.config.mjs                  # ESLint 根配置（ESLint 9 flat config 格式）
├── .prettierrc                        # Prettier 配置
├── .husky/                            # Git hooks
│   ├── pre-commit                     # lint-staged
│   └── commit-msg                     # commitlint
├── commitlint.config.js               # Conventional Commits 规范
├── PLAN.md
├── README.md
│
├── bin/
│   └── plansync                       # Bash wrapper 脚本
├── scripts/
│   ├── setup.sh                       # ★ 一键初始化（首次）
│   ├── dev.sh                         # ★ 智能启动开发环境（日常）
│   ├── pg-start.sh                    # 单独启动 PostgreSQL
│   └── pg-stop.sh                     # 停止本地 PostgreSQL
│
├── packages/
│   ├── shared/                        # ★ 共享类型 + 校验（MCP 和 API 共用）
│   │   ├── package.json               # @plansync/shared
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts               # 统一导出（⚠ 不含 env.ts，避免 MCP Server 导入崩溃）
│   │       ├── schemas/               # Zod schema 定义（PlanReview 含在 plan.ts，ExecutionRun 含在 task.ts，Activity 含在 common.ts）
│   │       │   ├── project.ts          # Project schema
│   │       │   ├── member.ts          # ★ ProjectMember schema
│   │       │   ├── plan.ts            # 含 PlanReview schema
│   │       │   ├── suggestion.ts      # ★ PlanSuggestion schema
│   │       │   ├── comment.ts         # ★ PlanComment schema
│   │       │   ├── task.ts            # 含 ExecutionRun schema
│   │       │   ├── drift.ts           # DriftAlert schema
│   │       │   └── common.ts          # 通用类型（分页、错误格式、Activity schema）
│   │       ├── types/                 # 从 Zod schema 推导的 TS 类型
│   │       │   └── index.ts           # z.infer 导出
│   │       └── errors.ts             # AppError 类 + 错误码枚举
│   │
│   ├── mcp-server/                    # MCP Server
│   │   ├── package.json               # @plansync/mcp-server
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts               # MCP Server 入口
│   │       ├── tools/
│   │       │   ├── project.ts
│   │       │   ├── member.ts          # ★ 成员管理 tools
│   │       │   ├── plan.ts            # 含 suggest + update
│   │       │   ├── suggestion.ts      # ★ accept/reject tools
│   │       │   ├── comment.ts        # ★ Plan 评论 tools
│   │       │   ├── task.ts
│   │       │   ├── execution.ts
│   │       │   ├── drift.ts
│   │       │   └── status.ts
│   │       ├── api-client.ts          # HTTP client → PlanSync API
│   │       ├── config.ts              # 配置读取
│   │       └── logger.ts              # MCP SDK logging wrapper
│   │
│   └── api/                           # Next.js API + Web
│       ├── package.json               # @plansync/api
│       ├── tsconfig.json
│       ├── next.config.js
│       ├── vitest.config.ts
│       ├── prisma/
│       │   ├── schema.prisma
│       │   └── seed.ts
│       ├── src/
│       │   ├── app/api/               # API Routes
│       │   │   ├── projects/...       # 含 members/, plans/suggestions/, plans/comments/
│       │   │   ├── plan-suggestions/...  # ★ accept/reject
│       │   │   ├── plan-comments/...     # ★ PATCH/DELETE 评论
│       │   │   ├── runs/...
│       │   │   ├── drift-alerts/...
│       │   │   ├── plan-reviews/...
│       │   │   └── health/route.ts    # Health Check 端点
│       │   ├── lib/
│       │   │   ├── env.ts             # ★ 环境变量 Zod 校验（API 专用，不放 shared）
│       │   │   ├── prisma.ts          # Prisma client 单例
│       │   │   ├── auth.ts            # Bearer token + 角色权限中间件
│       │   │   ├── errors.ts          # API 错误处理 + 统一格式
│       │   │   ├── logger.ts          # pino 日志实例
│       │   │   ├── validate.ts        # Zod 校验 helper（从 @plansync/shared 导入 schema）
│       │   │   ├── drift-engine.ts    # ★ 核心
│       │   │   ├── task-pack.ts
│       │   │   └── activity.ts
│       │   └── middleware.ts          # Next.js middleware（认证 + CORS）
│       └── tests/
│           ├── unit/
│           │   ├── drift-engine.test.ts
│           │   └── plan-state.test.ts
│           └── integration/
│               └── workflow.test.ts
│
└── claude-md/
    └── plansync-instructions.md
```

### npm workspaces 配置

```jsonc
// 根 package.json
{
  "name": "plansync",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "setup": "bash scripts/setup.sh",
    "dev": "bash scripts/dev.sh",
    "build": "npm run build --workspaces",
    "test": "npm run test --workspaces --if-present",
    "lint": "eslint packages/*/src",
    "format": "prettier --write 'packages/*/src/**/*.{ts,tsx}'",
    "db:start": "bash scripts/pg-start.sh",
    "db:stop": "bash scripts/pg-stop.sh",
    "db:reset": "bash scripts/pg-stop.sh; rm -rf /tmp/plansync-pgdata-$(whoami) && npm run setup",
    "db:psql": "bash -c 'export PATH=/tool/pandora64/bin:$PATH && psql -p ${PG_PORT:-15432} plansync_dev'",
    "prepare": "husky"
  },
  "devDependencies": {
    "eslint": "~9.17.0",
    "prettier": "~3.4.2",
    "husky": "~9.1.7",
    "@commitlint/cli": "~19.6.1",
    "@commitlint/config-conventional": "~19.6.0",
    "lint-staged": "~15.4.3",
    "typescript": "~5.7.3"
  },
  "lint-staged": {
    "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
    "*.{json,md}": ["prettier --write"]
  }
}
```

### 包间依赖与版本锁定

> **⚠ 关键约束（来自环境验证）：** 当前环境为 Node 18.20.8。以下版本已在此环境下全部验证通过。**严禁使用 `^` 范围**（会拉到不兼容的最新版），统一使用 `~` 锁定 minor 版本。

```
@plansync/shared ← 被其他两个包引用（仅依赖 zod，纯类型+校验）
@plansync/api ← 依赖 @plansync/shared
@plansync/mcp-server ← 依赖 @plansync/shared
```

```jsonc
// packages/shared/package.json
{
  "name": "@plansync/shared",
  "version": "0.1.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "zod": "~3.23.8"
  },
  "devDependencies": {
    "typescript": "~5.7.3"
  }
}
```

```jsonc
// packages/api/package.json
{
  "name": "@plansync/api",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run"
  },
  "dependencies": {
    "@plansync/shared": "*",
    "next": "~14.2.28",
    "react": "~18.3.1",
    "react-dom": "~18.3.1",
    "@prisma/client": "~6.4.1",
    "pino": "~9.6.0",
    "pino-pretty": "~13.0.0",
    "zod": "~3.23.8"
  },
  "devDependencies": {
    "prisma": "~6.4.1",
    "typescript": "~5.7.3",
    "vitest": "~3.0.9",
    "@types/node": "~20.17.19",
    "@types/react": "~18.3.18"
  }
}
```

```jsonc
// packages/mcp-server/package.json
{
  "name": "@plansync/mcp-server",
  "version": "0.1.0",
  "private": true,
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run"
  },
  "dependencies": {
    "@plansync/shared": "*",
    "@modelcontextprotocol/sdk": "~1.28.0",
    "zod": "~3.23.8"
  },
  "devDependencies": {
    "typescript": "~5.7.3",
    "vitest": "~3.0.9",
    "@types/node": "~20.17.19"
  }
}
```

**版本选择依据（Node 18.20.8 兼容性验证）：**

| 包 | 锁定版本 | 不能用的版本 | 原因 |
|---|---|---|---|
| prisma / @prisma/client | ~6.4.1 | 7.x | Prisma 7 要求 Node >= 20 |
| zod | ~3.23.8 | 4.x | Zod 4 API 大改（`.parse()` 行为变化），本文档所有代码示例基于 v3 |
| typescript | ~5.7.3 | 6.x | TS 6 太新，Next.js 14 未验证兼容性 |
| pino | ~9.6.0 | 10.x | Pino 10 依赖 thread-stream@4 要求 Node >= 20 |
| next | ~14.2.28 | 15.x | 架构选型为 Next.js 14 App Router |
| @modelcontextprotocol/sdk | ~1.28.0 | — | 已验证 engines: node>=18 |

---

## Phase 1 开发计划（2 周）

### 第 1 周：核心 API + MCP 基础

| 天 | 任务 | 验收 |
|----|------|------|
| **1** | API 项目初始化 + Prisma schema 10 表 + migration + seed 数据 | DB 跑通，seed 数据可查 |
| **2** | Project CRUD API + Plan CRUD API + 单 active 约束 | curl 测试 project/plan 增删改查 |
| **3** | PlanReview API + Task CRUD API（含自动版本绑定）+ ★ ProjectMember CRUD API | curl 测试审批流 + 任务创建绑定 active plan + 成员增删改查 |
| **4 ★** | **drift-engine.ts** + Plan activate API + DriftAlert API | **v1→tasks→v2 activate→drift→resolve 闭环（API 层）** |
| **5** | ★ PlanSuggestion API + PlanComment API + MCP Server 初始化 + api-client + config | curl 测试建议提交/采纳 + 评论发布/回复；MCP Server 连接 API |

### 第 2 周：MCP 完善 + Wrapper + 端到端

| 天 | 任务 | 验收 |
|----|------|------|
| **6** | MCP project/plan/member/suggestion/comment tools + task/drift/execution/review tools | AI 对话中完整 drift 闭环 + 建议/评论/成员管理 |
| **7** | Task Pack API + ExecutionRun API + MCP start/complete | 开始任务 → Plan 上下文注入 → 完成回传 |
| **8** | status/who/log 聚合 API + MCP status tools | "大家进度怎么样？" → 完整状态 |
| **9** | Wrapper 脚本 + CLAUDE.md 注入 + 心跳机制 | `plansync` 一键启动，心跳正常 |
| **10** | Drift Engine 单元测试 + 核心 API 集成测试 | 测试覆盖核心路径 |
| **11-12** | Demo seed 数据 + 端到端演练 + Bug 修复 + 边界场景 | 5 分钟 demo 流畅 |
| **13-14** | 文档 + 打磨 + buffer | 7 条验收标准全部通过 |

**Day 4 是生死线** — Drift Engine API 层跑通，后面都是 MCP 层接入和完善。

### Phase 1 验收标准（7 条）

| # | 验收项 | 怎么验证 |
|---|--------|---------|
| 1 | AI 对话创建 Plan 并激活 | 在 plansync 里说 "创建方案" → plan 出现在 DB |
| 2 | 创建 Task 自动绑定 active plan | 说 "创建任务" → task.boundPlanVersion = active |
| 3 | 激活新 Plan → 自动生成 Drift | 说 "激活 v2" → drift alerts 生成 |
| 4 | 解决 drift alert | 说 "rebind" → alert resolved |
| 5 | start_task → 注入上下文 → complete | 说 "开始做" → Plan 上下文注入 → 写代码 → 结果回传 |
| 6 | 查看执行人状态 | 说 "谁在做什么" → 返回活跃执行人 |
| 7 | 查看项目全貌 | 说 "项目状态" → 返回完整 dashboard |

---

# Phase 2：Agent 协调 + Web Dashboard（Day 15-28）

> 目标：实现核心差异化（Agent 实时通知）+ 让产品可视化。

## 2A：Agent 实时协调（★ 核心差异化）

### 架构

```
┌─ MCP Server (Alice) ─────────────────────┐
│                                           │
│  工具层（38 个 MCP Tools）                │
│                    │                      │
│  ┌─ Event Listener ──────────────────┐   │
│  │  SSE 连接: /api/projects/:id/events│   │
│  │                                    │   │
│  │  收到 plan_activated 事件:         │   │
│  │    1. 检查是否有 running task      │   │
│  │    2. 比较 boundVersion vs new     │   │
│  │    3. 发 MCP notification → AI     │   │
│  └────────────────────────────────────┘   │
└───────────────────────────────────────────┘

API 端新增：
  GET /api/projects/:id/events    SSE 长连接
  事件类型（13 种，完整定义见「Phase 2 新增 API」章节）
```

### Agent 通知行为

Agent 收到通知后的具体行为见上方"问题 1：Agent 打断机制"中的方案描述和三级降级策略。

### Alert 疲劳防控

```
告警策略（可配置）：
  HIGH drift（有 running agent）:
    → 主动通知 agent（MCP notification）
    → 推送 Slack/Webhook（Phase 3）
  MEDIUM drift（task 还没开始）:
    → 不主动打断，下次 plansync_status 时展示
  LOW drift（task 已完成）:
    → 仅记录，不通知

配置项 (~/.plansync/config.json):
  "notifications": {
    "pushOnHigh": true,      // HIGH drift 主动通知
    "pushOnMedium": false,   // MEDIUM 不主动通知
    "silentMode": false       // 全部静默（密集迭代时用）
  }
```

---

## 2B：Web Dashboard

### 为什么放在 Phase 2

- CLI 只覆盖开发者，PM/Lead 不一定用终端
- 给评委/投资人看 Web 比看终端更有说服力
- 与 Agent 协调共享 SSE 基础设施

### 页面设计

#### 页面 1：项目 Dashboard（首页）

```
┌─────────────────────────────────────────────────────────┐
│  PlanSync                          [AuthSystem ▼] alice │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌─ Active Plan ──────────────────────────────────────┐  │
│  │ v2: OAuth 2.0 + NextAuth.js             ● ACTIVE  │  │
│  │ Goal: 实现用户认证系统                              │  │
│  │ Activated by TeamLead · 10:30 today                │  │
│  │ [View Details]  [Create New Version]               │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌─ Drift Alerts ─────────────────────────────────────┐  │
│  │ ⚠ 1 open alert                                     │  │
│  │ 🔴 HIGH  TASK-127 Token存储 · Agent-2 · bound v1  │  │
│  │          [Rebind v2]  [Cancel]  [No Impact]        │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌─ Team ─────────────────────────────────────────────┐  │
│  │ ┌──────────┬──────────┬──────────┬──────────┐      │  │
│  │ │ TeamLead │ Alice    │ Agent-2  │ Bob      │      │  │
│  │ │ 👑 owner │ developer│ 🤖 agent │ developer│      │  │
│  │ │ 🟢 active│ 🟢 done  │ 🔴 drift │ 🟡 idle  │      │  │
│  │ │ TASK-129 │ TASK-123 │ TASK-127 │   —      │      │  │
│  │ └──────────┴──────────┴──────────┴──────────┘      │  │
│  │ [Manage Members]                      ← owner 可见  │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌─ Tasks ────────────────────────────────────────────┐  │
│  │ [All ▼] [Status ▼] [Assignee ▼]                    │  │
│  │ ✅ TASK-123  登录 API         Alice     done   v1  │  │
│  │ 🔄 TASK-127  Token 存储      Agent-2   wip    v1⚠ │  │
│  │ 📋 TASK-124  刷新逻辑        Bob       todo   v2  │  │
│  │ 🔄 TASK-130  登录页 UI       NewPerson wip    v2  │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌─ Activity ─────────────────────────────────────────┐  │
│  │ 10:35  NewPerson claimed TASK-130                  │  │
│  │ 10:31  ⚠ Drift: TASK-127 version mismatch         │  │
│  │ 10:30  TeamLead activated Plan v2                  │  │
│  │ [Load more...]                                     │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

#### 页面 2：Plan 详情 + 版本时间线 + ★ Suggestion 面板

```
┌─────────────────────────────────────────────────────────┐
│  Plan History                                            │
│                                                          │
│  ──●──────────●──────────●───                            │
│    v1 (JWT)   v2 (OAuth)  v3?                            │
│    superseded  active                                    │
│                                                          │
│  ┌─ v2 详情 ──────────────────────────────────────────┐  │
│  │ Goal / Scope / Constraints / Standards             │  │
│  │ Change from v1: JWT → OAuth 2.0                    │  │
│  │ Why: 减少自建认证的安全风险                         │  │
│  │ Reviews: ✅ Alice  ✅ Bob                            │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌─ ★ Suggestions (仅 draft/proposed 状态显示) ───────┐  │
│  │ 3 pending · 2 accepted · 1 rejected                │  │
│  │                                                     │  │
│  │ 💡 #1 Alice · constraints · append                 │  │
│  │    "使用 httpOnly cookie 存储 token"                │  │
│  │    原因: 防止 XSS 攻击窃取 token                    │  │
│  │    [Accept] [Reject]                    ← owner 可见│  │
│  │                                                     │  │
│  │ 💡 #2 Agent-1 · constraints · set                  │  │
│  │    "使用 argon2 替代 bcrypt"                        │  │
│  │    原因: bcrypt 的 node-gyp 在 NFS 上编译失败       │  │
│  │    [Accept] [Reject]                                │  │
│  │                                                     │  │
│  │ ⚠ #3 Bob · scope · set              status:conflict│  │
│  │    "加入 refresh token 逻辑"                        │  │
│  │    与已采纳的 #4 冲突 [Re-evaluate]                 │  │
│  │                                                     │  │
│  │ ✅ #4 Alice · scope · set            accepted       │  │
│  │    "scope 扩展为包含 token 刷新"                     │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌─ ★ Discussion ────────────────────────────────────────┐  │
│  │ 5 comments                                            │  │
│  │                                                       │  │
│  │ 💬 TeamLead · 2h ago                                  │  │
│  │    JWT 还是 session-based？大家怎么看                  │  │
│  │    ├─ Alice · 1h ago                                  │  │
│  │    │  建议 JWT，我们的前端是 SPA，适合无状态            │  │
│  │    └─ Agent-1 · 45m ago                               │  │
│  │       同意 Alice。另外 argon2 的 WASM 版不需要         │  │
│  │       node-gyp 编译，适合 NFS 环境                     │  │
│  │                                                       │  │
│  │ 💬 Bob · 30m ago                                      │  │
│  │    refresh token 的有效期设多少合适？                   │  │
│  │                                                       │  │
│  │ [Write a comment...]                                  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                          │
│  [Compare v1 ↔ v2]   ← Phase 4 加语义 diff              │
│  [Edit Draft]         ← owner 可直接编辑 draft           │
└─────────────────────────────────────────────────────────┘
```

#### 页面 3：Task 详情

```
┌─────────────────────────────────────────────────────────┐
│  TASK-127: Token 存储                                    │
│  Status: 🔄 in_progress  Priority: P1  Assignee: Agent-2│
│  Bound Plan: v1 ⚠ (active is v2)                        │
│                                                          │
│  Drift Alert:                                            │
│  🔴 HIGH: Agent-2 正在按旧方案执行                       │
│  [Rebind to v2]  [Cancel Task]  [Mark No Impact]        │
│                                                          │
│  Execution History:                                      │
│  Run #1  Agent-2  running  started 10:10                 │
│  Last heartbeat: 10:32 (2min ago)                        │
└─────────────────────────────────────────────────────────┘
```

### Phase 2 技术栈补充

| 层 | 选择 | 理由 |
|---|------|------|
| 前端 | Next.js App Router（同 API 项目） | 前后端同仓 |
| UI | Tailwind CSS + shadcn/ui | 快速搭建，质量高 |
| 实时 | SSE（与 Agent 协调共用） | 轻量，浏览器原生支持 |

### SSE 部署方案（重要）

**问题：** Vercel Serverless Functions 默认 10s 超时（Pro 最大 300s），不支持 SSE 长连接。

```
方案选择（按优先级）：

方案 A（推荐，公司内部部署）：自建长连接服务
  - Next.js API + SSE 统一部署到公司内部服务器（持久进程）
  - SSE 使用 PostgreSQL LISTEN/NOTIFY 监听数据变更
  - 优点：完全控制，数据不出内网，标准 SSE
  - 适用：公司内部有可部署的 Linux 服务器

方案 B：拆分部署
  - 普通 API 部署到 Vercel 或内部服务器
  - SSE 服务单独部署（需要支持长连接的环境）
  - 优点：普通请求享受 Serverless 弹性
  - 缺点：多一个服务要维护

方案 C：Vercel Edge Runtime
  - 使用 Vercel Edge Runtime 处理 SSE（有限制但可行）
  - 缺点：Edge Runtime 限制较多，不推荐复杂场景

Phase 1（纯本地）：直接用 Next.js dev server 的 SSE，无问题
Phase 2 部署时：优先方案 A（公司内部服务器），不可用时选方案 B
```

### Phase 2 新增 API

```
# SSE 实时事件流（Agent 协调 + Web 共用）
GET  /api/projects/:id/events          Server-Sent Events
  事件类型（13 种，与 Webhook 事件对齐）：
    - plan_activated { planId, version, activatedBy }
    - plan_draft_updated { planId, updatedBy, fields }  ← ★ Draft 编辑
    - drift_detected { alertId, taskId, severity }
    - drift_resolved { alertId, action }
    - task_created { taskId, title, assignee, boundPlanVersion }
    - task_assigned { taskId, assignee }
    - task_started { taskId, executorName, executorType }
    - task_completed { taskId, summary, filesChanged[] }
    - execution_stale { runId, taskId, executorName }
    - suggestion_created { suggestionId, suggestedBy }  ← ★ 新建议
    - suggestion_resolved { suggestionId, status }      ← ★ 建议处理
    - comment_added { commentId, planId, authorName }   ← ★ 新评论
    - member_added { name, role }                       ← ★ 新成员

# Web 专用聚合
GET  /api/projects/:id/dashboard       一次拉取全部 dashboard 数据（含 suggestions 摘要）
```

### Phase 2 新增目录

```
packages/api/src/
├── app/
│   ├── page.tsx                       # 项目列表
│   ├── layout.tsx
│   ├── globals.css
│   └── projects/[id]/
│       ├── page.tsx                   # Dashboard
│       ├── plans/page.tsx             # Plan 时间线 + Suggestion 面板
│       ├── members/page.tsx           # ★ 成员管理页
│       └── tasks/[taskId]/page.tsx    # Task 详情
├── components/
│   ├── dashboard/
│   │   ├── plan-card.tsx
│   │   ├── drift-alert-card.tsx
│   │   ├── team-grid.tsx              # 含角色标识（owner/developer/agent）
│   │   ├── task-list.tsx
│   │   └── activity-feed.tsx
│   ├── plan/
│   │   ├── plan-detail.tsx
│   │   ├── plan-timeline.tsx
│   │   ├── plan-edit-form.tsx         # ★ Draft 编辑表单（owner 可见）
│   │   ├── suggestion-panel.tsx       # ★ Suggestion 列表 + accept/reject
│   │   └── comment-thread.tsx         # ★ Plan 讨论区（评论 + 回复）
│   ├── member/
│   │   ├── member-list.tsx            # ★ 成员列表 + 角色标识
│   │   └── member-invite.tsx          # ★ 添加成员表单
│   └── task/
│       ├── task-detail.tsx
│       └── execution-history.tsx
└── lib/hooks/
    ├── use-project.ts
    ├── use-realtime.ts                # SSE 实时更新 hook
    ├── use-drift-alerts.ts
    ├── use-suggestions.ts             # ★ Suggestion 实时更新 hook
    └── use-comments.ts                # ★ Comment 实时更新 hook

packages/mcp-server/src/
└── event-listener.ts                  # ★ SSE 监听 + MCP notification
```

---

## Phase 2 开发计划（2 周）

### 第 3 周：Agent 协调 + Web 基础

| 天 | 任务 | 验收 |
|----|------|------|
| **15** | MCP notification PoC（在目标宿主上验证可行性）| 确认理想方案 or 确认降级方案 |
| **16** | SSE/Realtime 事件流 API + MCP Server Event Listener | Agent 收到 plan change 通知（降级方案兜底） |
| **17** | 告警策略（HIGH 推送 / MEDIUM 静默）+ 通知配置 | 只有 HIGH drift 打断 agent |
| **18** | Web: Tailwind + shadcn + layout + 项目列表页 | 浏览器看到项目列表 |
| **19** | Web: Dashboard 页面（Plan Card + Team Grid + Task List） | 浏览器看到项目状态 |

### 第 4 周：Web 完善 + 三端联动

| 天 | 任务 | 验收 |
|----|------|------|
| **20** | Web: Drift Alert 操作 + Activity Feed | Web 上处理 drift |
| **21** | Web: Plan 时间线 + Task 详情 + Execution History | 完整页面 |
| **22** | Web: SSE 实时更新 + 响应式 | 页面自动刷新 |
| **23-24** | 端到端演练：CLI 改方案 → Agent 收到通知 → Web 实时反映 | 三端联动 |
| **25-28** | Bug 修复 + UI 打磨 + buffer | 5 条验收标准全部通过 |

### Phase 2 验收标准（5 条）

| # | 验收项 | 怎么验证 |
|---|--------|---------|
| 8 | **Agent 实时收到方案变更通知** | activate v2 → 正在执行 v1 任务的 agent 收到暂停提醒 |
| 9 | 项目 Dashboard 显示完整状态 | 浏览器 → plan + tasks + team + drift |
| 10 | Drift Alert 可在 Web 上操作 | 点击 Rebind → resolved → 页面更新 |
| 11 | Plan 版本时间线可视化 | v1 → v2 → v3 的演变线 |
| 12 | 三端实时同步 | CLI 操作 → Agent 通知 + Web 更新（1-3 秒内） |

---

# Phase 3：开放 API + 生态集成（Day 29-38）

> 目标：融入现有工具链，建立生态壁垒。切换成本越高，产品越难被替代。

## 为什么这比智能层更重要

智能层是「别人 2 小时能抄的 LLM 调用」。
生态集成是「需要时间积累的用户依赖」。

如果 PlanSync 的 drift alert 出现在 GitHub PR 上、Slack 频道里、CI/CD pipeline 里——用户要替换 PlanSync 就得同时拆掉所有集成点。这才是壁垒。

## 3A：开放 API（API Key 认证）

### 为什么 API 应该是一等公民

Phase 1 的 API 只是「MCP Server 的后端」。Phase 3 要让它成为**任何人都能调用的开放平台**。

```
API Key 认证：
  POST /api/auth/api-keys              创建 API Key
  DELETE /api/auth/api-keys/:keyId     删除

  使用方式：
  Authorization: Bearer ps_key_xxxxxxxxxxxx

  或保持 X-User-Name header（向后兼容）
```

### API 文档

自动生成 OpenAPI/Swagger 文档，让第三方开发者能自助集成。

```
GET /api/docs                          Swagger UI
GET /api/openapi.json                  OpenAPI spec
```

## 3B：Webhook 系统

### API 端点

```
POST   /api/projects/:id/webhooks        注册 webhook（owner 权限）
GET    /api/projects/:id/webhooks        列出（owner 权限）
DELETE /api/webhooks/:webhookId           删除（owner 权限）
GET    /api/webhooks/:webhookId/deliveries  投递日志（最近 50 条）
POST   /api/webhooks/:webhookId/test     手动触发测试投递
```

### 配置流程

```
方式 1：通过 API 注册
  curl -X POST /api/projects/auth-system/webhooks \
    -H "Authorization: Bearer ps_key_xxx" \
    -H "X-User-Name: TeamLead" \
    -d '{
      "url": "https://hooks.slack.com/services/T.../B.../xxx",
      "events": ["plan_activated", "drift_detected", "drift_resolved"],
      "secret": "my-hmac-secret"
    }'

方式 2：通过 Web Dashboard
  项目设置页 → Webhooks → Add Webhook
  填入 URL、选择事件、可选填 secret → Save
```

### Webhook Payload 格式

```json
{
  "id": "delivery_cuid_xxx",
  "event": "plan_activated",
  "projectId": "auth-system",
  "projectName": "AuthSystem",
  "data": {
    "planId": "plan_xxx",
    "version": 2,
    "title": "OAuth 2.0 + NextAuth.js",
    "activatedBy": "TeamLead"
  },
  "timestamp": "2026-03-26T10:30:00.000Z"
}
```

### 支持的事件

| 事件 | 触发时机 | data 字段 |
|------|---------|----------|
| `plan_activated` | Plan 激活 | planId, version, title, activatedBy |
| `plan_draft_updated` | Draft 编辑 | planId, updatedBy, fields[] |
| `drift_detected` | Drift 扫描产生告警 | alerts[]: {taskId, severity, reason} |
| `drift_resolved` | Drift 告警被解决 | alertId, action, resolvedBy |
| `task_created` | Task 创建 | taskId, title, assignee, boundPlanVersion |
| `task_assigned` | Task 分配/领取 | taskId, assignee |
| `task_started` | Task 开始执行 | taskId, executorName, executorType |
| `task_completed` | Task 完成 | taskId, summary, filesChanged[] |
| `execution_stale` | 执行心跳超时 | runId, taskId, executorName, lastHeartbeatAt |
| `suggestion_created` | 新 Plan 建议 | suggestionId, suggestedBy, field, value |
| `suggestion_resolved` | 建议被处理 | suggestionId, status: accepted\|rejected, resolvedBy |
| `comment_added` | Plan 新评论 | commentId, planId, authorName, content（截取前 100 字） |
| `member_added` | 新成员加入 | name, role, type |

### 投递机制

```typescript
// packages/api/src/lib/webhook.ts

import crypto from 'crypto';
import { prisma } from './prisma';
import { logger } from './logger';

interface WebhookPayload {
  event: string;
  projectId: string;
  projectName: string;
  data: unknown;
  timestamp: string;
}

/**
 * 查找订阅了指定事件的 Webhook 并异步投递。
 * 在业务事务提交后调用，不阻塞主请求。
 */
export async function dispatchWebhooks(
  projectId: string,
  event: string,
  data: unknown
): Promise<void> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  const webhooks = await prisma.webhook.findMany({
    where: { projectId, active: true, events: { has: event } }
  });

  if (webhooks.length === 0) return;

  const payload: WebhookPayload = {
    event,
    projectId,
    projectName: project?.name ?? projectId,
    data,
    timestamp: new Date().toISOString(),
  };

  // 异步投递，不 await——不阻塞调用方
  for (const webhook of webhooks) {
    deliverWithRetry(webhook.id, webhook.url, webhook.secret, payload)
      .catch(err => logger.error({ err, webhookId: webhook.id }, 'Webhook delivery failed'));
  }
}

/**
 * 带重试的投递：失败后按 1s → 5s → 30s 间隔重试，共 3 次。
 * 每次投递结果写入 WebhookDelivery 表供 Dashboard 查看。
 */
async function deliverWithRetry(
  webhookId: string,
  url: string,
  secret: string | null,
  payload: WebhookPayload,
): Promise<void> {
  const retryDelays = [0, 1000, 5000, 30000]; // 首次立即 + 3 次重试
  const body = JSON.stringify(payload);

  for (let attempt = 0; attempt < retryDelays.length; attempt++) {
    if (attempt > 0) {
      await sleep(retryDelays[attempt]);
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'PlanSync-Webhook/1.0',
      'X-PlanSync-Event': payload.event,
      'X-PlanSync-Delivery': crypto.randomUUID(),
    };

    // HMAC-SHA256 签名（如果配置了 secret）
    if (secret) {
      const signature = crypto
        .createHmac('sha256', secret)
        .update(body)
        .digest('hex');
      headers['X-PlanSync-Signature'] = `sha256=${signature}`;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000), // 10s 超时
      });

      await prisma.webhookDelivery.create({
        data: {
          webhookId,
          event: payload.event,
          requestBody: payload as any,
          responseCode: response.status,
          success: response.ok,
          attempt: attempt + 1,
        }
      });

      if (response.ok) return; // 成功，结束
      if (response.status >= 400 && response.status < 500) return; // 4xx 不重试

    } catch (err) {
      await prisma.webhookDelivery.create({
        data: {
          webhookId,
          event: payload.event,
          requestBody: payload as any,
          responseCode: 0,
          success: false,
          errorMessage: (err as Error).message,
          attempt: attempt + 1,
        }
      });
    }
  }

  // 3 次重试全部失败 → 记录日志
  logger.warn({ webhookId, url, event: payload.event }, 'Webhook delivery exhausted all retries');
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### 安全签名验证

接收方验证 Webhook 真实性的方法（写入文档供第三方集成参考）：

```typescript
// 接收方验证示例（Node.js）
import crypto from 'crypto';

function verifyWebhookSignature(
  body: string,        // 原始请求 body
  signature: string,   // X-PlanSync-Signature header 的值
  secret: string       // 注册 Webhook 时设置的 secret
): boolean {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}
```

### 投递日志数据模型

```typescript
// WebhookDelivery（投递记录，供 Dashboard 查看历史）
{
  id: string,
  webhookId: string,       // FK → Webhook
  event: string,
  requestBody: JSON,
  responseCode: number,    // HTTP 状态码，0 表示网络错误
  success: boolean,
  errorMessage?: string,
  attempt: number,         // 第几次尝试（1-4）
  createdAt: DateTime
}
```

### 在业务代码中的调用位置

```
Plan activate 事务完成后：
  → dispatchWebhooks(projectId, 'plan_activated', { planId, version, ... })
  → dispatchWebhooks(projectId, 'drift_detected', { alerts: [...] })  // 如果有 drift

Plan draft 编辑（PATCH）后：
  → dispatchWebhooks(projectId, 'plan_draft_updated', { planId, updatedBy, fields })

Task 创建后：
  → dispatchWebhooks(projectId, 'task_created', { taskId, title, ... })

Task 分配/领取后：
  → dispatchWebhooks(projectId, 'task_assigned', { taskId, assignee })

Task start/complete 后：
  → dispatchWebhooks(projectId, 'task_started', ...)
  → dispatchWebhooks(projectId, 'task_completed', ...)

心跳超时标记 stale 时：
  → dispatchWebhooks(projectId, 'execution_stale', ...)

Drift 告警被解决后：
  → dispatchWebhooks(projectId, 'drift_resolved', { alertId, action, ... })

Suggestion 创建后：
  → dispatchWebhooks(projectId, 'suggestion_created', ...)

Suggestion 被处理（accept/reject）后：
  → dispatchWebhooks(projectId, 'suggestion_resolved', { suggestionId, status, ... })

Comment 创建后：
  → dispatchWebhooks(projectId, 'comment_added', { commentId, planId, authorName, ... })

成员添加后：
  → dispatchWebhooks(projectId, 'member_added', { name, role, ... })
```

---

## 3C：GitHub 集成

### PR Drift Check（GitHub Action）

```yaml
# .github/workflows/plansync-check.yml
name: PlanSync Drift Check
on: [pull_request]

jobs:
  drift-check:
    runs-on: ubuntu-latest
    steps:
      - uses: plansync/drift-check-action@v1
        with:
          api-url: ${{ secrets.PLANSYNC_API_URL }}
          api-key: ${{ secrets.PLANSYNC_API_KEY }}
          project: auth-system
```

效果：PR 上自动添加 check：
```
✅ PlanSync: Task TASK-130 bound to active Plan v2
❌ PlanSync: Task TASK-127 bound to Plan v1 (active is v2) — drift detected!
```

### PR Comment

```
🔍 PlanSync Drift Report

This PR is based on Plan v1 (JWT), but the active plan is v2 (OAuth 2.0).
Changes in v2:
  - 认证方式: JWT → OAuth 2.0
  - 框架: 自建 → NextAuth.js

⚠ This code may need to be updated to match the current plan.
```

## 3D：Slack 集成

Slack 通知本质上是 Webhook 系统的一个应用场景——接收方 URL 是 Slack 的 Incoming Webhook 地址。PlanSync 不需要 Slack SDK，只需要按 Slack 格式发送 HTTP POST。

### 配置步骤（一次性）

```
步骤 1：在 Slack 创建 Incoming Webhook
  1. 打开 https://api.slack.com/apps → Create New App → From scratch
  2. 选择目标 Workspace
  3. 左侧菜单 → Incoming Webhooks → Activate
  4. Add New Webhook to Workspace → 选择频道（如 #plansync-alerts）
  5. 复制生成的 URL：https://hooks.slack.com/services/T.../B.../xxx

步骤 2：在 PlanSync 注册 Webhook
  # 方式 A：API
  curl -X POST /api/projects/auth-system/webhooks \
    -H "Authorization: Bearer ps_key_xxx" \
    -H "X-User-Name: TeamLead" \
    -d '{
      "url": "https://hooks.slack.com/services/T.../B.../xxx",
      "events": ["plan_activated", "drift_detected", "drift_resolved",
                 "task_completed", "execution_stale"],
      "secret": null
    }'
  # Slack Incoming Webhook 不需要签名验证，secret 可留空

  # 方式 B：Web Dashboard
  项目设置 → Webhooks → Add Webhook → 粘贴 Slack URL → 选择事件 → Save

步骤 3：测试
  curl -X POST /api/webhooks/:webhookId/test
  → Slack 频道应收到一条测试消息
```

### 消息格式化（Slack Block Kit）

PlanSync 根据事件类型格式化不同的 Slack 消息。使用 Slack Block Kit 而非纯文本，支持结构化排版和操作按钮。

```typescript
// packages/api/src/lib/slack-formatter.ts

const DASHBOARD_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

/**
 * 将 PlanSync Webhook payload 转换为 Slack Block Kit 格式。
 * 如果 Webhook URL 是 Slack（hooks.slack.com），自动使用此格式化；
 * 否则发送原始 JSON payload。
 */
export function formatSlackMessage(event: string, projectName: string, data: any): object {
  switch (event) {
    case 'plan_activated':
      return formatPlanActivated(projectName, data);
    case 'drift_detected':
      return formatDriftDetected(projectName, data);
    case 'task_completed':
      return formatTaskCompleted(projectName, data);
    default:
      return formatGeneric(event, projectName, data);
  }
}

function isSlackUrl(url: string): boolean {
  return url.includes('hooks.slack.com');
}
```

### 各事件的 Slack 消息模板

**plan_activated — Plan 激活通知**

```json
{
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "🔔 Plan Activated" }
    },
    {
      "type": "section",
      "fields": [
        { "type": "mrkdwn", "text": "*Project:*\nAuthSystem" },
        { "type": "mrkdwn", "text": "*Version:*\nv2" },
        { "type": "mrkdwn", "text": "*Title:*\nOAuth 2.0 + NextAuth.js" },
        { "type": "mrkdwn", "text": "*Activated by:*\nTeamLead" }
      ]
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "View in Dashboard" },
          "url": "http://localhost:3000/projects/auth-system"
        }
      ]
    }
  ]
}
```

**drift_detected — Drift 告警通知**

```json
{
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "⚠ Drift Detected" }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*[AuthSystem]* Plan updated to v2, found *2 drift alerts*:"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "🔴 *HIGH* TASK-127 Token存储 · Agent-2 · running on v1\n🟡 *MEDIUM* TASK-124 刷新逻辑 · Bob · todo on v1"
      }
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Resolve in Dashboard" },
          "url": "http://localhost:3000/projects/auth-system"
        }
      ]
    }
  ]
}
```

**task_completed — Task 完成通知**

```json
{
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "✅ *[AuthSystem]* Alice completed *TASK-123 登录 API*\n3 files changed · branch `task/TASK-123-login-api`"
      }
    }
  ]
}
```

**通用格式（其他事件）**

```json
{
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "ℹ *[AuthSystem]* `execution_stale`: Agent-2 的执行心跳超时（TASK-127）"
      }
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "View Details" },
          "url": "http://localhost:3000/projects/auth-system"
        }
      ]
    }
  ]
}
```

### Webhook 投递时的 Slack 判断

```typescript
// packages/api/src/lib/webhook.ts 中 deliverWithRetry 的修改

// 投递时判断是否为 Slack URL，自动切换格式
const isSlack = url.includes('hooks.slack.com');
const requestBody = isSlack
  ? JSON.stringify(formatSlackMessage(payload.event, payload.projectName, payload.data))
  : JSON.stringify(payload);  // 非 Slack 接收方：发送原始 payload
```

### Slack 频道中的效果

```
#plansync-alerts 频道：

┌──────────────────────────────────────────┐
│ 🔔 Plan Activated                        │
│                                          │
│ Project:     AuthSystem                  │
│ Version:     v2                          │
│ Title:       OAuth 2.0 + NextAuth.js     │
│ Activated by: TeamLead                   │
│                                          │
│ [View in Dashboard]                      │
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│ ⚠ Drift Detected                         │
│                                          │
│ [AuthSystem] Plan updated to v2,         │
│ found 2 drift alerts:                    │
│                                          │
│ 🔴 HIGH TASK-127 Token存储              │
│    Agent-2 · running on v1               │
│ 🟡 MEDIUM TASK-124 刷新逻辑             │
│    Bob · todo on v1                      │
│                                          │
│ [Resolve in Dashboard]                   │
└──────────────────────────────────────────┘

✅ [AuthSystem] Alice completed TASK-123 登录 API
   3 files changed · branch task/TASK-123-login-api
```

---

## 3E：CLI 工具（非 MCP）

给不用 AI 编码工具的人提供命令行操作：

```bash
# 安装
npm install -g plansync-cli

# 使用
plansync-cli status                    # 项目状态
plansync-cli drift                     # drift 告警
plansync-cli drift resolve <id> rebind # 解决 drift
plansync-cli plan show                 # 查看当前 plan
plansync-cli tasks --mine              # 我的任务
```

---

### Phase 3 新增数据模型

```typescript
// API Key
{
  id: string,
  projectId: string,
  name: string,          // "GitHub Action", "Slack Bot"
  keyHash: string,       // crypto.scrypt hash（Node 内置，无需 native 编译）
  keyPrefix: string,     // "ps_key_xxxx" (前 8 位，用于展示)
  permissions: string[], // ['read', 'write', 'admin']
  createdBy: string,
  lastUsedAt?: DateTime,
  createdAt: DateTime
}

// Webhook
{
  id: string,
  projectId: string,
  url: string,
  events: string[],      // ['plan_activated', 'drift_detected', ...]
  secret?: string,        // HMAC signing secret
  active: boolean,
  createdBy: string,
  createdAt: DateTime
}

// WebhookDelivery（投递日志）
{
  id: string,
  webhookId: string,       // FK → Webhook
  event: string,           // 触发的事件类型
  requestBody: JSON,       // 发送的 payload
  responseCode: number,    // HTTP 状态码（0=网络错误）
  success: boolean,
  errorMessage?: string,   // 失败原因
  attempt: number,         // 第几次尝试（1=首次, 2-4=重试）
  createdAt: DateTime
}
// 保留策略：每个 Webhook 保留最近 200 条记录，超出自动清理
```

### Phase 3 新增目录

```
plansync/
├── packages/api/src/
│   ├── app/api/
│   │   ├── auth/api-keys/...          # API Key 管理
│   │   ├── projects/[id]/webhooks/... # Webhook CRUD
│   │   ├── webhooks/[webhookId]/
│   │   │   ├── route.ts              # DELETE webhook
│   │   │   ├── deliveries/route.ts   # GET 投递日志
│   │   │   └── test/route.ts         # POST 手动测试投递
│   │   └── docs/...                  # OpenAPI 文档
│   ├── lib/
│   │   ├── auth.ts                    # API Key 认证中间件（升级为 per-user key）
│   │   ├── webhook.ts                 # ★ Webhook 投递引擎（dispatchWebhooks + 重试 + 签名）
│   │   ├── slack-formatter.ts         # ★ Slack Block Kit 消息格式化
│   │   └── rate-limit.ts             # Rate limiting 中间件
├── packages/integrations/             # 新增 workspace 包
│   ├── package.json                   # @plansync/integrations
│   ├── github-action/                 # GitHub Action
│   │   ├── action.yml
│   │   └── index.ts
│   └── slack/                         # Slack 集成文档
│       └── README.md                  # 配置步骤指南
└── packages/cli/                      # 独立 CLI 工具（可选）
    ├── package.json
    └── src/index.ts
```

## Phase 3 开发计划（~1.5 周）

| 天 | 任务 | 验收 |
|----|------|------|
| **29** | API Key 认证中间件 + Key CRUD API | curl + API Key 能调用所有端点 |
| **30** | OpenAPI 文档自动生成 + Swagger UI | `/api/docs` 可访问 |
| **31** | Webhook 系统 + 事件投递 + 重试机制 | plan activate → webhook 收到通知 |
| **32** | GitHub Action：PR drift check | PR 上显示 drift 状态 |
| **33** | Slack 集成模板 + CLI 工具 | Slack 频道收到 drift 告警 |
| **34-35** | 端到端：activate → Agent 通知 + Web 更新 + Slack 告警 + GitHub check | 四端联动 |
| **36-38** | buffer + 文档 | 4 条验收标准全部通过 |

### Phase 3 验收标准（4 条）

| # | 验收项 | 怎么验证 |
|---|--------|---------|
| 13 | 开放 API + API Key 认证 | 用 API Key curl 调用成功 |
| 14 | Webhook 事件投递 | plan activate → webhook URL 收到 payload |
| 15 | GitHub PR drift check | PR 上显示 PlanSync check 状态 |
| 16 | Slack 通知 | Slack 频道收到 drift 告警消息 |

---

# Phase 4：智能层（Day 39-48）

> 目标：加分项。让 drift 检测更精准，但承认这不是护城河——这是**用户体验优化**。

## 诚实定位

| 智能功能 | 本质 | 能被复刻的速度 | 真正价值 |
|---------|------|--------------|---------|
| Semantic Plan Diff | Claude API 调用 + prompt | 2 小时 | 让用户看懂方案改了什么 |
| Impact Analysis | 又一个 Claude API 调用 | 2 小时 | 减少人工判断每个 task 是否受影响 |
| Conflict Prediction | LLM 基于描述猜测 | 3 小时 | 减少 merge 冲突 |
| Auto-Suggestion | 更多 LLM 调用 | 1 小时 | 减少决策负担 |

**这些不是壁垒，但是好的用户体验。** 用户会觉得 PlanSync 比其他工具「更聪明」。

## 智能功能 1：Semantic Plan Diff

```
输入：Plan v1 (JWT) → Plan v2 (OAuth 2.0)

输出：
{
  "changes": [
    {
      "aspect": "认证方式",
      "from": "自建 JWT token 签发",
      "to": "OAuth 2.0 + NextAuth.js 托管认证",
      "impact": "high",
      "affectedAreas": ["token 签发", "token 验证", "session 管理"],
      "unaffectedAreas": ["UI 组件", "数据库 schema"]
    }
  ]
}
```

## 智能功能 2：Impact Analysis

```
TASK-127 (Token 存储):
  兼容性: 12%
  原因: JWT token 逻辑与 OAuth session 完全不同
  建议: ❌ 取消并重做

TASK-130 (登录页 UI):
  兼容性: 95%
  原因: UI 不依赖认证实现
  建议: ✅ 直接 rebind
```

## 智能功能 3：Conflict Prediction

```
TASK-123 ↔ TASK-124: 冲突概率高
  原因: 都涉及 auth middleware
  建议: 串行开发
```

## 智能功能 4：Auto-Suggestion

| 触发场景 | 建议内容 |
|---------|---------|
| Plan 激活后 | 每个 drift task 的 rebind/cancel/no_impact 建议 |
| Task 开始时 | 潜在冲突提醒 |
| Task 完成时 | 是否覆盖 Plan deliverables |

## Phase 4 技术方案

```typescript
// packages/api/src/lib/ai/
├── plan-diff.ts           // Claude API 调用：Plan 语义 diff
├── impact-analysis.ts     // Claude API 调用：Task 影响评估
├── conflict-prediction.ts // Claude API 调用：冲突预测
└── prompts/
    ├── plan-diff.prompt.ts
    ├── impact-analysis.prompt.ts
    └── conflict-prediction.prompt.ts
```

### 增强版 Drift Engine

```
Phase 1 版本：
  boundVersion != activeVersion → drift

Phase 4 版本：
  1. boundVersion != activeVersion → 候选 drift
  2. 调用 LLM 分析 Plan diff（缓存结果，同一 pair 只算一次）
  3. 对每个候选 Task，调用 LLM 评估兼容性
  4. 兼容性 < 30% → drift (建议 cancel)
  5. 兼容性 30-70% → drift (建议 rebind + 注意事项)
  6. 兼容性 > 70% → 自动标记 no_impact
```

### 新增数据模型

```typescript
// PlanDiff（缓存 LLM 分析结果）
{
  id: string,
  projectId: string,
  fromPlanId: string,
  toPlanId: string,
  changes: JSON,           // 语义 diff 结果
  generatedAt: DateTime
}
```

### DriftAlert 字段扩展

```typescript
// Phase 4 新增字段
{
  ...existingFields,
  compatibilityScore?: number,    // 0-100
  impactAnalysis?: string,        // AI 分析
  suggestedAction?: string,       // AI 建议
  affectedAreas?: string[],       // 受影响领域
  planDiffId?: string             // → PlanDiff
}
```

### Web Dashboard 扩展

```
Plan 详情页：
  [Compare v1 ↔ v2] → 结构化语义 diff（不是文本 diff）

Drift Alert 卡片：
  🔴 TASK-127 Token 存储 · Agent-2
  兼容性: 12% · AI建议: 取消重做
  "JWT token 逻辑与 OAuth session 管理完全不同"
  [采纳建议: Cancel]  [忽略建议]

Dashboard 新增：
  ⚠ 冲突预警
  TASK-123 ↔ TASK-124: middleware 可能冲突
```

## Phase 4 开发计划（~1.5 周）

| 天 | 任务 | 验收 |
|----|------|------|
| **39** | Prompt 设计 + Claude API 集成 + PlanDiff 缓存 | 两个 Plan → 结构化语义 diff |
| **40** | Impact Analysis + 兼容性评分 | drift alert 带兼容性评分和建议 |
| **41** | 增强版 Drift Engine（高兼容自动 no_impact） | activate → 智能 drift |
| **42** | Conflict Prediction + Web 集成 | start task → 冲突预警 |
| **43** | Prompt 调优 + 端到端演练 | 全流程 AI 分析合理 |
| **44-48** | 最终 demo 打磨 + 全局 buffer | 20 条验收标准全部通过 |

### Phase 4 验收标准（4 条）

| # | 验收项 | 怎么验证 |
|---|--------|---------|
| 17 | Semantic Plan Diff | v1→v2 → 结构化变更分析 |
| 18 | Impact Analysis | drift alert 带兼容性评分 + 建议 |
| 19 | Conflict Prediction | 两个相关 Task → 冲突预警 |
| 20 | Auto no_impact | 高兼容性 task 自动标记 no_impact |

---

## 生产就绪规范（各 Phase 部署前实施）

### Rate Limiting（Phase 3 部署前）

```typescript
// packages/api/src/middleware.ts 中增加
// 使用内存 rate limiter（Phase 3 升级为 Upstash Redis 分布式限流）

const rateLimits = {
  default: { windowMs: 60_000, max: 100 },       // 普通操作：100 req/min
  heavy: { windowMs: 60_000, max: 10 },           // 重操作（activate, create plan）：10 req/min
  heartbeat: { windowMs: 60_000, max: 120 },      // 心跳：120 req/min（每 30s 一次 × 2 buffer）
};

// 基于 X-User-Name + IP 识别调用方
// 超限返回 429 Too Many Requests + Retry-After header
```

### Health Check（Phase 2 部署前）

```typescript
// packages/api/src/app/api/health/route.ts
// GET /api/health → 返回服务状态
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 3600,
  "checks": {
    "database": "connected",       // Prisma 连接检查
    "sseClients": 3                // 当前 SSE 连接数
  }
}
// 用于部署平台健康检查 + 监控
```

### Graceful Shutdown（Phase 2 部署前）

```typescript
// API: 收到 SIGTERM 时完成进行中的请求再退出
process.on('SIGTERM', async () => {
  logger.info('Shutting down gracefully...');
  // 1. 停止接受新请求
  // 2. 等待进行中的请求完成（最多 10s）
  // 3. 关闭 DB 连接
  await prisma.$disconnect();
  process.exit(0);
});

// MCP Server: 退出时主动发送 complete/cancel
// 防止遗留 stale 的 ExecutionRun
```

### CORS 配置（Phase 2 Web 上线前）

```typescript
// packages/api/src/middleware.ts
// Phase 1: 不需要（MCP 是 stdio，不经过 HTTP CORS）
// Phase 2: Web Dashboard 上线后配置
const allowedOrigins = [
  'http://localhost:3000',           // 本地开发
  'https://plansync.vercel.app',     // 生产环境
];
```

### Prisma 连接池（Phase 2 部署前）

```
开发环境（本地 PostgreSQL）：
  postgresql://localhost:15432/plansync_dev?connection_limit=5

生产环境（团队共享实例）：
  postgresql://user:pass@host:5432/plansync?connection_limit=20&pool_timeout=20
  如果使用 Serverless 部署，建议前置 PgBouncer 连接池

Migration 规范：
  - 开发用 `npx prisma migrate dev`（生成 + 应用）
  - 生产/CI 用 `npx prisma migrate deploy`（只应用，不生成）
  - 向后兼容策略：先加 nullable 列 → 填充数据 → 再改 required
```

---

# 全局验收标准汇总（20 条）

## Phase 1 — CLI 闭环（7 条）
| # | 验收项 |
|---|--------|
| 1 | AI 对话创建 Plan 并激活 |
| 2 | 创建 Task 自动绑定 active plan |
| 3 | 激活新 Plan → 自动生成 Drift |
| 4 | 解决 drift alert |
| 5 | start_task → 注入上下文 → complete |
| 6 | 查看执行人状态 |
| 7 | 查看项目全貌 |

## Phase 2 — Agent 协调 + Web（5 条）
| # | 验收项 |
|---|--------|
| 8 | Agent 实时收到方案变更通知（★ 核心差异化） |
| 9 | 项目 Dashboard 显示完整状态 |
| 10 | Drift Alert 可在 Web 上操作 |
| 11 | Plan 版本时间线可视化 |
| 12 | 三端实时同步（CLI + Agent + Web） |

## Phase 3 — 开放 API + 生态（4 条）
| # | 验收项 |
|---|--------|
| 13 | 开放 API + API Key 认证 |
| 14 | Webhook 事件投递 |
| 15 | GitHub PR drift check |
| 16 | Slack 通知 |

## Phase 4 — 智能层（4 条）
| # | 验收项 |
|---|--------|
| 17 | Semantic Plan Diff |
| 18 | Impact Analysis（兼容性评分） |
| 19 | Conflict Prediction |
| 20 | Auto no_impact |

---

## Demo 故事线（完整版）

3 个终端 + 1 个浏览器 + 1 个 Slack 频道

**Act 1：对齐方案**
```
TeamLead (CLI): "创建认证系统项目，方案用 JWT"
→ AI 创建 project + Plan v1 → activate
→ "创建 4 个任务..."
→ Web Dashboard 实时显示
```

**Act 2：开始工作**
```
Alice (CLI): "开始 TASK-123"
Agent-2 (CLI): 开始 TASK-127
→ Web: Team Grid 实时变为 🟢
→ TeamLead: "大家进度怎么样？" → 完整状态
```

**Act 3：★ 方案突变**（核心演示点）
```
TeamLead: "改方案，JWT 换成 OAuth 2.0"
→ 同时发生五件事：
  1. CLI: "⚠ 2 个 drift"
  2. Agent-2 的终端: "⚠ 方案刚刚改了！你的任务受影响，建议暂停！"  ← ★
  3. Web Dashboard: drift 告警弹出
  4. Slack: #plansync-alerts 收到通知
  5. GitHub PR: check 变为 ❌

→ Phase 4 加持：
  "TASK-127 兼容性 12%，建议取消重做"
  "TASK-130 兼容性 95%，建议直接 rebind"
```

**Act 4：处理 drift**
```
TeamLead: Web Dashboard 上一键处理 or CLI
→ 全部 v2，0 drift ✓
→ Agent-2 收到通知："你的任务已被 cancel，等待新任务分配"
```

### 评委话术

> "3 个人和 2 个 AI agent 同时写代码，lead 改了方案——PlanSync 在 1 秒内做四件事：通知正在写代码的 Agent 暂停、在 Dashboard 上弹出告警、Slack 频道推送通知、GitHub PR 标红。不只是检测 drift——它**主动协调正在运行的 Agent**，这是现有任何工具都做不到的。"

---

## 竞品分析

### 直接竞品：无

没有工具在做 AI agent 间的运行时方案协调。

### 相邻工具对比

| 工具 | 做什么 | PlanSync 差异 |
|------|--------|--------------|
| **Jira / Linear** | 任务管理 | 不管方案版本，不能通知 agent |
| **Git / PR** | 代码版本管理 | drift 在 review 时才发现 |
| **Slack / Notion** | 沟通文档 | 不追踪执行版本 |
| **Genie / Cursor / Claude Code** | AI 写代码 | 单 agent，不能被外部事件打断 |
| **Devin / SWE-Agent** | AI 自主开发 | 不管多 agent 协调 |

### 壁垒层次（修正后）

| 层次 | 壁垒 | 可复制难度 | Phase |
|------|------|-----------|-------|
| Drift Engine | 工作流设计 | 1-2 周 | 1 |
| **Agent 运行时协调** | **没人在做** | **需要深入 MCP 协议** | **2** |
| **生态集成** | **切换成本** | **需要时间积累** | **3** |
| Web Dashboard | 产品设计 | 2-3 周 | 2 |
| 智能层 | LLM 调用 | 2 小时 | 4 |

### 定位

> AI 编码时代的**方案协调平台**——不只是检测谁在按旧方案做，而是**主动协调正在运行的 Agent**，并融入 GitHub、Slack、CI/CD 等现有工具链。

---

## 测试策略

### 单元测试（从 Phase 1 Day 10 开始）

| 模块 | 重点测试内容 | 框架 |
|------|------------|------|
| **drift-engine.ts** ★ | 激活触发 drift 扫描、severity 计算、事务一致性、无旧 plan 时的边界 | Vitest + Prisma mock |
| Plan 状态机 | draft→proposed→active→superseded→reactivate 全路径 | Vitest |
| Task 自动绑定 | 创建 task 时绑定 active plan version；无 active plan 时的行为 | Vitest |
| 心跳超时 | 5min → stale，30min → failed | Vitest + fake timers |
| 认证中间件 | 有效/无效 Bearer token、AUTH_DISABLED 模式 | Vitest |

### 集成测试

| 范围 | 测试内容 | 方式 |
|------|---------|------|
| API 端到端 | 完整 workflow：create project → create plan → activate → drift → resolve | Supertest + 测试 DB |
| MCP Server | MCP 工具调用 → API 请求 → 返回结果 | MCP SDK test client |

### CI 配置

```yaml
# .github/workflows/test.yml（Phase 1 配置）
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: test
          POSTGRES_DB: plansync_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    env:
      DATABASE_URL: postgresql://postgres:test@localhost:5432/plansync_test
      PLANSYNC_SECRET: ci-test-secret-key
      AUTH_DISABLED: 'true'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 18
      - run: npm ci
      - run: cd packages/api && npx prisma migrate deploy && npm test
      - run: cd packages/mcp-server && npm test
```

---

## 风险清单与应对方案

| # | 风险 | 概率 | 影响 | 应对方案 | 状态 |
|---|------|------|------|---------|------|
| R1 | **MCP notification 在目标宿主上不可用** | 中 | 高 | 已设计三级降级方案（见问题 1）；Phase 1 默认使用降级方案 A 保底 | 待验证 |
| R2 | **SSE 长连接在 Serverless 平台不可用** | 中 | 中 | Phase 1 纯本地无问题；部署时优先使用公司内部服务器（持久进程），或拆分 SSE 服务 | 待验证 |
| R3 | **NFS 上运行 PostgreSQL 导致数据损坏** | — | 高 | **已规避**：数据目录放在 `/tmp`（本地 xfs），不放在 NFS 上 | ✅ 已解决 |
| R3b | **/tmp 数据重启后丢失** | 中 | 低 | `prisma migrate deploy + seed` 一条命令重建；生产环境用持久存储 | ✅ 已解决 |
| R3c | **共享机器端口冲突** | 低 | 低 | PG_PORT 和 PORT 均通过环境变量配置，不硬编码 | ✅ 已解决 |
| R4 | **多人同时 activate 不同 Plan（并发竞争）** | 低 | 高 | DB 层使用 `SELECT ... FOR UPDATE` 锁 + partial unique index 保证唯一 active | 待实现 |
| R5 | **Wrapper 在不同宿主上行为不一致** | 中 | 中 | Phase 1 聚焦 Genie（当前环境优先可用），其余宿主 Phase 2 再适配 | 待验证 |
| R6 | **MCP Server 与 API 断连** | 中 | 中 | 指数退避重连 + 本地缓存最近状态 + 断连期间工具调用返回友好错误 | 待实现 |
| R7 | **LLM API 调用延迟高或失败（Phase 4）** | 中 | 低 | 语义 diff 结果缓存（同一 plan pair 只算一次）；LLM 失败时回退到非智能模式 | 待实现 |
| **R8** | **npm cache 在 NFS 上损坏** | **高** | **高** | `.npmrc` 设置 `cache=/tmp/npm-cache-${USER}` + setup.sh 保底设置 | **✅ 已解决** |
| **R9** | **依赖版本不兼容 Node 18** | **高** | **高** | 所有 package.json 使用 `~` 锁定到验证通过的版本（详见技术栈表） | **✅ 已解决** |
| R10 | **Comment 刷屏/敏感信息泄露** | 低 | 中 | 评论频率限制（同一用户 5s 内最多 1 条）；content 长度限制（max 2000 字符）；owner 可删任何评论 | 待实现 |
| R11 | **Suggestion 并发 accept 竞态** | 低 | 中 | accept 事务中先检查 Plan 的 updatedAt 乐观锁；两个 set 同字段的 suggestion accept 第一个后，第二个自动标记 conflict | 待实现 |

---

## 错误处理与边界情况

### MCP Server ↔ API 连接

```
断连检测：API 调用超时（5s）或网络错误
重连策略：指数退避 — 1s, 2s, 4s, 8s, 最大 30s
断连期间：
  - 工具调用返回 "PlanSync API 暂时不可用，请稍后重试"
  - 不阻塞宿主 AI 的正常编码能力
恢复后：
  - 自动重新获取最新状态
  - 检查断连期间是否有 drift alert
```

### 心跳机制边界

```
正常心跳：每 30s 一次
网络抖动容忍：
  - 1 次心跳丢失（30-60s）→ 忽略
  - 5min 无心跳 → status = 'stale'（UI 显示黄色警告）
  - 30min 无心跳 → status = 'failed'（自动标记执行失败）
MCP Server 异常退出：
  - 心跳自然停止 → 5min 后标记 stale
  - 如果是 wrapper 启动的，退出时主动发送 complete/cancel
```

### SSE 连接管理

```
客户端（MCP Server / Web）断开后：
  - 自动重连（浏览器 EventSource 原生支持）
  - 重连后拉取断连期间的事件（通过 Last-Event-ID）
服务端内存管理：
  - 每个 SSE 连接跟踪 client count
  - 连接超过 1000 时拒绝新连接
  - 每个连接设置 24h 最大存活时间，到期后重连
```

### 并发处理

```
同时 activate 两个 Plan：
  - DB 事务 + SELECT FOR UPDATE 保证串行
  - 后执行的 activate 会将先执行的结果作为 oldPlan 处理

同时 resolve 同一个 DriftAlert：
  - 乐观锁（检查 status 仍为 'open'）
  - 后执行的返回 409 Conflict

同时 claim 同一个 Task：
  - 检查 assignee 为空 + 原子更新
  - 后执行的返回 409 Conflict
```

---

## 验证方案

```bash
# 首次初始化（一条命令，约 1-2 分钟）
cd /proj/gfx_gct_lec_user0/users/nanyang2/PlanSync
./scripts/setup.sh

# 日常开发（一条命令，自动启动 PG + 检查 migration + 启动 API）
npm run dev

# 启动 PlanSync wrapper → Genie + MCP Server
./bin/plansync
# 测试 7 条验收标准

# 运行测试
npm test                               # 一键运行所有包的测试

# Phase 2 验证
npm run dev                            # API + Web（同一个 Next.js）
open http://localhost:3000             # Web Dashboard
# 终端 A activate plan → 终端 B Agent 收到通知 → Web 实时更新

# Phase 3 验证
# API Key 调用 + Webhook 接收 + GitHub Action + Slack

# Phase 4 验证
# ANTHROPIC_API_KEY 环境变量
# Plan v1 → v2 → 语义 diff + 兼容性评分
```
