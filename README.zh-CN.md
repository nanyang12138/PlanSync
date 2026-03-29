# PlanSync

**让 AI Agent 和人类开发者在同一份计划下协作，计划变了，所有人立刻知道。**

[English](./README.md)

---

## 它解决什么问题？

多人协作中最容易出事的不是写代码，而是**信息不同步**——Owner 改了计划，但有人还在按旧版干活。

PlanSync 的做法：

- Owner 写计划（Plan），拆成任务（Task），分配给成员
- 成员在自己的 AI 工具（Cursor / Claude Code / Genie）里直接领任务、干活、汇报
- 计划一旦变更，所有相关成员立刻收到 **Drift Alert**

所有操作都通过 AI 对话完成，不需要切换到别的界面。

---

## 快速开始（5 分钟）

```bash
# ① 初始化（首次执行，安装依赖 + 启动数据库 + 建表）
cd /path/to/PlanSync
npm run setup

# ② 启动 API 服务
npm run dev

# ③ 连接你的 AI 工具
./bin/plansync --host cursor    # Cursor
./bin/plansync --host claude    # Claude Code
./bin/plansync --host genie     # Genie（默认）
```

本机单人使用**零配置**，直接在 AI 对话里开始工作。

---

## 配置

所有配置集中在项目根目录的 **`.env`** 文件中。首次 `npm run setup` 会自动从 `.env.example` 生成。

### 本机单人

不用改任何东西，默认值就能用。

### 多人团队

编辑 `.env`，填入 Owner 提供的信息：

```bash
PLANSYNC_USER=alice                        # 你的身份（默认使用系统用户名 $USER）
PLANSYNC_API_URL=http://192.168.1.10:3001  # API 地址（本机开发可省略）
PLANSYNC_SECRET=your-team-secret           # 认证密钥（向 Owner 获取）
```

`bin/plansync` 启动时会自动读取 `.env`，不需要在命令行传环境变量。

> **完整变量列表见** [配置参考](#配置参考)

---

## 多人协作流程

### Owner 做什么

1. 在服务器上运行 `npm run setup` → `npm run dev`
2. 在 `.env` 中设置一个 `PLANSYNC_SECRET`，把 **API 地址** 和 **密钥** 告诉团队
3. 在 AI 对话中创建项目和成员：

```
> 创建项目 "登录系统"
> 添加成员 alice（developer）
> 添加成员 bob（developer）
```

4. 分配任务：

```
> 创建任务 "实现登录 API"，分配给 alice
> 创建任务 "实现登录页 UI"，暂不分配
```

> **成员名 = 身份凭证**，必须和成员 `.env` 中的 `PLANSYNC_USER` 完全一致（区分大小写）。
> 不确定就让对方跑 `echo $USER`。

### 成员做什么

1. 从 Owner 获取 API 地址和密钥
2. 编辑 `.env`（见上方"多人团队"示例）
3. 启动：`./bin/plansync --host cursor`
4. 在 AI 对话中操作：

```
> 看看我有什么任务
> 开始任务 TASK-42
> 把 TASK-42 标记为完成
```

### 任务生命周期

| 动作            | 说明                                            |
| --------------- | ----------------------------------------------- |
| **分配**        | Owner 创建任务并指定 assignee，成员自动收到通知 |
| **接受 / 拒绝** | 成员可接受开始工作，或拒绝退回给 Owner          |
| **领取**        | 未分配的任务可以主动领取                        |
| **完成**        | 标记为 done                                     |

---

## 配置参考

| 变量                              | 默认值                                            | 用途                    |
| --------------------------------- | ------------------------------------------------- | ----------------------- |
| **客户端（`bin/plansync` 使用）** |                                                   |                         |
| `PLANSYNC_USER`                   | `$USER`                                           | 你在 PlanSync 中的身份  |
| `PLANSYNC_API_URL`                | `http://localhost:3001`                           | API 服务地址            |
| `PLANSYNC_SECRET`                 | `dev-secret`                                      | 认证密钥（全团队统一）  |
| **服务端（API 服务使用）**        |                                                   |                         |
| `DATABASE_URL`                    | `postgresql://$USER@localhost:15432/plansync_dev` | PostgreSQL 连接串       |
| `PG_PORT`                         | `15432`                                           | PostgreSQL 端口         |
| `PORT`                            | `3000`                                            | API 服务端口            |
| `AUTH_DISABLED`                   | `false`                                           | 跳过认证（仅本地开发）  |
| `LOG_LEVEL`                       | `info`                                            | 日志级别                |
| **AI 功能（可选）**               |                                                   |                         |
| `LLM_API_KEY`                     | —                                                 | AMD 内部 LLM API 密钥   |
| `LLM_API_BASE`                    | `https://llm-api.amd.com`                         | LLM API 地址            |
| `LLM_MODEL_NAME`                  | `Claude-Sonnet-4.5`                               | 模型名                  |
| `ANTHROPIC_API_KEY`               | —                                                 | Anthropic 官方 API 密钥 |

---

## 常用命令

| 命令               | 说明                                 |
| ------------------ | ------------------------------------ |
| `npm run setup`    | 首次初始化（依赖 + 数据库 + 迁移）   |
| `npm run dev`      | 启动 API 服务（自动启动 PostgreSQL） |
| `npm run db:reset` | 清空数据库重新开始                   |
| `npm run db:psql`  | 进入 PostgreSQL 命令行               |
| `npm run test`     | 运行测试                             |

---

## 核心概念

**身份模型** — 没有注册、没有密码。Owner 通过 `plansync_member_add` 添加成员名，成员在 `.env` 中用 `PLANSYNC_USER` 声明自己是谁。系统按名字匹配权限和任务。名字区分大小写。

**角色** — **Owner** 负责建项目、写计划、管成员；**Developer / Agent** 负责领任务、干活、汇报进度。

**Drift Alert** — 计划更新后，系统自动检测哪些任务基于旧版本计划创建，向相关成员推送预警。收到预警应停下当前工作，确认影响后再继续。

---

## 项目结构

```
PlanSync/
├── packages/
│   ├── api/          # REST API（Next.js + Prisma + PostgreSQL）
│   ├── mcp-server/   # MCP Server（AI 工具通过这里接入）
│   ├── shared/       # 共享类型与 Zod 校验
│   └── cli/          # CLI 工具
├── bin/plansync      # 一键启动脚本（自动注入 MCP 配置）
├── claude-md/        # AI Agent 行为指令
└── scripts/          # 数据库与运维脚本
```

详细设计见 [PLAN.md](./PLAN.md)。

---

## 常见问题

| 问题                               | 解决方法                                                    |
| ---------------------------------- | ----------------------------------------------------------- |
| 看不到任务                         | `.env` 中 `PLANSYNC_USER` 是否和 Owner 登记的名字完全一致？ |
| `assignee is not a project member` | 先让 Owner 添加成员，或核对拼写                             |
| `permission denied`                | `.env` 中 `PLANSYNC_SECRET` 和服务端不匹配                  |
| 忘了有哪些成员                     | AI 对话中输入"列出项目成员"                                 |
| 想重新开始                         | `npm run db:reset`                                          |

---

## NFS 环境适配

本项目在 NFS 挂载文件系统上做了以下处理：

- PostgreSQL 数据存在 `/tmp`（本地磁盘，规避 NFS 文件锁）
- npm 缓存重定向到 `/tmp/npm-cache-$USER`
- MCP Server 用 esbuild 打包（避免 tsc 在 NFS 上 OOM）
