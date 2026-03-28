# PlanSync 功能验证规格 (Verification Spec)

> 覆盖 Phase 1-4 全部功能，参考 PLAN.md 中 20 条验收标准 + 所有状态机 + 边界条件。
> 类似芯片设计验证：**每个功能点 = 一个 test case，明确输入/预期/通过标准。**

---

## 模块 A: 项目管理 (Project)

| ID  | Test Case  | 输入                                | 预期输出                 | 边界/异常          |
| --- | ---------- | ----------------------------------- | ------------------------ | ------------------ |
| A1  | 创建项目   | POST /projects `{name,description}` | 201, 自动成为 owner      |                    |
| A2  | 项目名唯一 | 重复创建同名项目                    | 409 CONFLICT             |                    |
| A3  | 列出项目   | GET /projects                       | 200, 分页                | page/pageSize 参数 |
| A4  | 项目详情   | GET /projects/:id                   | 200                      | 不存在 → 404       |
| A5  | 更新项目   | PATCH /projects/:id                 | 200                      | 非 owner → 403     |
| A6  | 聚合状态   | GET /projects/:id/status            | 200, 含 plan+tasks+drift |                    |

## 模块 B: 成员管理 (Member)

| ID  | Test Case       | 输入                        | 预期输出        | 边界/异常      |
| --- | --------------- | --------------------------- | --------------- | -------------- |
| B1  | 添加成员        | POST /members `{name,role}` | 201             | 非 owner → 403 |
| B2  | 重复添加        | 相同 name                   | 409             |                |
| B3  | 列出成员        | GET /members                | 200             |                |
| B4  | 修改角色        | PATCH /members/:id `{role}` | 200             | 非 owner → 403 |
| B5  | 最后 owner 保护 | 将唯一 owner 降为 developer | 400 BAD_REQUEST |                |
| B6  | 删除成员        | DELETE /members/:id         | 200             | 非 owner → 403 |
| B7  | 删除最后 owner  | DELETE 唯一 owner           | 400             |                |

## 模块 C: 计划生命周期 (Plan State Machine)

状态机: `draft → proposed → active → superseded`，`superseded → active` (reactivate)

| ID  | Test Case            | 输入                                    | 预期输出                         | 边界/异常                      |
| --- | -------------------- | --------------------------------------- | -------------------------------- | ------------------------------ |
| C1  | 创建 plan            | POST /plans `{title,goal,scope,...}`    | 201, status=draft, version 自增  |                                |
| C2  | 编辑 draft           | PATCH /plans/:id `{goal:...}`           | 200                              | 非 draft → 400; 非 owner → 403 |
| C3  | 无 reviewer 直接激活 | draft → activate (无 requiredReviewers) | plan.status=active               |                                |
| C4  | 提交审批             | POST /propose `{reviewers}`             | status=proposed, PlanReview 创建 | 非 owner → 403                 |
| C5  | 审批 - approve       | POST /reviews/:id?action=approve        | review.status=approved           |                                |
| C6  | 审批 - reject        | POST /reviews/:id?action=reject         | review.status=rejected           |                                |
| C7  | 未全部审批就激活     | activate with pending reviews           | 400 "not all approved"           |                                |
| C8  | 全部审批后激活       | activate after all approved             | plan.status=active               |                                |
| C9  | 单 active 约束       | 激活 v2 时 v1 → superseded              | 同时只有 1 个 active             |                                |
| C10 | 回滚 reactivate      | POST /reactivate on superseded plan     | 重新变为 active                  | 非 superseded → 400            |
| C11 | Active plan 查询     | GET /plans/active                       | 返回当前 active plan             | 无 active → null/404           |

## 模块 D: 建议系统 (Suggestion)

| ID  | Test Case              | 输入                                                  | 预期输出            | 边界/异常      |
| --- | ---------------------- | ----------------------------------------------------- | ------------------- | -------------- |
| D1  | 提交 set 建议          | `{field:"goal",action:"set",value,reason}`            | 201                 |                |
| D2  | 提交 append 建议       | `{field:"constraints",action:"append",value,reason}`  | 201                 |                |
| D3  | 提交 remove 建议       | `{field:"deliverables",action:"remove",value,reason}` | 201                 |                |
| D4  | 非 draft/proposed 拒绝 | 对 active plan 提 suggestion                          | 400                 |                |
| D5  | accept set 建议        | POST /:id?action=accept                               | plan 对应字段被替换 | 非 owner → 403 |
| D6  | accept append 建议     | accept append                                         | 数组新增元素        |                |
| D7  | reject 建议            | POST /:id?action=reject                               | status=rejected     |                |
| D8  | field 验证             | 非法 field (e.g. "title")                             | 400 VALIDATION      |                |
| D9  | action/field 交叉验证  | set on array field / append on string field           | 正确处理            |                |
| D10 | reason 必填            | 缺少 reason                                           | 400                 |                |

## 模块 E: 评论系统 (Comment)

| ID  | Test Case            | 输入                                | 预期输出           | 边界/异常    |
| --- | -------------------- | ----------------------------------- | ------------------ | ------------ |
| E1  | 发表评论             | POST /comments `{content}`          | 201                |              |
| E2  | 回复评论             | POST /comments `{content,parentId}` | 201, parentId 关联 |              |
| E3  | 列出评论             | GET /comments                       | 200, 含子回复      |              |
| E4  | 编辑自己的           | PATCH /comments/:id `{content}`     | 200                | 别人的 → 403 |
| E5  | 删除自己的           | DELETE /comments/:id                | 软删除             |              |
| E6  | Owner 删别人的       | DELETE (owner 删 developer 评论)    | 200                |              |
| E7  | 任何 plan 状态可评论 | 对 active/superseded plan 评论      | 201                |              |

## 模块 F: 任务生命周期 (Task)

状态机: `todo → in_progress → done/blocked/cancelled`

| ID  | Test Case           | 输入                                | 预期输出                          | 边界/异常    |
| --- | ------------------- | ----------------------------------- | --------------------------------- | ------------ |
| F1  | 创建任务            | POST /tasks `{title,type,priority}` | 201, 自动绑定 active plan version |              |
| F2  | 无 active plan 创建 | 没有 active plan 时创建 task        | 400 PLAN_NOT_ACTIVE               |              |
| F3  | type 枚举           | code/research/design/bug/refactor   | 各值通过                          | 非法值 → 400 |
| F4  | priority 枚举       | p0/p1/p2                            | 各值通过                          | 非法值 → 400 |
| F5  | 列出任务            | GET /tasks?status=&assignee=        | 200, 支持筛选                     |              |
| F6  | Claim 任务          | POST /claim `{assigneeType}`        | 200, assignee=当前用户            |              |
| F7  | 重复 claim          | 已被领取的 task 再 claim            | 409 TASK_ALREADY_CLAIMED          |              |
| F8  | Rebind 任务         | POST /rebind                        | boundPlanVersion 更新             |              |
| F9  | Task Pack           | GET /tasks/:id/pack                 | 含 plan + task 上下文             |              |

## 模块 G: 执行管理 (ExecutionRun)

| ID  | Test Case          | 输入                                                 | 预期输出                 | 边界/异常 |
| --- | ------------------ | ---------------------------------------------------- | ------------------------ | --------- |
| G1  | 创建执行           | POST /runs `{executorType,executorName}`             | 201, status=running      |           |
| G2  | 心跳               | POST /runs/:id?action=heartbeat                      | lastHeartbeatAt 更新     |           |
| G3  | 完成执行 (success) | POST /runs/:id?action=complete `{outcome:"success"}` | run→completed, task→done |           |
| G4  | 完成执行 (failure) | POST /runs/:id?action=complete `{outcome:"failure"}` | run→failed, task→blocked |           |
| G5  | 执行历史列表       | GET /tasks/:id/runs                                  | 200, 分页                |           |

## 模块 H: Drift Engine (核心)

| ID  | Test Case             | 输入                                 | 预期输出                      | 边界/异常 |
| --- | --------------------- | ------------------------------------ | ----------------------------- | --------- |
| H1  | 激活触发 drift 扫描   | v1 有 task → activate v2             | DriftAlert 生成               |           |
| H2  | Severity HIGH         | task 有 running ExecutionRun         | alert.severity=high           |           |
| H3  | Severity MEDIUM       | task status=todo/in_progress/blocked | alert.severity=medium         |           |
| H4  | Severity LOW          | task status=done                     | alert.severity=low            |           |
| H5  | Cancelled 不参与      | task status=cancelled                | 不生成 alert                  |           |
| H6  | 解决 - rebind         | POST /drifts/:id `{action:"rebind"}` | task.boundVersion 更新        |           |
| H7  | 解决 - cancel         | action=cancel                        | task→cancelled, run→cancelled |           |
| H8  | 解决 - no_impact      | action=no_impact                     | alert→resolved                |           |
| H9  | 重复解决              | 已 resolved 再 resolve               | 400/409                       |           |
| H10 | Reactivate 触发 drift | reactivate 旧版本 → 扫描             | drift 正常生成                |           |
| H11 | 首次激活无 drift      | 第一个 plan (无旧 plan)              | 0 alerts                      |           |

## 模块 I: SSE 实时事件

| ID  | Test Case           | 输入                     | 预期输出                | 边界/异常 |
| --- | ------------------- | ------------------------ | ----------------------- | --------- |
| I1  | SSE 连接            | GET /projects/:id/events | 200, text/event-stream  |           |
| I2  | plan_activated 事件 | 激活 plan 后             | SSE 推送 plan_activated |           |
| I3  | drift_detected 事件 | drift 扫描后             | SSE 推送 drift_detected |           |
| I4  | task_created 事件   | 创建 task 后             | SSE 推送                |           |

## 模块 J: Webhook 系统

| ID  | Test Case     | 输入                          | 预期输出                  | 边界/异常      |
| --- | ------------- | ----------------------------- | ------------------------- | -------------- |
| J1  | 注册 webhook  | POST /webhooks `{url,events}` | 201                       | 非 owner → 403 |
| J2  | 列出 webhooks | GET /webhooks                 | 200                       |                |
| J3  | 删除 webhook  | DELETE /webhooks/:id          | 200                       |                |
| J4  | 事件投递      | 触发订阅事件                  | webhook URL 收到 POST     |                |
| J5  | HMAC 签名     | 配置 secret 的 webhook        | X-PlanSync-Signature 正确 |                |

## 模块 K: API Key 认证

| ID  | Test Case       | 输入                             | 预期输出               | 边界/异常 |
| --- | --------------- | -------------------------------- | ---------------------- | --------- |
| K1  | 创建 API key    | POST /auth/api-keys              | 201, 返回 key (仅一次) |           |
| K2  | 用 API key 调用 | Authorization: Bearer ps_key_xxx | 正常访问               |           |
| K3  | 无效 key        | 错误的 key                       | 401                    |           |
| K4  | 删除 key        | DELETE /auth/api-keys/:id        | 200                    |           |

## 模块 L: AI 功能 (双 Provider)

| ID  | Test Case                    | 输入                            | 预期输出                            | 边界/异常 |
| --- | ---------------------------- | ------------------------------- | ----------------------------------- | --------- |
| L1  | AMD provider 选择            | LLM_API_KEY 已设                | provider=amd                        |           |
| L2  | Anthropic provider 选择      | 只设 ANTHROPIC_API_KEY          | provider=anthropic                  |           |
| L3  | 无 key 禁用                  | 两个都不设                      | isAvailable=false                   |           |
| L4  | AMD 优先                     | 两个都设                        | 选 AMD                              |           |
| L5  | 空格 key 处理                | LLM_API_KEY=" "                 | 不选 AMD                            |           |
| L6  | Plan Diff                    | GET /diff?compareWith=          | changes + summary + breakingChanges |           |
| L7  | Diff 缓存                    | 同一 pair 第二次调用            | 从 DB 读取，不再调 LLM              |           |
| L8  | 冲突预测                     | GET /tasks/conflicts (≥2 tasks) | conflicts 数组                      |           |
| L9  | 冲突预测 (<2 tasks)          | 只有 0-1 个 task                | conflicts: []                       |           |
| L10 | Impact Analysis (drift 增强) | 激活新 plan + AI 可用           | drift alerts 含 compatibilityScore  |           |
| L11 | 高兼容自动 no_impact         | compatibilityScore > 70         | 自动 resolved                       |           |
| L12 | extractJson 鲁棒性           | 各种 markdown fence 格式        | 正确提取 JSON                       |           |
| L13 | API 不可用时降级             | LLM API 超时/错误               | 返回 null, 不阻塞                   |           |

## 模块 M: MCP Server Tools

| ID  | Test Case | MCP Tool                    | 预期                 | 边界 |
| --- | --------- | --------------------------- | -------------------- | ---- |
| M1  | 项目状态  | plansync_status             | 完整状态返回         |      |
| M2  | 创建 plan | plansync_plan_create        | plan 创建成功        |      |
| M3  | 激活 plan | plansync_plan_activate      | 触发 drift           |      |
| M4  | 开始任务  | plansync_execution_start    | run 创建 + task pack |      |
| M5  | 完成任务  | plansync_execution_complete | run→completed        |      |
| M6  | Claim     | plansync_task_claim         | assignee 设置        |      |
| M7  | Approve   | plansync_review_approve     | review→approved      |      |
| M8  | Suggest   | plansync_plan_suggest       | suggestion 创建      |      |
| M9  | Rebind    | plansync_task_rebind        | version 更新         |      |

## 模块 N: Wrapper 脚本 (bin/plansync)

| ID  | Test Case           | 输入           | 预期输出                     | 边界/异常 |
| --- | ------------------- | -------------- | ---------------------------- | --------- |
| N1  | 帮助                | --help         | 显示用法                     |           |
| N2  | 未知 host           | --host unknown | 错误退出                     |           |
| N3  | 缺少参数值          | --host (无值)  | 错误: requires a value       |           |
| N4  | Genie 配置注入      | --host genie   | ~/.claude/settings.json 写入 |           |
| N5  | Cursor 配置注入     | --host cursor  | .cursor/mcp.json 写入        |           |
| N6  | CLAUDE.md 注入      | 启动           | CLAUDE.md 包含 PlanSync 指令 |           |
| N7  | API 不可达提示      | API 未启动     | 警告 + 确认                  |           |
| N8  | MCP server 自动构建 | dist/ 不存在   | 自动 npm run build           |           |

## 模块 O: CLI 工具

| ID  | Test Case | 命令                | 预期       |
| --- | --------- | ------------------- | ---------- |
| O1  | Status    | plansync-cli status | 项目状态   |
| O2  | Tasks     | plansync-cli tasks  | 任务列表   |
| O3  | Drift     | plansync-cli drift  | drift 列表 |

## 模块 P: OpenAPI

| ID  | Test Case | 输入                  | 预期            |
| --- | --------- | --------------------- | --------------- |
| P1  | Spec 端点 | GET /api/openapi.json | 200, valid JSON |

---

## 覆盖率统计

| 模块          | Test Cases | 关键路径 | 边界条件 | 错误处理 |
| ------------- | ---------- | -------- | -------- | -------- |
| A: Project    | 6          | ✓        | ✓        | ✓        |
| B: Member     | 7          | ✓        | ✓        | ✓        |
| C: Plan       | 11         | ✓        | ✓        | ✓        |
| D: Suggestion | 10         | ✓        | ✓        | ✓        |
| E: Comment    | 7          | ✓        | ✓        | ✓        |
| F: Task       | 9          | ✓        | ✓        | ✓        |
| G: Execution  | 5          | ✓        | ✓        | ✓        |
| H: Drift      | 11         | ✓        | ✓        | ✓        |
| I: SSE        | 4          | ✓        |          |          |
| J: Webhook    | 5          | ✓        | ✓        | ✓        |
| K: API Key    | 4          | ✓        | ✓        | ✓        |
| L: AI         | 13         | ✓        | ✓        | ✓        |
| M: MCP        | 9          | ✓        |          |          |
| N: Wrapper    | 8          | ✓        | ✓        | ✓        |
| O: CLI        | 3          | ✓        |          |          |
| P: OpenAPI    | 1          | ✓        |          |          |
| **总计**      | **113**    |          |          |          |

---

## 验证执行记录 (2026-03-28)

### 自动化测试结果: 65/65 PASSED (100%)

覆盖 A-L + P 模块共 65 个自动化端到端测试用例。

### 发现并修复的 Bug (3 个)

| Bug       | 严重度 | 描述                                                                                                                                                                                                                 | 修复                                                                                     |
| --------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **BUG-1** | HIGH   | `POST /plans/:id/propose` 忽略 body 中的 `reviewers`，只使用 plan 记录中的 `requiredReviewers`。若创建 plan 时未设置 `requiredReviewers`，propose 时传入 reviewers 被静默丢弃，导致 0 review 被创建，plan 可直接激活 | 修改 `propose/route.ts`：读取 body.reviewers 并优先使用，同时更新 plan.requiredReviewers |
| **BUG-2** | MEDIUM | `DELETE /comments/:id` 只允许评论作者删除，但 PLAN.md 规定 "owner 可删任何人的评论"                                                                                                                                  | 修改 `comments/[commentId]/route.ts`：增加 owner 角色检查                                |
| **BUG-3** | LOW    | `createExecutionRunSchema` 要求 body 中包含 `taskId`，但 taskId 已在 URL path 中，API route 也只使用 `params.taskId`                                                                                                 | 将 schema 中 `taskId` 改为 `z.string().optional()`                                       |

### 验证端点路由映射（与 PLAN.md 差异）

| PLAN.md 规格                              | 实际端点                                                           | 备注               |
| ----------------------------------------- | ------------------------------------------------------------------ | ------------------ |
| `GET /projects/:id/status`                | `GET /projects/:id/dashboard`                                      | 命名差异，功能等价 |
| `POST /plan-suggestions/:id/accept`       | `POST /projects/:pid/plans/:planId/suggestions/:sid?action=accept` | 嵌套路由           |
| `PATCH /plan-comments/:id`                | `PATCH /projects/:pid/plans/:planId/comments/:cid`                 | 嵌套路由           |
| `DELETE /plan-comments/:id`               | `DELETE /projects/:pid/plans/:planId/comments/:cid`                | 嵌套路由           |
| `POST /plan-reviews/:id/approve`          | `POST /projects/:pid/plans/:planId/reviews/:rid?action=approve`    | 嵌套路由           |
| `DELETE /projects/:pid/webhooks/:id`      | `DELETE /webhooks/:id`                                             | 独立路由           |
| `POST /projects/:pid/api-keys`            | `POST /auth/api-keys`                                              | 独立路由           |
| complete body: `outcome: success/failure` | `status: completed/failed`                                         | Schema 字段名差异  |
