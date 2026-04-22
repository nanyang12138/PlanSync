# tzhang5 UI Patch — 提交前审查报告

**Patch:** `/proj/gfx_gct_lec_user0/users/tzhang5/test/tzhang5_ui_changes.patch`
**已落地范围:** 31 / 33 文件（CLI + package-lock 已弃）
**Build:** ✗ 失败（Prisma client 未重生成 + 缺 migration）
**Lint:** 0 error / 51 warning（其中 11 条由本 patch 引入）

---

## 🛑 BLOCKER —— 必须修才能合并

### B0. 缺数据库 migration、Prisma client 未重生成

- `packages/api/prisma/schema.prisma` 加了 `Task.startDate` / `dueDate`
- 但 `packages/api/prisma/migrations/` **没有新 migration 文件**（最后一个仍是 `20260419062046_add_user_state`）
- `next build` 直接报错：
  ```
  ./src/app/projects/[id]/tasks/[taskId]/page.tsx:101
  Type error: Property 'startDate' does not exist on type {...}
  ```
- **修法（必须）:**
  ```
  cd packages/api
  pnpm prisma migrate dev --name add_task_start_due_dates
  pnpm prisma generate
  ```
  然后把生成的 `migrations/<timestamp>_add_task_start_due_dates/migration.sql` 一起 commit。

### B1. PATCH `/tasks/[taskId]` 与 `/tasks/[taskId]/complete-human` 提供两条「标记 done」路径，行为不一致

- `tasks/[taskId]/route.ts:64–76` 现在允许 human task 直接 `PATCH {status:'done'}`，**不需要 completion note，也不创建 ExecutionRun**
- 而新加的 `tasks/[taskId]/complete-human/route.ts` 强制要求 `completionNote.min(1)` + 创建 ExecutionRun + 写 activity
- `task-actions.tsx:94–111` 里的 `markDone()` 走的就是 PATCH 那条路（无 note）—— 但目前 `canMarkDone` 没有任何 caller 传 `true`（`tasks/[taskId]/page.tsx:105–111` 只传 `canRebind/canClaim/canDecline`），所以**实际不可达**
- 风险：未来谁加了 `canMarkDone={true}` 或外部 API 调用方，会绕过 note + ExecutionRun + activity 这套审计链路
- **修法（二选一）:**
  - (a) 推荐：从 `tasks/[taskId]/route.ts` 移除 PATCH `{status:'done'}` 对 human task 的支持，强制走 complete-human（API 返回 `Use POST /complete-human for human tasks`）；同时删 `task-actions.tsx` 里的 `markDone()` + `canMarkDone` 死代码
  - (b) 不动 PATCH，但在 task-actions.tsx 里彻底移除 markDone 路径（死代码 + 文档说明 PATCH 路径仅给脚本用）

---

## 🔴 HIGH —— 强烈建议修

### H1. `task-list.tsx` 用 `onClick + window.location.href` 替代 `<Link>` ── 可访问性 / 性能回退

- `dashboard/task-list.tsx`（patch 后 line ~43）：
  ```tsx
  <tr ... onClick={() => { window.location.href = `/projects/${projectId}/tasks/${t.id}`; }}>
  ```
- 后果：
  - 失去 Next.js 客户端导航 → **整页刷新**
  - **键盘不可达**（`<tr>` 无 tabindex/role/Enter 处理）
  - **中键无法在新 tab 打开**
  - 屏幕阅读器无法识别为可点击
- 之前的版本是 `<Link>` 包整行，干净又无障碍
- lint 还报 `'Link' is defined but never used`（line 1）—— 显然是 import 留着但 component 没用
- **修法:** 把 `<tr>` 内部第一个 `<td>` 改成 `<td><Link href="...">...</Link></td>` 或者整行包 `<Link>` 配 `<div>` 网格替代 `<table>`

### H2. `sidebar-tabs.tsx` —— 接 3 个完全没用的 props

- `dashboard/sidebar-tabs.tsx:17–31`：props 接 `tasks`、`activePlanVersion`、`driftTaskIds`、`activities`，但渲染只用 `activities`
- 旧版应该有「Tasks」tab，重构时只剩 AI + Activity 两个 tab，但 props 没清
- `projects/[id]/page.tsx:201–206` 也跟着传了一堆**白传**的数据
- lint 报 4 条 `defined but never used`
- **修法:** sidebar-tabs.tsx 删掉这 3 个 props，调用方同步删

### H3. `new-task-button.tsx` 和 `task-dates-editor.tsx` —— 不校验 `startDate ≤ dueDate`

- `new-task-button.tsx:39–67`、`task-dates-editor.tsx:29–51` —— 直接把日期 POST 出去
- 后果：在 Gantt 视图（`task-gantt.tsx:86`）`duration = toDay(due) - toDay(start) || 1` —— 负数 duration 走 `||1` 拿到 1，**不是按预期渲染**，但仍是脏数据
- 后端 schema (`shared/src/schemas/task.ts:20-21, 38-39`) 也没 cross-field validation
- **修法（前后端都加）:**
  - 前端：submit 前 `if (start && due && new Date(start) > new Date(due)) return setError('开始日期必须早于截止日期')`
  - 后端：在 `createTaskSchema` / `updateTaskSchema` 用 `.refine(d => !d.startDate || !d.dueDate || d.startDate <= d.dueDate, ...)`

### H4. `delete-project-button.tsx` —— 删除成功后不跳转

- `components/shared/delete-project-button.tsx:13–28`：`router.refresh()` 后用户停在原页（首页或 project dashboard），看到 stale UI 直到刷新拿到新 server data
- 在 `projects/[id]/page.tsx:68` 也用了这个按钮，**项目都删了用户还停在 `/projects/{id}` 页面**，会触发 404
- **修法:** `router.push('/'); router.refresh();`

---

## 🟡 MEDIUM —— PR 前最好修

### M1. `task-complete-human.tsx` —— success 路径不重置 `saving`

- `components/task/task-complete-human.tsx:20–44`：`router.refresh()` 后无 `setSaving(false)`
- 实际表现：成功后父组件根据 `task.status === 'in_progress'` 不再渲染本组件（page.tsx:46–47, 113–118 的 `canCompleteHuman` 守卫），所以**用户感知不到**
- 但若 router.refresh 慢或失败、或父组件结构变了，会显示卡住的 "Completing…"
- **修法:** 用 `try / catch / finally`，`finally { setSaving(false) }`

### M2. `suggestions/route.ts` —— 校验语义反转，影响范围确认

- `suggestions/route.ts:47–49`：旧逻辑只允许 `draft / proposed`；新逻辑允许除 `superseded` 外的全部状态（含 `active`、`done`、`archived` 之类）
- 配合 `suggestion-panel.tsx:139–217` 的 `AddSuggestionForm` —— 在 active plan 上提建议是这次 patch 的产品意图
- **风险**：在 `done` plan 上也允许提建议是否合理？UI 没有任何状态守卫
- **修法（确认意图后选）:**
  - (a) 如果意图是「only active + draft + proposed」：明确写 `if (!['draft','proposed','active'].includes(plan.status)) throw ...`
  - (b) 同步在 `AddSuggestionForm` 加 `if (!['draft','proposed','active'].includes(plan.status)) return null;`（需要把 plan 传进去）

### M3. `task-complete-human.tsx` PR URL —— 仅 HTML5 校验，可接受 `javascript:` 等

- `components/task/task-complete-human.tsx:89–95`：`<input type="url">` 只校验语法，能通过 `javascript:alert(1)`
- 后端 `complete-human/route.ts:12` 用了 `z.string().url()` ✓ 但 `url()` 也接受 `javascript:` scheme
- **修法:** 后端改 `z.string().url().refine(u => /^https?:/.test(u), 'PR URL must be http(s)')` 或在前端额外校验

### M4. `complete-human/route.ts` —— 类型 cast 不够干净

- `complete-human/route.ts:46`：`taskPackSnapshot: (taskPack as object) ?? {}`
- `as object` 是 TS 弱断言；`buildTaskPack` 的返回类型应该是 JSON-serializable，应该用 `Prisma.InputJsonValue` 或导入 `buildTaskPack` 的真实返回类型
- **修法:** 看 `buildTaskPack` 签名，去掉 `as object`，直接 `taskPackSnapshot: taskPack as Prisma.InputJsonValue`

### M5. 重复硬编码常量 `TASK_TYPES` / `PRIORITIES`

- `dashboard/new-task-button.tsx:12–17`、`task/task-editor.tsx:8–13` 一字不差地各写一遍
- 新加 type/priority 时要改两处，必出 bug
- **修法:** 抽到 `packages/shared/src/constants/task.ts`（或扩展 schema 现有 `taskTypeSchema._def.values` / `taskPrioritySchema._def.values`），两个组件 import

### M6. 11 个新的 `any` lint 警告

- `task-complete-human.tsx:40`、`task-editor.tsx:64`、`task-dates-editor.tsx:46`、`new-task-button.tsx:62`、`delete-project-button.tsx:23`、`suggestion-panel.tsx:132` —— 全是 `catch (e: any)`
- 项目其他文件用 `catch (e) { e instanceof Error ? e.message : String(e) }` 模式（见 `task-actions.tsx:51`、`suggestion-panel.tsx:63`）
- **修法:** 统一改成 `catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong') }`

---

## 🟢 LOW —— 清理类，可顺手做

### L1. `app/page.tsx` —— `Home` / `CheckCircle2` 两个 lucide 图标 import 但完全没用（line 7, 13）

### L2. `dashboard/sidebar-tabs.tsx` —— 顶部 `Link` / `Plan` / `ProjectMember` 三个 import 没用（line 4, 5）

### L3. `dashboard/task-list.tsx:1` —— `Link` import 没用（H1 修了之后就用上了）

### L4. `plan-workspace-client.tsx:148` —— `canProposeSelectedDraft` 变量声明但未使用

### L5. `suggestion-panel.tsx:93` —— `STRING_FIELDS` 常量没用

### L6. `app/globals.css:120` —— `.project-row-cols` 加了网格定义，全代码库无任何引用（patch 把首页改成 table 没用 grid 了）

### L7. `task-gantt.tsx:67–71` —— 月份 header 用 `cur.toLocaleDateString(...)`，正文用 `formatDate()` 自定义。两套日期格式不一致，建议统一

### L8. `task-gantt.tsx:39–40` —— 只有一个日期的 task 被静默丢入「无日期」组，建议在卡片上加小提示「Missing start/due」

### L9. 邮件去掉了 `Project ID` / `Plan ID`（`drift-engine.ts:117`、`propose/route.ts:103–106`）—— UX 改动，是否真的好？用户从邮件 quote 引用 ID 时没了 tag。可能想加 deeplink URL 替代

---

## 整体观察

### 好的地方

- 新加的 7 个 UI 组件 Tailwind 用法 / 视觉风格与现有一致 ✓
- `complete-human/route.ts` 用 `prisma.$transaction` 保证原子性 ✓
- schema 改动是 optional 字段，向后兼容 ✓
- `auth.ts` 加 cookie key 兜底是合理的浏览器流增强 ✓
- 后端 zod schema (shared/task.ts) 改动同步、`createSuggestionSchema` 的 superseded 检查也确实改进了 UX

### 不好的地方

- **没有迁移文件 + build 跑不过**，说明 patch 作者**没在本地 build / 运行过**就发的 patch
- task-list.tsx 用 `window.location.href` 是明显回退，team 应该有「不许这么写」的 lint 规则
- 各种 dead code（unused imports、unused props、unused CSS、unreachable branches）一大堆 —— 重构没收尾

---

## 提交前检查清单

按优先级合并：

- [ ] **B0** 跑 `pnpm prisma migrate dev --name add_task_start_due_dates` + commit migration 文件
- [ ] **B0** 跑 `pnpm prisma generate` + 确认 `pnpm build` 全过
- [ ] **B1** 决定 PATCH `{status:'done'}` 对 human task 的策略，删 `task-actions.tsx` 死代码或加 API guard
- [ ] **H1** task-list.tsx 改回 `<Link>` 包行
- [ ] **H2** sidebar-tabs.tsx 删 3 个无用 props，page.tsx 同步删
- [ ] **H3** 前后端都加 startDate ≤ dueDate 校验
- [ ] **H4** delete-project-button.tsx 删除后 `router.push('/')`
- [ ] **M1** task-complete-human.tsx 用 try/catch/finally
- [ ] **M2** 与 owner 确认 suggestion 在 done plan 上是否要被允许，对应改后端 + UI guard
- [ ] **M3** 后端校验 PR URL 必须是 http(s)
- [ ] **M4** 去掉 `as object` cast
- [ ] **M5** 抽 TASK_TYPES / PRIORITIES 到 shared
- [ ] **M6** `catch (e: any)` 统一改成 `catch (e)` + instanceof
- [ ] **L1–L6** 清死代码（unused imports / props / vars / CSS）
- [ ] **L7–L9** Gantt 日期格式统一、缺日期提示、邮件加 deeplink
- [ ] 最后再跑一次 `pnpm lint && pnpm build && pnpm test`，确认 0 error
- [ ] 手动验证（可在 PR description 列出）：
  - 创建任务 + 设置日期 → Gantt 渲染正常
  - 标记 human task done → 走 complete-human 路径，写入 ExecutionRun + activity
  - 删除 project → 自动跳回首页
  - active plan 上提 suggestion → 行为符合 M2 决策
  - 故意填非法日期范围 → 报错而不是入库
  - PR URL 填 `javascript:alert(1)` → 后端拒绝
