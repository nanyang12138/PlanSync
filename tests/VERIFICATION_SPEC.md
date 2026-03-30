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
| A6  | 聚合状态   | GET /projects/:id/dashboard         | 200, 含 plan+tasks+drift |                    |

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

| ID  | Test Case                   | 输入                                    | 预期输出                         | 边界/异常                      |
| --- | --------------------------- | --------------------------------------- | -------------------------------- | ------------------------------ |
| C1  | 创建 plan                   | POST /plans `{title,goal,scope,...}`    | 201, status=draft, version 自增  |                                |
| C2  | 编辑 draft                  | PATCH /plans/:id `{goal:...}`           | 200                              | 非 draft → 400; 非 owner → 403 |
| C3  | 无 reviewer 直接激活        | draft → activate (无 requiredReviewers) | plan.status=active               |                                |
| C4  | 提交审批                    | POST /propose `{reviewers}`             | status=proposed, PlanReview 创建 | 非 owner → 403                 |
| C5  | 审批 - approve              | POST /reviews/:id?action=approve        | review.status=approved           |                                |
| C6  | 审批 - reject               | POST /reviews/:id?action=reject         | review.status=rejected           |                                |
| C7  | 未全部审批就激活            | activate with pending reviews           | 400 "not all approved"           |                                |
| C8  | 全部审批后激活              | activate after all approved             | plan.status=active               |                                |
| C9  | 单 active 约束              | 激活 v2 时 v1 → superseded              | 同时只有 1 个 active             |                                |
| C10 | 回滚 reactivate             | POST /reactivate on superseded plan     | 重新变为 active                  | 非 superseded → 400            |
| C11 | Active plan 查询            | GET /plans/active                       | 返回当前 active plan             | 无 active → null/404           |
| C12 | Version 自增验证            | 同 project 连续创建 3 个 plan           | version 依次为 1, 2, 3           |                                |
| C13 | 获取指定 plan 详情          | GET /plans/:planId                      | 200, 返回完整 plan 数据          | 不存在 → 404                   |
| C14 | Plan 列表分页               | GET /plans?page=1&pageSize=10           | 200, 分页数据                    |                                |
| C15 | 编辑 proposed plan          | PATCH proposed 状态的 plan              | 400 (内容不可变)                 |                                |
| C16 | 编辑 active/superseded plan | PATCH active 或 superseded plan         | 400 (内容不可变)                 |                                |

## 模块 D: 建议系统 (Suggestion)

| ID  | Test Case                 | 输入                                                  | 预期输出                        | 边界/异常      |
| --- | ------------------------- | ----------------------------------------------------- | ------------------------------- | -------------- |
| D1  | 提交 set 建议             | `{field:"goal",action:"set",value,reason}`            | 201                             |                |
| D2  | 提交 append 建议          | `{field:"constraints",action:"append",value,reason}`  | 201                             |                |
| D3  | 提交 remove 建议          | `{field:"deliverables",action:"remove",value,reason}` | 201                             |                |
| D4  | 非 draft/proposed 拒绝    | 对 active plan 提 suggestion                          | 400                             |                |
| D5  | accept set 建议           | POST /:id?action=accept                               | plan 对应字段被替换             | 非 owner → 403 |
| D6  | accept append 建议        | accept append                                         | 数组新增元素                    |                |
| D7  | reject 建议               | POST /:id?action=reject                               | status=rejected                 |                |
| D8  | field 验证                | 非法 field (e.g. "title")                             | 400 VALIDATION                  |                |
| D9  | action/field 交叉验证     | set on array field / append on string field           | 正确处理                        |                |
| D10 | reason 必填               | 缺少 reason                                           | 400                             |                |
| D11 | 冲突检测 (set 同字段)     | accept 第 1 个 set suggestion 后，同字段第 2 个       | 第 2 个自动标记 status=conflict |                |
| D12 | 对 superseded plan 提建议 | 对 superseded 状态 plan 提 suggestion                 | 400 (只有 draft/proposed 可提)  |                |
| D13 | accept/reject 附 comment  | accept 时传 resolvedComment                           | resolvedComment 字段被保存      |                |

## 模块 E: 评论系统 (Comment)

| ID  | Test Case              | 输入                                | 预期输出                       | 边界/异常    |
| --- | ---------------------- | ----------------------------------- | ------------------------------ | ------------ |
| E1  | 发表评论               | POST /comments `{content}`          | 201                            |              |
| E2  | 回复评论               | POST /comments `{content,parentId}` | 201, parentId 关联             |              |
| E3  | 列出评论               | GET /comments                       | 200, 含子回复                  |              |
| E4  | 编辑自己的             | PATCH /comments/:id `{content}`     | 200                            | 别人的 → 403 |
| E5  | 删除自己的             | DELETE /comments/:id                | 软删除                         |              |
| E6  | Owner 删别人的         | DELETE (owner 删 developer 评论)    | 200                            |              |
| E7  | 任何 plan 状态可评论   | 对 active/superseded plan 评论      | 201                            |              |
| E8  | 软删除后 content 清空  | DELETE 后查询该评论                 | isDeleted=true, content=""     |              |
| E9  | 父评论删除后子回复保留 | 删除有子回复的父评论后列出          | 父评论显示占位, 子回复正常返回 |              |
| E10 | content 长度限制       | content 超过 2000 字符              | 400 VALIDATION                 |              |

## 模块 F: 任务生命周期 (Task)

状态机: `todo → in_progress → done/blocked/cancelled`

| ID  | Test Case                          | 输入                                              | 预期输出                            | 边界/异常      |
| --- | ---------------------------------- | ------------------------------------------------- | ----------------------------------- | -------------- |
| F1  | 创建任务                           | POST /tasks `{title,type,priority}`               | 201, 自动绑定 active plan version   |                |
| F2  | 无 active plan 创建                | 没有 active plan 时创建 task                      | 400 PLAN_NOT_ACTIVE                 |                |
| F3  | type 枚举                          | code/research/design/bug/refactor                 | 各值通过                            | 非法值 → 400   |
| F4  | priority 枚举                      | p0/p1/p2                                          | 各值通过                            | 非法值 → 400   |
| F5  | 列出任务                           | GET /tasks?status=&assignee=                      | 200, 支持筛选                       |                |
| F6  | Claim 任务                         | POST /claim `{assigneeType}`                      | 200, assignee=当前用户              |                |
| F7  | 重复 claim                         | 已被领取的 task 再 claim                          | 409 TASK_ALREADY_CLAIMED            |                |
| F8  | Rebind 任务                        | POST /rebind                                      | boundPlanVersion 更新               |                |
| F9  | Task Pack                          | GET /tasks/:id/pack                               | 含 plan + task 上下文               |                |
| F10 | 合法状态转换                       | todo→in_progress→done                             | 每步 200, status 正确更新           |                |
| F11 | 非法状态转换                       | todo→done (跳过 in_progress)                      | 400 STATE_CONFLICT                  |                |
| F12 | 更新任务字段                       | PATCH /tasks/:id `{title,priority}`               | 200, 字段已更新                     |                |
| F13 | assigneeType 验证                  | human/agent/unassigned                            | 各值通过                            | 非法值 → 400   |
| F14 | Agent 专用字段                     | 创建含 agentContext/expectedOutput                | 201, 字段已保存                     |                |
| F15 | 任务列表筛选                       | GET /tasks?status=todo&assignee=Alice             | 200, 仅返回匹配结果                 |                |
| F16 | 创建 task 带非成员 assignee        | POST /tasks `{assignee:"NotAMember"}`             | 400 BAD_REQUEST                     |                |
| F17 | 创建 task 带合法成员 assignee      | POST /tasks `{assignee:"Alice"}`（Alice 是成员）  | 201, assignee=Alice, status=todo    |                |
| F18 | 创建带 assignee 触发 task_assigned | 创建 task 带 assignee 后监听 SSE                  | SSE/Webhook 推送 task_assigned      |                |
| F19 | Claim 已有 assignee 的 task        | task 已 assignee=Alice，Bob claim                 | 409 TASK_ALREADY_CLAIMED            |                |
| F20 | Claim startImmediately=false       | POST /claim `{startImmediately:false}`            | assignee 设置但 status 保持 todo    |                |
| F21 | Decline task                       | POST /decline（当前 assignee）                    | assignee=null, task_unassigned 事件 |                |
| F22 | 非 assignee 本人 decline           | POST /decline（非当前 assignee）                  | 403 FORBIDDEN                       |                |
| F23 | Decline 非 todo 状态 task          | POST /decline（task status=in_progress）          | 400 STATE_CONFLICT                  |                |
| F24 | PATCH 重新分配 assignee            | PATCH /tasks/:id `{assignee:"Bob"}`（Bob 是成员） | 200 + task_assigned 事件            |                |
| F25 | PATCH 清空 assignee                | PATCH /tasks/:id `{assignee:null}`                | 200 + task_unassigned 事件          |                |
| F26 | 状态机合法转换                     | todo→in_progress→done                             | 每步 200, status 正确更新           |                |
| F27 | 状态机非法转换 (跳过)              | todo→done (跳过 in_progress)                      | 400 STATE_CONFLICT                  |                |
| F28 | 状态机非法转换 (逆向)              | done→todo                                         | 400 STATE_CONFLICT                  |                |
| F29 | DELETE task (owner)                | DELETE /tasks/:id（owner 角色）                   | 200, deleted:true                   | 非 owner → 403 |
| F30 | DELETE task (developer)            | DELETE /tasks/:id（developer 角色）               | 403 FORBIDDEN                       |                |

## 模块 G: 执行管理 (ExecutionRun)

| ID  | Test Case                 | 输入                                                  | 预期输出                           | 边界/异常 |
| --- | ------------------------- | ----------------------------------------------------- | ---------------------------------- | --------- |
| G1  | 创建执行                  | POST /runs `{executorType,executorName}`              | 201, status=running                |           |
| G2  | 心跳                      | POST /runs/:id?action=heartbeat                       | lastHeartbeatAt 更新               |           |
| G3  | 完成执行 (success)        | POST /runs/:id?action=complete `{status:"completed"}` | run→completed, task→done           |           |
| G4  | 完成执行 (failure)        | POST /runs/:id?action=complete `{status:"failed"}`    | run→failed, task→blocked           |           |
| G5  | 执行历史列表              | GET /tasks/:id/runs                                   | 200, 分页                          |           |
| G6  | 心跳扫描: 5min → stale    | run 的 lastHeartbeatAt 超过 5 分钟                    | status 变为 stale                  |           |
| G7  | 心跳扫描: 30min → failed  | stale 的 run 超过 30 分钟无心跳                       | status 变为 failed                 |           |
| G8  | 非 running 心跳           | 对 stale/completed/failed 的 run 发 heartbeat         | 400 STATE_CONFLICT                 |           |
| G9  | 非 running 完成           | 对 stale/completed/failed 的 run 发 complete          | 400 STATE_CONFLICT                 |           |
| G10 | taskPackSnapshot 自动填充 | 创建 ExecutionRun 时                                  | taskPackSnapshot 含 plan+task 数据 |           |

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

event-bus.ts 定义 17 种事件类型: plan_created, plan_proposed, plan_activated, plan_draft_updated, drift_detected, drift_resolved, task_created, task_assigned, task_unassigned, task_started, task_completed, execution_stale, suggestion_created, suggestion_resolved, comment_added, member_added, member_removed

| ID  | Test Case                 | 输入                                | 预期输出                                  | 边界/异常 |
| --- | ------------------------- | ----------------------------------- | ----------------------------------------- | --------- |
| I1  | SSE 连接                  | GET /projects/:id/events            | 200, text/event-stream                    |           |
| I2  | plan_activated 事件       | 激活 plan 后                        | SSE 推送 plan_activated                   |           |
| I3  | drift_detected 事件       | drift 扫描后                        | SSE 推送 drift_detected                   |           |
| I4  | task_created 事件         | 创建 task 后                        | SSE 推送 task_created                     |           |
| I5  | task_started 事件         | 创建 ExecutionRun 后                | SSE 推送 task_started                     |           |
| I6  | task_completed 事件       | 完成 ExecutionRun 后                | SSE 推送 task_completed                   |           |
| I7  | task_assigned 事件        | claim task 后                       | SSE 推送 task_assigned                    |           |
| I8  | suggestion_created 事件   | 提交 suggestion 后                  | SSE 推送 suggestion_created               |           |
| I9  | suggestion_resolved 事件  | accept/reject suggestion 后         | SSE 推送 suggestion_resolved              |           |
| I10 | comment_added 事件        | 发表评论后                          | SSE 推送 comment_added                    |           |
| I11 | member_added 事件         | 添加成员后                          | SSE 推送 member_added                     |           |
| I12 | execution_stale 事件      | 心跳扫描标记 stale 后               | SSE 推送 execution_stale                  |           |
| I13 | SSE 连接上限              | 超过 MAX_SSE_CLIENTS=1000 个连接    | 503 拒绝新连接                            |           |
| I14 | SSE query param 认证      | GET /events?token=xxx&user=Alice    | 200, 正常连接 (EventSource 不支持 header) |           |
| I15 | SSE 项目隔离              | 项目 A 的 SSE 客户端                | 不收到项目 B 的事件                       |           |
| I16 | plan_draft_updated 事件   | 编辑 draft plan 后                  | SSE 推送 plan_draft_updated               |           |
| I17 | drift_resolved 事件       | 解决 drift alert 后                 | SSE 推送 drift_resolved                   |           |
| I18 | member_removed 事件       | 移除成员后                          | SSE 推送 member_removed                   |           |
| I19 | task_unassigned 事件      | decline task 或 PATCH assignee=null | SSE 推送 task_unassigned                  |           |
| I20 | 创建时 task_assigned 事件 | POST /tasks 带 assignee             | SSE 推送 task_assigned（创建时）          |           |

## 模块 J: Webhook 系统

| ID  | Test Case            | 输入                          | 预期输出                     | 边界/异常      |
| --- | -------------------- | ----------------------------- | ---------------------------- | -------------- |
| J1  | 注册 webhook         | POST /webhooks `{url,events}` | 201                          | 非 owner → 403 |
| J2  | 列出 webhooks        | GET /webhooks                 | 200                          |                |
| J3  | 删除 webhook         | DELETE /webhooks/:id          | 200                          |                |
| J4  | 事件投递             | 触发订阅事件                  | webhook URL 收到 POST        |                |
| J5  | HMAC 签名            | 配置 secret 的 webhook        | X-PlanSync-Signature 正确    |                |
| J6  | 投递日志             | GET /webhooks/:id/deliveries  | 200, 返回投递记录列表        |                |
| J7  | 手动测试投递         | POST /webhooks/:id/test       | webhook URL 收到测试 payload |                |
| J8  | Slack URL 自动格式化 | url 含 hooks.slack.com        | payload 自动转为 Block Kit   |                |
| J9  | 重试机制             | 首次投递 5xx 失败             | 按 1s→5s→30s 间隔重试共 3 次 |                |
| J10 | 4xx 不重试           | 投递返回 400/404              | 不触发重试，直接记录失败     |                |
| J11 | events 数组验证      | 注册时传非法事件名            | 400 VALIDATION               |                |

## 模块 K: API Key 认证

| ID  | Test Case           | 输入                             | 预期输出                  | 边界/异常 |
| --- | ------------------- | -------------------------------- | ------------------------- | --------- |
| K1  | 创建 API key        | POST /auth/api-keys              | 201, 返回 key (仅一次)    |           |
| K2  | 用 API key 调用     | Authorization: Bearer ps_key_xxx | 正常访问                  |           |
| K3  | 无效 key            | 错误的 key                       | 401                       |           |
| K4  | 删除 key            | DELETE /auth/api-keys/:id        | 200                       |           |
| K5  | Key prefix 标识     | 创建 key 后查看                  | 返回 keyPrefix (前 15 位) |           |
| K6  | lastUsedAt 自动更新 | 使用 API key 调用一次 API        | key 的 lastUsedAt 被更新  |           |
| K7  | permissions 字段    | 创建 key 时指定 permissions      | permissions 数组被保存    |           |

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

当前 MCP Server 注册 43 个工具（含新增 plansync_task_decline），按功能分组验证。

### M-Project: 项目管理工具

| ID  | Test Case | MCP Tool                | 预期                         | 边界       |
| --- | --------- | ----------------------- | ---------------------------- | ---------- |
| M1  | 创建项目  | plansync_project_create | project 创建, 自动成为 owner |            |
| M2  | 列出项目  | plansync_project_list   | 返回项目列表                 |            |
| M3  | 查看项目  | plansync_project_show   | 返回项目详情                 | 不存在报错 |
| M4  | 切换项目  | plansync_project_switch | 本地活动项目切换             |            |
| M5  | 更新项目  | plansync_project_update | 项目信息更新                 |            |

### M-Member: 成员管理工具

| ID  | Test Case | MCP Tool               | 预期                | 边界            |
| --- | --------- | ---------------------- | ------------------- | --------------- |
| M6  | 添加成员  | plansync_member_add    | 成员创建            | 非 owner → 错误 |
| M7  | 列出成员  | plansync_member_list   | 返回成员列表 + 角色 |                 |
| M8  | 修改角色  | plansync_member_update | 角色已更新          |                 |
| M9  | 移除成员  | plansync_member_remove | 成员已移除          |                 |

### M-Plan: 计划管理工具

| ID  | Test Case   | MCP Tool                 | 预期                 | 边界             |
| --- | ----------- | ------------------------ | -------------------- | ---------------- |
| M10 | 列出 plan   | plansync_plan_list       | 返回所有版本         |                  |
| M11 | 查看 plan   | plansync_plan_show       | 返回 plan 详情       |                  |
| M12 | 查看 active | plansync_plan_active     | 返回当前 active plan | 无 active → 提示 |
| M13 | 创建 plan   | plansync_plan_create     | plan 创建成功        |                  |
| M14 | 编辑 plan   | plansync_plan_update     | draft 内容已更新     | 非 draft → 错误  |
| M15 | 提交审批    | plansync_plan_propose    | status→proposed      | 非 owner → 错误  |
| M16 | 激活 plan   | plansync_plan_activate   | 触发 drift           |                  |
| M17 | 回滚 plan   | plansync_plan_reactivate | superseded→active    |                  |
| M18 | 批准审批    | plansync_review_approve  | review→approved      |                  |
| M19 | 拒绝审批    | plansync_review_reject   | review→rejected      |                  |

### M-Suggestion: 建议工具

| ID  | Test Case | MCP Tool                    | 预期               | 边界 |
| --- | --------- | --------------------------- | ------------------ | ---- |
| M20 | 提交建议  | plansync_plan_suggest       | suggestion 创建    |      |
| M21 | 列出建议  | plansync_suggestion_list    | 返回建议列表       |      |
| M22 | 处理建议  | plansync_suggestion_resolve | accept/reject 成功 |      |

### M-Comment: 评论工具

| ID  | Test Case | MCP Tool                | 预期          | 边界        |
| --- | --------- | ----------------------- | ------------- | ----------- |
| M23 | 列出评论  | plansync_comment_list   | 返回评论+回复 |             |
| M24 | 创建评论  | plansync_comment_create | 评论已发布    |             |
| M25 | 编辑评论  | plansync_comment_edit   | 内容已更新    | 别人的→错误 |
| M26 | 删除评论  | plansync_comment_delete | 软删除        |             |

### M-Task: 任务工具

| ID  | Test Case | MCP Tool             | 预期                      | 边界 |
| --- | --------- | -------------------- | ------------------------- | ---- |
| M27 | 列出任务  | plansync_task_list   | 返回任务列表              |      |
| M28 | 查看任务  | plansync_task_show   | 返回任务详情 + drift 状态 |      |
| M29 | 创建任务  | plansync_task_create | 自动绑定 active plan      |      |
| M30 | 更新任务  | plansync_task_update | 字段已更新                |      |
| M31 | 领取任务  | plansync_task_claim  | assignee=当前用户         |      |
| M32 | Task Pack | plansync_task_pack   | 返回 plan+task 完整上下文 |      |

### M-Execution: 执行工具

| ID  | Test Case | MCP Tool                    | 预期                 | 边界 |
| --- | --------- | --------------------------- | -------------------- | ---- |
| M33 | 开始执行  | plansync_execution_start    | run 创建 + task pack |      |
| M34 | 完成执行  | plansync_execution_complete | run→completed        |      |

### M-Status: 状态查看工具

| ID  | Test Case  | MCP Tool               | 预期                   | 边界 |
| --- | ---------- | ---------------------- | ---------------------- | ---- |
| M35 | 项目状态   | plansync_status        | 完整状态返回           |      |
| M36 | 活跃执行人 | plansync_who           | 返回正在执行的人/agent |      |
| M37 | 活动日志   | plansync_activity_list | 返回最近活动           |      |

### M-Drift: Drift 工具

| ID  | Test Case                    | MCP Tool                      | 预期                                 | 边界 |
| --- | ---------------------------- | ----------------------------- | ------------------------------------ | ---- |
| M38 | Drift 列表                   | plansync_drift_list           | 返回 drift alerts                    |      |
| M39 | 解决 drift                   | plansync_drift_resolve        | alert→resolved                       |      |
| M40 | Rebind 任务                  | plansync_task_rebind          | version 更新                         |      |
| M41 | 冲突检查                     | plansync_check_task_conflicts | 返回冲突预测                         |      |
| M42 | 重新分配 assignee            | plansync_task_update          | assignee 已更新 + task_assigned 事件 |      |
| M43 | 拒绝分配                     | plansync_task_decline         | assignee 清空 + task_unassigned 事件 |      |
| M44 | Claim startImmediately=false | plansync_task_claim           | assignee 已设置但 status=todo        |      |

## 模块 N: Wrapper 脚本 (bin/plansync)

| ID  | Test Case           | 输入           | 预期输出                     | 边界/异常 |
| --- | ------------------- | -------------- | ---------------------------- | --------- |
| N1  | 帮助                | --help         | 显示用法                     |           |
| N2  | 未知 host           | --host unknown | 错误退出                     |           |
| N3  | 缺少参数值          | --host (无值)  | 错误: requires a value       |           |
| N4  | Genie 配置注入      | --host genie   | genie scheme 配置写入        |           |
| N5  | Cursor 配置注入     | --host cursor  | .cursor/mcp.json 写入        |           |
| N6  | CLAUDE.md 注入      | 启动           | CLAUDE.md 包含 PlanSync 指令 |           |
| N7  | API 不可达提示      | API 未启动     | 警告 + 确认                  |           |
| N8  | MCP server 自动构建 | dist/ 不存在   | 自动 npm run build           |           |

## 模块 O: CLI 工具 (plansync-cli)

| ID  | Test Case     | 命令                       | 预期             | 边界/异常 |
| --- | ------------- | -------------------------- | ---------------- | --------- |
| O1  | Status        | plansync-cli status        | 项目状态         |           |
| O2  | Tasks         | plansync-cli tasks         | 任务列表         |           |
| O3  | Drift list    | plansync-cli drift         | drift 列表       |           |
| O4  | Drift resolve | plansync-cli drift resolve | drift 解决       |           |
| O5  | Plan show     | plansync-cli plan show     | 当前 plan 详情   |           |
| O6  | 无 project    | 未设 PLANSYNC_PROJECT 运行 | 报错提示设置项目 |           |

## 模块 P: OpenAPI

| ID  | Test Case | 输入                  | 预期            |
| --- | --------- | --------------------- | --------------- |
| P1  | Spec 端点 | GET /api/openapi.json | 200, valid JSON |

## 模块 Q: Activity 事件流

PLAN.md 定义了 Activity 数据模型 + `GET /api/projects/:id/activities?limit=` 端点 + 16 种事件类型。

| ID  | Test Case               | 输入                               | 预期输出                                         | 边界/异常 |
| --- | ----------------------- | ---------------------------------- | ------------------------------------------------ | --------- |
| Q1  | plan 操作写入 Activity  | 创建/激活 plan                     | Activity 记录 type=plan_created/plan_activated   |           |
| Q2  | task 操作写入 Activity  | 创建/完成 task                     | Activity 记录 type=task_created/task_completed   |           |
| Q3  | drift 操作写入 Activity | drift 扫描/解决                    | Activity 记录 type=drift_detected/drift_resolved |           |
| Q4  | 列出 Activity           | GET /activities                    | 200, 返回 Activity 列表                          |           |
| Q5  | limit 参数              | GET /activities?limit=5            | 最多返回 5 条                                    |           |
| Q6  | actorType 正确性        | 人类操作 vs agent 操作 vs 系统操作 | actorType 分别为 human/agent/system              |           |
| Q7  | Activity 数据完整性     | 查看单条 Activity                  | 含 type, actorName, summary, metadata            |           |

## 模块 R: Health Check

| ID  | Test Case       | 输入            | 预期输出                                         | 边界/异常 |
| --- | --------------- | --------------- | ------------------------------------------------ | --------- |
| R1  | 健康检查        | GET /api/health | 200, `{status:"ok", database:"connected"}`       |           |
| R2  | 数据库断开降级  | DB 不可用时     | 503, `{status:"error", database:"disconnected"}` |           |
| R3  | sseClients 计数 | 有 SSE 连接时   | sseClients 字段返回正确连接数                    |           |

## 模块 S: Auth 中间件 (身份与权限)

PLAN.md 描述了多层认证机制，代码 `auth.ts` 实现了 PLANSYNC_SECRET bearer token、API Key、AUTH_DISABLED 模式、query param 认证。

| ID  | Test Case               | 输入                                       | 预期输出                           | 边界/异常 |
| --- | ----------------------- | ------------------------------------------ | ---------------------------------- | --------- |
| S1  | PLANSYNC_SECRET 认证    | Authorization: Bearer <PLANSYNC_SECRET>    | 200, 正常访问                      |           |
| S2  | 无 Authorization header | 不传 Authorization                         | 401 UNAUTHORIZED                   |           |
| S3  | 无效 token              | Authorization: Bearer wrong-token          | 401 UNAUTHORIZED                   |           |
| S4  | 缺少 X-User-Name        | 有效 token 但不传 X-User-Name              | 401 "Missing X-User-Name header"   |           |
| S5  | AUTH_DISABLED=true 模式 | AUTH_DISABLED=true, 不传 token             | 200, 使用 X-User-Name 或 anonymous |           |
| S6  | Query param 认证        | GET /events?token=xxx&user=Alice           | 200, userName=Alice                |           |
| S7  | 非项目成员访问          | X-User-Name: NotAMember                    | 403 FORBIDDEN                      |           |
| S8  | developer 做 owner 操作 | developer 尝试 activate plan               | 403 FORBIDDEN                      |           |
| S9  | API Key 认证流程        | Authorization: Bearer ps_key_xxx           | 200, 自动识别为 API Key 认证       |           |
| S10 | 身份绑定验证            | owner 添加 name=Alice, Alice 用 Alice 登录 | Alice 可正常访问项目数据           |           |
| S11 | 身份不匹配              | owner 添加 name=Alice, Bob 用 Bob 登录     | Bob 无法访问 (非成员 403)          |           |

## 模块 T: 统一错误响应格式

PLAN.md 定义了统一错误格式 `{error: {code, message, status, details}}`。ErrorCode 枚举包含: BAD_REQUEST, VALIDATION_ERROR, UNAUTHORIZED, FORBIDDEN, NOT_FOUND, CONFLICT, STATE_CONFLICT, UNPROCESSABLE, INTERNAL。

| ID  | Test Case             | 输入                            | 预期输出                                                | 边界/异常 |
| --- | --------------------- | ------------------------------- | ------------------------------------------------------- | --------- |
| T1  | ZodError → VALIDATION | 提交不合法 body (缺必填字段)    | 400, `{error:{code:"VALIDATION_ERROR", details:[...]}}` |           |
| T2  | AppError → 对应状态码 | 触发 NOT_FOUND (查不存在的资源) | 404, `{error:{code:"NOT_FOUND", message:...}}`          |           |
| T3  | CONFLICT 错误         | 重复创建同名项目                | 409, `{error:{code:"CONFLICT"}}`                        |           |
| T4  | STATE_CONFLICT 错误   | 非法状态转换                    | 409, `{error:{code:"STATE_CONFLICT"}}`                  |           |
| T5  | FORBIDDEN 错误        | developer 做 owner 操作         | 403, `{error:{code:"FORBIDDEN"}}`                       |           |
| T6  | 错误响应结构一致性    | 各种错误情况                    | 所有错误响应都包含 error.code + error.message           |           |

## 模块 U: 环境变量校验 (env.ts)

API 启动时通过 Zod schema 校验环境变量。

| ID  | Test Case              | 输入                     | 预期输出                               | 边界/异常 |
| --- | ---------------------- | ------------------------ | -------------------------------------- | --------- |
| U1  | 缺少 DATABASE_URL      | 不设 DATABASE_URL        | 启动失败, 报告缺失                     |           |
| U2  | DATABASE_URL 格式错误  | DATABASE_URL=mysql://... | 启动失败, 必须以 postgresql:// 开头    |           |
| U3  | PLANSYNC_SECRET 默认值 | 不设 PLANSYNC_SECRET     | 使用默认值 "dev-secret"                |           |
| U4  | LOG_LEVEL 枚举验证     | LOG_LEVEL=invalid        | 启动失败, 只接受 debug/info/warn/error |           |
| U5  | PORT 默认值            | 不设 PORT                | 默认 3001                              |           |

---

## 覆盖率统计

| 模块            | Test Cases | 关键路径 | 边界条件 | 错误处理 |
| --------------- | ---------- | -------- | -------- | -------- |
| A: Project      | 6          | ✓        | ✓        | ✓        |
| B: Member       | 7          | ✓        | ✓        | ✓        |
| C: Plan         | 16         | ✓        | ✓        | ✓        |
| D: Suggestion   | 13         | ✓        | ✓        | ✓        |
| E: Comment      | 10         | ✓        | ✓        | ✓        |
| F: Task         | 30         | ✓        | ✓        | ✓        |
| G: Execution    | 10         | ✓        | ✓        | ✓        |
| H: Drift        | 11         | ✓        | ✓        | ✓        |
| I: SSE          | 20         | ✓        | ✓        | ✓        |
| J: Webhook      | 11         | ✓        | ✓        | ✓        |
| K: API Key      | 7          | ✓        | ✓        | ✓        |
| L: AI           | 13         | ✓        | ✓        | ✓        |
| M: MCP Server   | 44         | ✓        | ✓        | ✓        |
| N: Wrapper      | 8          | ✓        | ✓        | ✓        |
| O: CLI          | 6          | ✓        | ✓        | ✓        |
| P: OpenAPI      | 1          | ✓        |          |          |
| Q: Activity     | 7          | ✓        | ✓        |          |
| R: Health Check | 3          | ✓        | ✓        |          |
| S: Auth 中间件  | 11         | ✓        | ✓        | ✓        |
| T: 错误响应格式 | 6          | ✓        | ✓        | ✓        |
| U: 环境变量校验 | 5          | ✓        | ✓        | ✓        |
| **总计**        | **244**    |          |          |          |

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

| PLAN.md 规格                          | 实际端点                                                           | 备注                |
| ------------------------------------- | ------------------------------------------------------------------ | ------------------- |
| `GET /projects/:id/status`            | `GET /projects/:id/dashboard`                                      | 命名差异，功能等价  |
| `POST /plan-suggestions/:id/accept`   | `POST /projects/:pid/plans/:planId/suggestions/:sid?action=accept` | 嵌套路由            |
| `PATCH /plan-comments/:id`            | `PATCH /projects/:pid/plans/:planId/comments/:cid`                 | 嵌套路由            |
| `DELETE /plan-comments/:id`           | `DELETE /projects/:pid/plans/:planId/comments/:cid`                | 嵌套路由            |
| `POST /plan-reviews/:id/approve`      | `POST /projects/:pid/plans/:planId/reviews/:rid?action=approve`    | 嵌套路由            |
| `DELETE /projects/:pid/webhooks/:id`  | `DELETE /webhooks/:id`                                             | 独立路由            |
| `POST /projects/:pid/api-keys`        | `POST /auth/api-keys`                                              | 独立路由            |
| `POST /runs/:id/complete {outcome}`   | `POST /runs/:id?action=complete {status: completed/failed}`        | 字段名+传参方式差异 |
| `POST /drift-alerts/:alertId/resolve` | `POST /projects/:pid/drifts/:driftId`                              | 嵌套路由            |
| `POST /runs/:runId/heartbeat`         | `POST /runs/:runId?action=heartbeat`                               | query action 模式   |
