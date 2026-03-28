# PlanSync

AI 团队协作平台，确保 AI Agent 和人类开发者在计划变更时始终保持同步。

> [English version below ↓](#plansync-english)

---

## 这是什么？

你的团队在开发一个项目。**Owner** 写计划（Plan）、拆任务、分配给团队成员。每个成员（人类开发者或 AI Agent）通过 MCP 接入 PlanSync，在自己的 AI 工具（Cursor / Claude Code）里直接查看任务、领取任务、汇报进度。计划一旦变更，所有人立刻收到 Drift 预警，不会悄悄跑偏。

---

## 基本概念：身份是怎么工作的？

PlanSync **没有账号注册、没有密码**。身份基于一个字符串名字：

- Owner 在创建项目后，通过 `plansync_member_add` 工具把成员名字（如 `alice`）加入项目
- alice 启动 PlanSync 时，用 `PLANSYNC_USER=alice` 告诉系统"我是 alice"
- 系统用这个名字去数据库里查权限，匹配任务

这是一个**轻量信任模型**，适合内部团队和 AI Agent 协作场景。**名字必须完全一致**（区分大小写），这是唯一的身份凭证。

---

## 角色说明

| 角色 | 职责 |
|------|------|
| **Owner** | 初始化服务、创建项目、添加成员、分配任务 |
| **Developer / Agent** | 连接 API、领取任务、执行工作、汇报进度 |

---

## 快速开始

### 场景一：本地单机（只有你自己）

这是最简单的场景，无需任何配置。

```bash
# 第一次运行
cd /path/to/PlanSync
npm run setup      # 安装依赖 + 启动 PostgreSQL + 跑迁移

# 之后每次
npm run dev        # 启动 API 服务（http://localhost:3001）

# 另开终端，启动 AI 工具
./bin/plansync --host cursor   # 配置 Cursor
./bin/plansync --host claude   # 配置 Claude Code
```

你的身份自动使用系统用户名 `$USER`，所有操作都在本机完成，直接在 AI 对话里工作即可。

---

### 场景二：多人团队协作

#### Owner 的操作（在运行 API 的那台机器上）

**第一步：初始化（只需一次）**

```bash
cd /path/to/PlanSync
npm run setup
```

**第二步：启动 API 服务**

```bash
npm run dev
```

服务默认跑在 `http://localhost:3001`。如果团队成员需要远程访问，确保这台机器的 3001 端口对他们可达，然后把**完整 IP 地址**告诉他们，例如 `http://192.168.1.10:3001`。

**第三步：启动 AI 工具并设置项目**

```bash
./bin/plansync --host cursor   # 或 --host claude / --host genie
```

然后在 AI 对话里：

```
> 创建项目 "登录系统"
> 添加成员 alice（developer）
> 添加成员 bob（developer）
```

> ⚠️ **关键：成员名决定身份，必须和成员的 PLANSYNC_USER 完全一致**
>
> 如果你不知道 alice 的系统用户名，直接问她。她运行 `echo $USER` 就能看到。
> 或者你们商量一个名字，告诉她连接时用 `PLANSYNC_USER=alice`。
>
> 如果将来需要查系统里已注册的成员，在 AI 对话里输入：
> ```
> > 列出所有项目成员
> ```

**第四步：分配任务**

```
> 创建任务 "实现登录 API"，分配给 alice
> 创建任务 "实现登录页 UI"，暂不分配
```

分配任务时系统会校验 assignee 是否已是项目成员。**名字不存在会直接报错**，这样可以避免拼写错误导致任务无声无息地丢失。

---

#### 团队成员（alice / bob）的操作

你需要从 Owner 处获取：

1. **API 地址**，例如 `http://192.168.1.10:3001`
2. **你在 PlanSync 里的成员名**（Owner 添加你时填写的名字）

**启动：**

```bash
# 如果 API 在本机（你和 Owner 是同一台机器）
./bin/plansync --host cursor

# 如果 API 在其他机器
PLANSYNC_API_URL=http://192.168.1.10:3001 ./bin/plansync --host cursor
```

你的用户名默认使用 `$USER`（系统用户名）。

> **如果系统用户名和 Owner 登记的名字不同**，需要显式指定：
>
> ```bash
> PLANSYNC_USER=alice PLANSYNC_API_URL=http://192.168.1.10:3001 ./bin/plansync --host cursor
> ```

启动后，在 AI 对话里操作：

```
> 看看我有什么任务
> 开始任务 TASK-42
> 这个任务我想拒绝，请换人
> 把 TASK-42 标记为完成
```

---

## 任务流程说明

### Owner 分配任务后，成员会收到通知

Owner 创建任务并指定 assignee 后，系统会向 alice 推送 `task_assigned` 事件。alice 的 AI Agent 下次连接时会自动提示。

### 成员可以接受或拒绝分配

```
# alice 接受并立刻开始
> 接受任务 TASK-42

# alice 拒绝分配（任务退回给 Owner 重新安排）
> 拒绝任务 TASK-42
```

### 未分配的任务可以主动领取

```
> 领取任务 TASK-99
```

---

## 身份与配置说明

`./bin/plansync` 启动时读取以下环境变量（均有默认值）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PLANSYNC_USER` | `$USER`（系统用户名） | 你在 PlanSync 里的身份 |
| `PLANSYNC_API_URL` | `http://localhost:3001` | API 服务地址 |
| `PLANSYNC_SECRET` | `dev-secret` | API 认证密钥（全团队共用同一个） |

三个变量都有合理默认值，**本机单人开发无需任何配置**。

多人团队时，Owner 在 `packages/api/.env` 里修改 `AUTH_SECRET`，然后把这个值（即新的 `PLANSYNC_SECRET`）告知所有成员，大家启动时统一传入。

---

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run setup` | 首次初始化（PostgreSQL + 依赖 + 数据库迁移） |
| `npm run dev` | 启动 API 服务（自动启动 PostgreSQL） |
| `npm run db:reset` | 重置数据库（清空所有数据，重新初始化） |
| `npm run test` | 运行测试 |
| `npm run db:psql` | 进入 PostgreSQL 命令行 |

---

## 常见问题

**Q: 我的任务看不到？**
A: 检查 `PLANSYNC_USER` 是否和 Owner 登记的名字完全一致（区分大小写）。

**Q: 报错"assignee is not a project member"？**
A: Owner 在分配任务时填写的名字，在数据库里不存在。让 Owner 先执行"添加成员"，或核对名字拼写。

**Q: 报错"permission denied"？**
A: 你的 `PLANSYNC_SECRET` 和 API 服务端的 `AUTH_SECRET` 不匹配，向 Owner 确认正确的密钥。

**Q: 我是 Owner，忘了添加哪些成员了？**
A: 在 AI 对话里输入 `列出项目成员`，AI 会调用 `plansync_project_members` 工具列出所有成员。

**Q: 数据弄乱了，想重新开始？**
A: 运行 `npm run db:reset` 清空数据库，重新创建项目和任务即可。

---

## 项目结构

```
PlanSync/
├── packages/
│   ├── api/          # REST API 服务（Next.js + Prisma + PostgreSQL）
│   ├── mcp-server/   # MCP Server（AI Agent 通过此接入）
│   ├── shared/       # 共享类型和 Zod 校验
│   └── cli/          # CLI 工具
├── bin/plansync      # 一键启动脚本（自动注入 MCP 配置）
├── claude-md/        # AI Agent 行为指令
└── scripts/          # 数据库脚本
```

开发者文档：见 `PLAN.md`（API 设计、数据模型、MCP 工具列表）。

---

## 环境说明（NFS 环境）

本项目运行在 NFS 挂载的文件系统上，已做以下适配：

- PostgreSQL 数据存在 `/tmp`（本地 xfs 磁盘，避免 NFS 锁问题）
- npm 缓存重定向到 `/tmp/npm-cache-$USER`
- MCP Server 用 `esbuild` 打包（避免 NFS 上 `tsc` OOM）

---
---

# PlanSync (English)

An AI team collaboration platform that keeps AI Agents and human developers in sync when plans change.

---

## What is this?

Your team is building a project. The **Owner** writes the Plan, breaks it into tasks, and assigns them to team members. Each member (human developer or AI Agent) connects to PlanSync via MCP, and can view tasks, claim tasks, and report progress directly from their own AI tool (Cursor / Claude Code). When the plan changes, everyone gets a Drift Alert immediately — no one silently goes off-track.

---

## Core Concept: How Identity Works

PlanSync has **no account registration and no passwords**. Identity is based on a simple string name:

- After creating a project, the Owner adds member names (e.g. `alice`) via the `plansync_member_add` tool
- When alice starts PlanSync, she uses `PLANSYNC_USER=alice` to tell the system "I am alice"
- The system looks up permissions and tasks in the database using this name

This is a **lightweight trust model** suited for internal teams and AI Agent collaboration. **The name must match exactly** (case-sensitive) — it is the only identity credential.

---

## Roles

| Role | Responsibility |
|------|----------------|
| **Owner** | Initialize the service, create projects, add members, assign tasks |
| **Developer / Agent** | Connect to the API, claim tasks, do the work, report progress |

---

## Quick Start

### Scenario 1: Local Single User (just you)

This is the simplest case — no configuration needed.

```bash
# First time only
cd /path/to/PlanSync
npm run setup      # Install deps + start PostgreSQL + run migrations

# Every time after
npm run dev        # Start the API server (http://localhost:3001)

# In another terminal, start your AI tool
./bin/plansync --host cursor   # Configure Cursor
./bin/plansync --host claude   # Configure Claude Code
```

Your identity defaults to your system username `$USER`. Everything runs locally — just start chatting with your AI tool.

---

### Scenario 2: Multi-Person Team Collaboration

#### Owner's steps (on the machine running the API)

**Step 1: Initialize (one-time only)**

```bash
cd /path/to/PlanSync
npm run setup
```

**Step 2: Start the API server**

```bash
npm run dev
```

The server runs at `http://localhost:3001` by default. If team members need remote access, make sure port 3001 is reachable from their machines, then share the **full IP address** with them, e.g. `http://192.168.1.10:3001`.

**Step 3: Start your AI tool and set up the project**

```bash
./bin/plansync --host cursor   # or --host claude / --host genie
```

Then in AI chat:

```
> Create a project called "Login System"
> Add member alice (developer)
> Add member bob (developer)
```

> ⚠️ **Critical: member names determine identity and must exactly match PLANSYNC_USER**
>
> If you don't know alice's system username, just ask her — she can run `echo $USER` to find out.
> Or agree on a name together and tell her to connect with `PLANSYNC_USER=alice`.
>
> To check which members are already registered:
> ```
> > List all project members
> ```

**Step 4: Assign tasks**

```
> Create task "Implement login API", assign to alice
> Create task "Build login page UI", leave unassigned
```

When assigning tasks, the system validates that the assignee is already a project member. **A name that doesn't exist causes an error** — this prevents typos from silently losing tasks.

---

#### Team Member (alice / bob) steps

Get two things from the Owner:

1. **API address**, e.g. `http://192.168.1.10:3001`
2. **Your member name in PlanSync** (the name the Owner used when adding you)

**Start:**

```bash
# If the API is on localhost (you're on the same machine as the Owner)
./bin/plansync --host cursor

# If the API is on another machine
PLANSYNC_API_URL=http://192.168.1.10:3001 ./bin/plansync --host cursor
```

Your username defaults to `$USER` (your current system login name).

> **If your system username differs from the name the Owner registered:**
>
> ```bash
> PLANSYNC_USER=alice PLANSYNC_API_URL=http://192.168.1.10:3001 ./bin/plansync --host cursor
> ```

Once started, interact via AI chat:

```
> Show me my tasks
> Start task TASK-42
> I don't want this task, please reassign it
> Mark TASK-42 as done
```

---

## Task Workflow

### Members get notified when assigned a task

When the Owner creates a task and specifies an assignee, the system pushes a `task_assigned` event to alice. Her AI Agent will surface this automatically on the next connection.

### Members can accept or decline an assignment

```
# alice accepts and starts immediately
> Accept task TASK-42

# alice declines (task goes back to Owner for reassignment)
> Decline task TASK-42
```

### Members can self-assign unassigned tasks

```
> Claim task TASK-99
```

---

## Identity & Configuration

`./bin/plansync` reads these environment variables (all have defaults):

| Variable | Default | Description |
|----------|---------|-------------|
| `PLANSYNC_USER` | `$USER` (system username) | Your identity in PlanSync |
| `PLANSYNC_API_URL` | `http://localhost:3001` | API server address |
| `PLANSYNC_SECRET` | `dev-secret` | API authentication secret (shared by the whole team) |

All three have sensible defaults. **For single-developer local use, no configuration is needed.**

For teams, the Owner sets `AUTH_SECRET` in `packages/api/.env`, then shares that value (the new `PLANSYNC_SECRET`) with all team members to use when starting.

---

## Commands

| Command | Description |
|---------|-------------|
| `npm run setup` | First-time initialization (PostgreSQL + deps + migrations) |
| `npm run dev` | Start the API server (also starts PostgreSQL) |
| `npm run db:reset` | Reset the database (wipes all data and reinitializes) |
| `npm run test` | Run tests |
| `npm run db:psql` | Open a PostgreSQL shell |

---

## FAQ / Troubleshooting

**Q: My tasks don't show up?**
A: Check that `PLANSYNC_USER` exactly matches the name the Owner registered (case-sensitive).

**Q: Error "assignee is not a project member"?**
A: The name used when assigning the task doesn't exist in the database. Have the Owner add the member first, or double-check the spelling.

**Q: Error "permission denied"?**
A: Your `PLANSYNC_SECRET` doesn't match the API server's `AUTH_SECRET`. Confirm the correct secret with the Owner.

**Q: As Owner, I forgot which members I've added?**
A: Type `list project members` in AI chat — the AI will call `plansync_project_members` and show all registered members.

**Q: Things got messy, want to start over?**
A: Run `npm run db:reset` to wipe the database, then recreate your project and tasks.

---

## Project Structure

```
PlanSync/
├── packages/
│   ├── api/          # REST API (Next.js + Prisma + PostgreSQL)
│   ├── mcp-server/   # MCP Server (AI Agents connect here)
│   ├── shared/       # Shared types and Zod schemas
│   └── cli/          # CLI tool
├── bin/plansync      # One-command launcher (injects MCP config)
├── claude-md/        # AI Agent behavior instructions
└── scripts/          # Database scripts
```

Developer docs: see `PLAN.md` (API design, data model, MCP tool list).

---

## Environment Notes (NFS Environment)

This project runs on an NFS-mounted filesystem with the following adaptations:

- PostgreSQL data stored in `/tmp` (local xfs disk, avoids NFS locking issues)
- npm cache redirected to `/tmp/npm-cache-$USER`
- MCP Server bundled with `esbuild` (avoids `tsc` OOM on NFS)
