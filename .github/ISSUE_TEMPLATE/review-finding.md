---
name: Review finding (manual)
about: 手动登记一条来自 PR 评审 / 静态分析 / cursor-review 的待修问题
title: '[review-finding/<must|should>] <file>: <one-line summary>'
labels: review-finding
---

<!-- review-triage-fp: <fill if migrating from triage; else leave blank> -->

**Severity**: must / should
**Source**: PR #<n> · cursor-review / human review / lint
**File**: `path/to/file`:<line>
**Category**: correctness / security / performance / style / test / docs / api-contract

### Finding

> 简述问题（一句话）

### Triage rationale

为什么定为这个 severity？影响面是什么？

### Proposed fix (optional)

如果已有思路可以简述。否则留空，由 dispatch 阶段的 agent 决定。

---

Triage 不阻塞 PR 合并。打 `cursor:dispatch` 标签即派 Cursor Cloud Agent 修复（合并后本 issue 自动关闭）。
若是误报或不修：打 `auto-closed:wontfix` 标签后手动关闭。
