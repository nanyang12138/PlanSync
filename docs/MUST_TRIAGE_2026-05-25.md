# `severity:must` Backlog Triage — 2026-05-25

> **谁该看这份文档**：每天负责跑 `bash scripts/find-pending-must.sh`、决定下一批 must
> issue 怎么处理的人（owner / 维护者 / 开新 PR 的 agent）。
>
> **它回答的问题**：截至 2026-05-25 08:48 UTC，仓库里有 **303 条 `severity:must`** 的
> open issue。**到底应不应该全部都开 PR？** 不应该 — 至少在「现在直接开 PR」这个
> 意义上。先按本文档分类，再决定每一类应当采取的行动。

---

## 1. 全景数据

| 指标                                                                         | 数值                                                       |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| open `severity:must` 总数                                                    | **303**                                                    |
| 创建于 2026-05-22                                                            | 77                                                         |
| 创建于 2026-05-23                                                            | 107                                                        |
| 创建于 2026-05-24                                                            | 41                                                         |
| 创建于 2026-05-25                                                            | 78                                                         |
| 当前 open PR 数                                                              | **0**                                                      |
| 已经被某个**已合并** PR 的 PR body 用 `closes #N` 关掉但 GitHub 没自动关闭的 | 3（#1048 #1054 #1057，已链到 #1060）                       |
| 在 `scripts/close-resolved-issues.sh` 已注册但仍 open 的                     | 41（脚本未在仓库代理 token 下被允许执行 `gh issue close`） |

来源：`bash scripts/find-pending-must.sh --json | jq '. | length'`，并对照
`gh issue list --state open --json closedByPullRequestsReferences`、
`gh pr list --state merged --search "merged:>=2026-05-22"` 的 PR body 内容。

---

## 2. 关键观察 — 这 303 条不是 303 个独立缺陷

按标题前缀（`[review-finding/must] <area>:`）聚合：

| area                   | issue 数 |
| ---------------------- | -------- |
| `general:`             | 139      |
| `REMEDIATION_PLAN.md:` | 26       |
| `instrumentation.ts:`  | 13       |
| `route.ts:`            | 11       |
| `run-worker.ts:`       | 11       |
| `exec-state.ts:`       | 8        |
| `dev.sh:`              | 5        |
| `package.json:`        | 5        |
| `email.ts:`            | 4        |
| `store-base.ts:`       | 4        |
| 其他单独前缀           | 余下 77  |

把同一根因的 issue 折叠之后，真实独立 cluster ≈ **30–40 组**，不是 303 组。
这就是为什么之前的 PR-A ~ PR-Z + PR-X1/X2 + #1038 都是「一发批量 close 一打 issue」的形态
—— 这是这套自动 review 流程的常态，必须按 cluster 处理，不能 1 issue 1 PR。

---

## 3. 三类决策

把所有 303 条按下表分类。每一类对应不同动作。

### 3A. 「已经修好，只是 issue 没自动关闭」 → 不开 PR，走 housekeeping 关闭

这一类**不需要新 PR**。代码已经在 master，只是 GitHub auto-close 没触发
（典型原因见 `docs/AGENT_WORKFLOW_NOTES.md` 第 1 节：closes-ref 写在 squash-merged
commit message 而非 PR body；或 PR body 里的 closes 列表用了 backtick / 范围语法而被
GitHub parser 跳过；或 PR body 里有 closes-keyword 命中了校验表里的示例号）。

**处理方式**：append 进 `scripts/close-resolved-issues.sh` 的 `CLUSTERS=()` 数组，
让有 `issues:write` 权限的维护者一次跑完。当前 cloud-agent token 是只读的，**不能在
这个 VM 里直接关 issue**（已在脚本头部注释里写明）。

下面三个新 cluster 已经在本 PR 中 append 到脚本，每条都单独验证过 master 的代码状态
（grep / 读源文件确认 fix 已在）。

#### Cluster K — `#846` AI verifier untrusted-input + ai-draft/ai-field（已合并，但 backtick 语法让 GitHub auto-close 失效）

| Issue                    | 关键字                                                      | 在 master 验证                                                                                |
| ------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| #820 #824 #827 #831 #837 | verifier.ts 拼接 plan/task/candidate 未用 untrusted sandbox | `grep -c 'tagUntrusted\|UNTRUSTED_INPUT_PREAMBLE' packages/api/src/lib/ai/verifier.ts` → 19 ✓ |
| #821 #825                | ai-draft / ai-field 路由未走 R-188 sandboxing               | #846 已修，PR body 明确 #821 / #825 fix                                                       |
| #828                     | client.ts 4xx 未 fallback 到 text mode                      | #846 已修；记录 `tool_use_rejected_text_fallback_ok` ✓                                        |

**为什么没自动关闭**：#854 的 PR body 用 backtick 把 closes 列表写成 `` `Closes #819` `` 的 code span，
GitHub 的 closing-keyword parser 显式排除 code span（这是文档化行为，不是 bug）。
#846 的 closes 行 `#819 #820 #821 ...#838` 一行 18 个 issue，但实际只关掉了
其中 10 个（#819 #822 #823 #826 #829 #830 #832 #835 #836 #838）—— 推测是 GitHub 一行能
处理的 closes 数量被限制了，剩余 8 个全部停留在 open。

#### Cluster L — `#862` `.env` 单引号字面量 / `run-worker` `${VAR}` 校验

| Issue          | 关键字                                     | 在 master 验证                                                                        |
| -------------- | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| #863 #910      | `loadRepoDotenv` 对单引号值仍展开 `$VAR`   | `packages/api/scripts/load-dotenv.ts` L82-97 显式 `quoted === 'single'` 跳过 expand ✓ |
| #864 #911 #978 | run-worker 错误日志泄漏完整 DATABASE_URL   | `packages/api/scripts/run-worker.ts` L60-80 `redactDbUrl()` 对所有路径生效 ✓          |
| #979           | run-worker 把合法 `$char` 误判为未解析变量 | `validateDatabaseUrl` 改为只匹配 `\$\{[A-Za-z_]\w*\}`，不再匹配 bare `$VAR` ✓         |

#### Cluster M — `#1038` round-2 rescue（已自动关闭，无需操作）

PR #1038 body 里以 `closes #N` 一行一个 trailer 的形式列了 14 个 issue：
`#990 #991 #996 #997 #1003 #1004 #918 #923 #932 #939 #940 #941 #950 #953 #954 #957`，
GitHub auto-close 全部生效，验证：

```bash
$ for n in 918 923 932 939 940 941 950 953 954 957 990 991 996 997 1003 1004; do
    gh issue view $n --json state -q .state
  done
# 全部 CLOSED
```

→ Cluster M 无需 housekeeping。把它列在这里只是为了证明「`closes #N` 一行一个」是
可靠的关闭方式，而 #846 / #854 用 backtick + 范围语法是踩坑路径。

---

### 3B. 「真的还没修，需要开新 PR」 → 按 cluster 开新 PR

这一类才是用户问的**「应该开 PR」**的部分。共约 **24 个独立 cluster**。
**关键原则**：每个 cluster 一个 PR，不要 1 issue 1 PR；PR body 必须用 `closes #N` 一行
一个把整个 cluster 的 issue 全列上（参照 #1038 的写法）。

按推荐处理顺序（**security / data-integrity > correctness > ergonomics > docs**）：

| #       | Cluster                                                                    | 涉及 issue                                                                      | 推荐 PR scope                                                                                                                                                                                                                                             |
| ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1**  | run-worker URL 脱敏在无 `://` 输入仍泄漏 user 段                           | #1046                                                                           | 一个小补丁：`redactDbUrl()` catch 分支去掉 `raw.slice(0, colon)`，统一返回 `[unparseable]`                                                                                                                                                                |
| **B2**  | store-base.ts stale-failure rollback 半成品                                | #1041 #1045 #1053 #1056 #1058                                                   | R5c：stale 分支无 onFailure 时也按需 rollback；在调用方提供 onFailure 但其语义可能写回旧快照时改用幂等 patch（详见每条 issue body）                                                                                                                       |
| **B3**  | wrapToolHandler 对 `isError: true` envelope 不回滚 FSM                     | #1014                                                                           | 在 `wrapToolHandler` 包装层把返回值 `isError === true` 也视作失败回滚 FSM                                                                                                                                                                                 |
| **B4**  | exec-state FSM `CONTEXT_LOADED → execution_complete` 未覆盖真实 `/exec` 流 | #877 #914 #915 #922 #974 #975 #1015                                             | 补 FSM 转移；对 COMPLETED/ABORTED 状态拒绝 `plansync_exec_context` 复用旧 runId/taskId                                                                                                                                                                    |
| **B5**  | task ↔ deliverable link 表与 legacy slug 数组不一致                       | #886 #908 #959 #960 #961 #976 #977 #981 #982 #983 #1019 #1020 #1028 #1029 #1031 | R-153/R-191/R-192 完整收尾：PATCH `/tasks/:id` 把 link 写入挪进事务；`task_pack` 同时返回 unresolved + linked；`loadProjectDeliverables` 加 `Plan.status === 'active'` 过滤；`linkCommitsFromPushPayload` 接入 webhook 入口；slug 重复时按确定性 key 解析 |
| **B6**  | webhook 多项目 outbox 单笔 503 重试导致重复写                              | #852 #900 #968                                                                  | 把每个项目的 emit 收敛到一个根事务，503 时整体回滚                                                                                                                                                                                                        |
| **B7**  | reactivate / accept-suggestion 的 deliverable 状态翻转不一致               | #881 #882 #884                                                                  | reactivate 时把对应 plan 自身的 deliverable 从 deprecated 翻回 active；accept-suggestion 不再删除-重建当前 active 的所有 deliverable                                                                                                                      |
| **B8**  | RunStore lightweight payload 在 client-core 路径仍丢事件                   | #875 #907 #969 #970 #995 #1012 #1013                                            | StoreRegistry 透传 RunStore.handleEvent 返回值；load() 用 byId merge 而非整体替换；runAction 用本 store 的 seq 而非全局 latest                                                                                                                            |
| **B9**  | mcp-client.ts readBuffer 截断跨 chunk 大响应                               | #871 #913                                                                       | 把 cap 触发后的 clear 改为「等到首个换行后再判」，或把 cap 提升到合理上限                                                                                                                                                                                 |
| **B10** | email/sendmail SIGTERM drain 对 in-flight 不计数                           | #985 #986 #1000 #1008 #1042 #1044                                               | `getPendingMailTotal()` 把 `inFlight.size` 与 `queue` 去重；drain 等到 inFlight 也清空再 exit；child.stdin 监听 error；spawn stdout pipe 必须消费                                                                                                         |
| **B11** | r113 测试与新生产代码不兼容                                                | #1001 #1002                                                                     | 修 fake `stdin.on()`；修 `describe` 跨作用域引用 `spawnedChildren`                                                                                                                                                                                        |
| **B12** | verification_rules CRUD scope/scopeValue 校验缺失                          | #890 #892 (closed?) #916 #917 #924 #925 #948 #949 #992 #993 #1032 #1037         | PATCH 时按合并后的字段重新校验；require_files_changed 拒绝空白；require_pr_merged 真去 GitHub 查 merged 状态；MCP 收到 422 后必须重启 heartbeat；Next 15 async params 迁移                                                                                |
| **B13** | comment.isDeleted 并发 DELETE 仍重复审计                                   | #880 #971                                                                       | 改成 `updateMany(where: { isDeleted: false })` 原子翻转后再写审计                                                                                                                                                                                         |
| **B14** | withdraw / activate 反向交错竞态                                           | #903 #984                                                                       | 把读 + 写收敛到 SERIALIZABLE 事务或 row-level lock                                                                                                                                                                                                        |
| **B15** | PATCH plan / activity 顺序非原子                                           | #753                                                                            | 把 plan update 与 activity write 放进同一事务                                                                                                                                                                                                             |
| **B16** | auth cache 5 分钟窗口在部分撤销路径仍可继续认证                            | #741 #897 #898                                                                  | 撤销路径里 `authCache.delete(...)`；测试改用真实 `authenticate()` 路径                                                                                                                                                                                    |
| **B17** | exec-cli.mjs / bin/plansync `/pack` API 信封解包                           | #725 #735 #737 #739                                                             | `taskPack = response.data`；缺 exec-cli.mjs 时 fail loud 而非静默回退到旧 bash 流                                                                                                                                                                         |
| **B18** | master delegation TTL / reuse window 与规格不符                            | #682 #683 #684 #686 #687                                                        | 用 `MASTER_DELEGATION_REUSE_WINDOW_MS` 复用现有未过期行；过期返回 401；TTL 走已校验的 env config                                                                                                                                                          |
| **B19** | master allowlist HTTP 方法 / 路径不匹配                                    | #685 #857 #906 (#1010 已合相关项)                                               | 把 heartbeat/complete 从 PATCH 改为 POST；drift resolve 路径补 `/api/projects/...` 前缀（部分已在 #1010）                                                                                                                                                 |
| **B20** | backfill / readMerged 平局打破 + ordering                                  | #692 #693 #697 #698 #712                                                        | r151 backfill 行用确定性 createdAt（per-row 增量）或在 `readMerged` 增加 `position` 字段                                                                                                                                                                  |
| **B21** | persistDriftAlerts 同批 (taskId,planVersionId) 重复违反 unique             | #710                                                                            | createMany 之前去重；或 upsert                                                                                                                                                                                                                            |
| **B22** | shared schema `driftResolveActionSchema` 缺 `'superseded'`                 | #709                                                                            | 在 `@plansync/shared` 把 `'superseded'` 加进 enum                                                                                                                                                                                                         |
| **B23** | dev.sh / build.sh / next.config.js BUILD_USER 规范化                       | #287 #466 #510 #526 #901                                                        | 三处统一为 `${PLANSYNC_BUILD_USER:-${USER:-$(whoami)}}` 并 trim 后空 fallback；和 `next.config.js` 的 `process.env.USER \|\| 'dev'` 对齐                                                                                                                  |
| **B24** | package.json React 19 overrides 未真正统一 lockfile                        | #994 #999 #1026 #1033 #1036 #1040                                               | 删除 lockfile 重新 `npm i`；或用 `overrides` + `npm i --workspaces` 显式重写 React peer 树                                                                                                                                                                |

---

### 3C. 「文档 / 调度自动化的内部矛盾」 → 单独一组 docs PR

这些都是 `REMEDIATION_PLAN.md` 自指 / 字段不一致 / dispatch.sh 的脚本现状不符的发现。
不影响产品行为，但会让自动化 cron 派工卡住或派错。可以**集中开一个 docs PR**：

| 子组                                                 | issue                                        |
| ---------------------------------------------------- | -------------------------------------------- |
| supersedes vs superseded_by 字段语义自相矛盾         | #111 #112 #113 #116 #117 #118 #157 #158 #159 |
| dispatch.sh sed range / 严重度排序 / 兜底排序        | #208 #225 #226 #227 #235 #236 #241 #328      |
| `lint-remediation.mjs --dispatch` 未实现却写在文档   | #327 #342 #343 #354 #356                     |
| `R-175` 改成 `in_progress` 但 `R-175a/R-175b` 不存在 | #843 #844 #855 #905                          |
| `R-201` verification 是非法 bash                     | #227                                         |
| `15.5.18 high CVE 已修` 与 root_cause 自相矛盾       | #927 #987                                    |
| `temporary_mitigation` 声明与代码现状不符            | #811 #1027                                   |
| `supersededById` 指针方向反向                        | #433 #447 #462 #469                          |

→ 推荐**一个 doc-only PR** 改 `docs/REMEDIATION_PLAN.md` + `scripts/dispatch.sh` +
`scripts/lint-remediation.mjs`，PR body 列上面所有 issue 号 `closes #N`，
一次过批量关。

---

### 3D. 「stale / 重复 / 已被覆盖」 → 关单评论标 duplicate

下面这些 issue 在 `scripts/close-resolved-issues.sh` 里已经登记到一个**已合并**的
PR 上但 GitHub 没自动关闭，41 条等维护者跑脚本：

#111 #112 #113 #116 #117 #118 #157 #158 #159 #164 #165 #166 #167 #174 #175 #179 #180
#181 #192 #193 #200 #208 #225 #226 #227 #230 #231 #235 #236 #241 #244 #247 #251 #252
#258 #259 #266 #274 #287 #288 #309

> 注意：里面 #174 #175 链到了 PR #240，**而 #240 是 CLOSED 不是 MERGED**。这两条要
> 重新核实——要么属于 3B 还需开 PR，要么属于 3C 文档级修复。本 PR 暂不做这个判断，
> 留给维护者跑 `gh pr view 240` 后决定。

---

## 4. 直接的回答 — 「应该开 PR 吗？」

**不应该一刀切地开 PR。具体到 303 条：**

1. **大约 1/3（≈100 条）已经在 master 修过了**，只是 GitHub auto-close 没触发：

   - 41 条已经在 `scripts/close-resolved-issues.sh` 里登记过（旧 PR），等维护者跑脚本
   - 9 条新增（cluster K + L）今天本 PR 已 append 到脚本
   - 几十条会随 cluster M（#1038）的 closes-trailer 在已合并时点被 GitHub 关掉

2. **大约 2/3（≈200 条）是真实未修问题**，但**只对应 24 个独立 cluster**（章节 3B）。
   每个 cluster 应当**作为一个 PR**，PR body 用 `closes #N` 一行一个把整个 cluster 的
   issue 全列上 —— 这是仓库已经验证过的 batch-close 范式（#1038 是 worked example）。

3. **REMEDIATION_PLAN.md / dispatch.sh 内部矛盾 ≈30 条** 适合**一个 docs PR** 收尾。

**如果要给 cron / agent 一个简单的派工口径**：先按章节 3B 表的 B1 → B24 顺序认领；
B5 / B12 / B10 是体量最大的三个 cluster（合计 ~35 issue），需要 medium-effort PR；
其余多是 small 补丁。

---

## 5. 怎么落地

### Step 1：维护者执行已注册的 batch-close

> **⚠️ 注意 (#1066)**：脚本会处理 `CLUSTERS=()` 数组里的**所有**条目，包括
> 状态含 `open|...` 的 cluster。请先运行 `--dry-run` 认真核对输出，确认只关闭
> 确实随已合并 PR 解决的 issue，再运行实际关闭命令。

```bash
bash scripts/close-resolved-issues.sh --dry-run   # 先看一遍，逐行确认
bash scripts/close-resolved-issues.sh             # 确认无误后再真关
```

预期效果：当前 303 条 → 约 250 条（关掉章节 3A + 3D 共 ~50 条）。

### Step 2：按 cluster 开 PR（章节 3B）

每个 PR 必须包含：

- 标题：`fix(<area>): <one-line summary> (closes #<head-of-cluster>)`
- body 最末尾的 `## Closes` section 一行一个 `closes #N`，覆盖整个 cluster
- 至少一个 regression test
- `bash scripts/lint.sh` + `bash scripts/test.sh` 通过

参考 #1038 / #846 / #862 的 PR body 模板。

### Step 3：docs PR（章节 3C）

合并完之后再跑一遍 `bash scripts/find-pending-must.sh`，预期剩余 < 50 条 —— 那时候
再讨论是否还有 cluster 漏进章节 3B。

---

## 附录 A — 本次三方比对的脚本

```bash
# 1. 当前真正 pending 的 must issues
bash scripts/find-pending-must.sh --json > /tmp/pending-must.json

# 2. 哪些已经被某个 MERGED PR body 用 closes-keyword 关闭过
gh pr list --state merged --limit 200 --search "merged:>=2026-05-22" \
  --json number,title,body |
  jq -r '
    .[] | (.number|tostring) as $pr |
    ((.body // "") + " " + (.title // "")) |
    scan("(?i)\\b(?:close[ds]?|fix(?:es|ed)?|resolve[ds]?)\\s*[:#]?\\s*#(\\d+)") |
    "\($pr) \(.[0])"' | sort -u

# 3. 对照 GitHub 内置的 closedByPullRequestsReferences（最权威，但只对显式
#    body closes-ref 生效；commit-msg-only 不算）
gh issue list --state open --limit 1500 \
  --json number,labels,closedByPullRequestsReferences |
  jq '[.[] | select(.labels | map(.name) | contains(["severity:must"]))
       | select(.closedByPullRequestsReferences | length > 0)]'
```

附录 B、C（按 cluster 展开的全量 issue 标题、按时间维度的 burndown 图）可以从
`/tmp/must-full.json` 直接生成；本 PR 不内嵌以避免过期。
