#!/usr/bin/env node
// Find R-XXX entries that are NOT done in the doc, but where a merged PR
// title matches `^(feat|fix|chore|refactor|perf|test|docs)\(R-\d+\): ...`
// (conventional-commit form with the R-ID as the scope). These are strong
// implementation evidence missed by the original backfill heuristic.

import fs from "fs";
import { lint, getFieldValue } from "./lint-remediation.mjs";

const PRS_PATH = "/tmp/merged_full.json";
if (!fs.existsSync(PRS_PATH)) {
  console.error(`Missing ${PRS_PATH}. Run:`);
  console.error(`  gh pr list --state merged --limit 500 --json number,title,headRefName,body > ${PRS_PATH}`);
  process.exit(2);
}

const docText = fs.readFileSync("/workspace/docs/REMEDIATION_PLAN.md", "utf8");
const { entries } = lint(docText);
const idMap = new Map(entries.map((e) => [e.id, e]));
const statusOf = (e) => (getFieldValue(e, "status") || "").split(/\s+/)[0];

const prs = JSON.parse(fs.readFileSync(PRS_PATH, "utf8"));
const CC_RE = /^(?:feat|fix|chore|refactor|perf|test|docs|ci|build|style)\((R-\d+[a-z]?(?:\.[a-z0-9]+)?)\)\s*[:!]/i;
const META_DOC_PR_RE = /^(?:docs\(remediation\)|chore\(R-\d+\): mark as |chore\(triage\)|chore\(remediation\))/i;

const found = new Map(); // rid -> [{num, title}]
for (const pr of prs) {
  const t = pr.title || "";
  if (META_DOC_PR_RE.test(t)) continue;
  const m = CC_RE.exec(t);
  if (!m) continue;
  const rid = m[1];
  if (!found.has(rid)) found.set(rid, []);
  found.get(rid).push({ num: pr.number, title: t });
}

let candidates = 0;
const rows = [];
for (const [rid, refs] of [...found.entries()].sort()) {
  const e = idMap.get(rid);
  if (!e) continue;
  const s = statusOf(e);
  if (s === "done" || s === "cancelled") continue;
  candidates++;
  rows.push({ rid, status: s, severity: e.severity, title: e.title, refs });
}

console.log(`Missed-by-backfill candidates (PR title is feat/fix/...(R-XXX): ... but doc status != done):  ${candidates}\n`);
console.log("  RID       sev      status        PR(s)           title (PR)");
console.log("  ────────  ───────  ───────────   ──────────────  ──────────");
for (const r of rows) {
  const prList = r.refs.map(x => "#" + x.num).join(",");
  console.log(`  ${r.rid.padEnd(8)}  ${r.severity.padEnd(7)}  ${r.status.padEnd(11)}   ${prList.padEnd(14)}  ${r.refs[0].title.slice(0,70)}`);
}
