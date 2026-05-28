#!/usr/bin/env node
// Diagnose why the dispatcher returns no pickable entry.

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

const reasonCounts = {};
const pickable = [];
const blockedByDeps = [];

for (const e of entries) {
  if (statusOf(e) !== "pending") continue;
  const sup = getFieldValue(e, "superseded_by").trim();
  if (sup && sup !== "—") { reasonCounts["superseded_by"] = (reasonCounts["superseded_by"]||0)+1; continue; }
  const interim = getFieldValue(e, "interim_for").trim();
  if (interim && interim !== "—") {
    const tgt = idMap.get(interim);
    const ts = tgt ? statusOf(tgt) : "";
    if (["in_progress", "done", "cancelled"].includes(ts)) {
      reasonCounts["interim_target_active"] = (reasonCounts["interim_target_active"]||0)+1;
      continue;
    }
  }
  const deps = parseIdList(getFieldValue(e, "depends_on"));
  const unmet = deps.filter(d => {
    const dep = idMap.get(d);
    if (!dep) return true;
    return !["done", "cancelled"].includes(statusOf(dep));
  });
  if (unmet.length) {
    blockedByDeps.push({ id: e.id, sev: e.severity, unmet });
    reasonCounts["unmet_deps"] = (reasonCounts["unmet_deps"]||0)+1;
    continue;
  }
  pickable.push(e);
}

const pending = entries.filter(e => statusOf(e) === "pending");
console.log(`Total entries           : ${entries.length}`);
console.log(`Pending entries         : ${pending.length}`);
console.log("Skip reasons:", reasonCounts);
console.log(`PICKABLE RIGHT NOW      : ${pickable.length}`);

if (pickable.length) {
  const w = { CRITICAL:4, HIGH:3, MEDIUM:2, LOW:1 };
  pickable.sort((a,b) => (w[b.severity]||0) - (w[a.severity]||0) || a.id.localeCompare(b.id));
  console.log("Pickable list (sev desc, id asc):");
  for (const p of pickable) console.log(`  ${p.id} [${p.severity}] ${p.title.slice(0,60)}`);
}

if (blockedByDeps.length) {
  // Histogram of upstream status (counts each unmet edge)
  const upstreamStatus = {};
  const upstreamId = {};
  for (const x of blockedByDeps) for (const d of x.unmet) {
    const dep = idMap.get(d);
    const s = dep ? statusOf(dep) : "MISSING";
    upstreamStatus[s] = (upstreamStatus[s]||0)+1;
    upstreamId[d] = (upstreamId[d]||0)+1;
  }
  console.log("\nUpstream-status histogram of unmet edges:", upstreamStatus);
  // Top blocking upstreams
  const tops = Object.entries(upstreamId).sort((a,b)=>b[1]-a[1]).slice(0,15);
  console.log("\nTop blocking upstream R-IDs (blocks N pending children):");
  for (const [id, n] of tops) {
    const dep = idMap.get(id);
    const s = dep ? statusOf(dep) : "MISSING";
    const t = dep ? dep.title : "?";
    console.log(`  ${id} [${s}] blocks ${n}  — ${t.slice(0,55)}`);
  }
}
