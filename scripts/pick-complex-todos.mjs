#!/usr/bin/env node
// Find the "complex" remaining R-XXX items — high-effort, cross-cutting,
// or architecturally consequential. These are bad fits for an unattended
// cron + Cloud Agent (which works best on small/medium, well-scoped tasks)
// and benefit from a human driving the design.

import { lint, getFieldValue, parseIdList } from "./lint-remediation.mjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = path.resolve(__dirname, "..", "docs", "REMEDIATION_PLAN.md");
const text = fs.readFileSync(PLAN_PATH, "utf8");
const { entries } = lint(text);
const idMap = new Map(entries.map((e) => [e.id, e]));
const statusOf = (e) => (getFieldValue(e, "status") || "").split(/\s+/)[0];

const SEV_W = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
const EFFORT_W = { large: 3, medium: 2, small: 1 };

// Build "downstream blocker" count: how many other entries depend on this one.
const blocksCount = new Map();
for (const e of entries) {
  for (const d of parseIdList(getFieldValue(e, "depends_on"))) {
    blocksCount.set(d, (blocksCount.get(d) || 0) + 1);
  }
}

// Candidates: not done/cancelled.
const todo = entries.filter(e => {
  const s = statusOf(e);
  return s !== "done" && s !== "cancelled" && e.id !== "R-XXX";
});

// Score = effort_weight*4 + severity_weight + min(blocks, 5) + cross-batch dependency hint.
function complexityScore(e) {
  const effort = (getFieldValue(e, "effort") || "small").toLowerCase().split(/\s+/)[0];
  const eW = EFFORT_W[effort] || 1;
  const sW = SEV_W[e.severity] || 1;
  const downstream = blocksCount.get(e.id) || 0;
  // Cross-batch dep = harder to reason about
  const batch = getFieldValue(e, "batch") || "";
  const deps = parseIdList(getFieldValue(e, "depends_on"));
  let crossBatchHits = 0;
  for (const d of deps) {
    const dep = idMap.get(d);
    if (dep && (getFieldValue(dep, "batch") || "") !== batch) crossBatchHits++;
  }
  return {
    effort, eW, sW, downstream,
    batch,
    crossBatchHits,
    total: eW * 4 + sW + Math.min(downstream, 5) + Math.min(crossBatchHits, 3),
  };
}

const scored = todo.map(e => {
  const sc = complexityScore(e);
  return { e, ...sc };
});

scored.sort((a, b) => b.total - a.total || (SEV_W[b.e.severity]||0) - (SEV_W[a.e.severity]||0) || a.e.id.localeCompare(b.e.id));

const top = scored.slice(0, 20);
console.log("\n=== Top 20 most complex remaining items ===\n");
console.log("score effort   sev      blocks deps× batch  R-ID    title");
console.log("───── ──────── ──────── ────── ───── ────── ──────  ─────");
for (const s of top) {
  const blocked = statusOf(s.e) === "blocked" ? "*B*" : "   ";
  console.log(
    `${String(s.total).padStart(5)} ${s.effort.padEnd(8)} ${s.e.severity.padEnd(8)} ${String(s.downstream).padStart(6)} ${String(s.crossBatchHits).padStart(5)} ${(s.batch||"").padEnd(6)} ${s.e.id} ${blocked} ${s.e.title.slice(0,55)}`
  );
}

// Group by batch for easier triage.
const byBatch = new Map();
for (const s of scored) {
  const b = s.batch || "—";
  if (!byBatch.has(b)) byBatch.set(b, []);
  byBatch.get(b).push(s);
}
console.log("\n=== Remaining items grouped by batch ===");
for (const [b, items] of [...byBatch.entries()].sort()) {
  const large = items.filter(x => x.effort === "large").length;
  const med = items.filter(x => x.effort === "medium").length;
  console.log(`  ${b.padEnd(6)} total=${String(items.length).padStart(2)}  large=${large}  medium=${med}  top: ${items[0].e.id} [${items[0].e.severity}] ${items[0].e.title.slice(0,40)}`);
}

// Also list all `effort: large` items separately.
const large = scored.filter(s => s.effort === "large");
console.log(`\n=== All ${large.length} effort:large remaining items ===`);
for (const s of large) {
  const status = statusOf(s.e);
  console.log(`  ${s.e.id} [${s.e.severity}] ${status.padEnd(11)} batch=${s.batch} blocks=${s.downstream}  ${s.e.title}`);
}
