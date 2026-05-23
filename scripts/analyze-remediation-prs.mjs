#!/usr/bin/env node
// Cross-reference docs/REMEDIATION_PLAN.md status against merged GitHub PRs.
// Reads /tmp/merged_full.json (output of `gh pr list --state merged --json ...`).
//
// Evidence rules — MUST stay in lockstep with scripts/backfill-remediation-done.mjs.
// See that file's header for the full rule set.

import fs from "fs";

const DOC = "/workspace/docs/REMEDIATION_PLAN.md";
const PRS = "/tmp/merged_full.json";

const docText = fs.readFileSync(DOC, "utf8");
const entries = new Map();
{
  let cur = null;
  const headerRe = /^####? (R-\d+[a-z]?(?:\.[a-z0-9]+)?) +(\[[A-Z]+\])? *(.*)$/;
  const statusRe = /^- \*\*status\*\*:\s*(\S+)/;
  const batchRe = /^- \*\*batch\*\*:\s*(\S+)/;
  for (const line of docText.split("\n")) {
    const mh = headerRe.exec(line);
    if (mh) {
      const [, rid, sevRaw, title] = mh;
      if (rid === "R-XXX") { cur = null; continue; }
      cur = rid;
      entries.set(rid, { rid, severity: (sevRaw || "").replace(/[\[\]]/g, ""), title: title.trim(), status: "?", batch: "?" });
      continue;
    }
    if (!cur) continue;
    const ms = statusRe.exec(line); if (ms) entries.get(cur).status = ms[1];
    const mb = batchRe.exec(line); if (mb) entries.get(cur).batch = mb[1];
  }
}
console.error(`Parsed ${entries.size} R-IDs from doc`);

const prs = JSON.parse(fs.readFileSync(PRS, "utf8"));
const META_DOC_PR_RE = /^(docs\(remediation\)|chore\(R-\d+\): mark as |chore\(triage\)|chore\(remediation\))/i;
const metaPrs = new Set(prs.filter(p => META_DOC_PR_RE.test(p.title || "")).map(p => p.number));
console.error(`Excluded ${metaPrs.size} meta-doc PRs from evidence: ${[...metaPrs].sort((a,b)=>a-b).join(",")}`);

const evidence = new Map();
function ev(rid){ if(!evidence.has(rid)) evidence.set(rid,{strong:new Set(),weak:new Set()}); return evidence.get(rid); }
const R_RE = /\bR-\d+[a-z]?(?:\.[a-z0-9]+)?\b/g;
const STRONG_RE = /(?:close[sd]?|fix(?:e[sd])?|implement[sd]?|resolve[sd]?|address(?:e[sd])?|finish(?:e[sd])?|complete[sd]?)\b[^\n.]{0,200}?(R-\d+[a-z]?(?:\.[a-z0-9]+)?)/gi;
const REVERSE_STRONG_RE = /(R-\d+[a-z]?(?:\.[a-z0-9]+)?)\b[^\n.]{0,80}?(?:done|implemented|fixed|closed|resolved|completed?)/gi;
// Conventional commit with R-ID as scope — this repo's actual convention for
// implementation PRs (e.g. `feat(R-170): add exec-mode protocol FSM`).
const CONVENTIONAL_COMMIT_RE = /^(?:feat|fix|chore|refactor|perf|test|docs|ci|build|style)\((R-\d+[a-z]?(?:\.[a-z0-9]+)?)\)\s*[:!]/i;

for (const pr of prs) {
  if (metaPrs.has(pr.number)) continue;
  const num = pr.number;
  const title = pr.title || "";
  const blob = [title, pr.body || "", pr.headRefName || ""].join("\n");
  const mentions = new Set(blob.match(R_RE) || []);
  if (!mentions.size) continue;
  const strong = new Set();
  for (const m of blob.matchAll(STRONG_RE)) strong.add(m[1]);
  for (const m of blob.matchAll(REVERSE_STRONG_RE)) strong.add(m[1]);
  const branch = (pr.headRefName || "").toLowerCase();
  for (const rid of mentions) {
    const n = rid.toLowerCase().replace("r-", "");
    const re = new RegExp(`(?:^|[/_-])r-?${n}(?:[/_-]|$)`);
    if (re.test(branch)) strong.add(rid);
  }
  const cc = CONVENTIONAL_COMMIT_RE.exec(title);
  if (cc) strong.add(cc[1]);
  for (const rid of mentions) {
    if (strong.has(rid)) ev(rid).strong.add(num);
    else ev(rid).weak.add(num);
  }
}

function classify(rid, info){
  const e = evidence.get(rid) || {strong:new Set(),weak:new Set()};
  if (info.status === "done") return "DOC_DONE";
  if (info.status === "cancelled") return "CANCELLED";
  if (e.strong.size) return "STRONG_DONE";
  if (e.weak.size) return "WEAK_MENTION";
  return "NO_MENTION";
}

const counts = {DOC_DONE:0, STRONG_DONE:0, WEAK_MENTION:0, NO_MENTION:0, CANCELLED:0};
const crossStatus = new Map();
for (const [rid, info] of entries) {
  const c = classify(rid, info);
  counts[c]++;
  if (!crossStatus.has(info.status)) crossStatus.set(info.status, {DOC_DONE:0,STRONG_DONE:0,WEAK_MENTION:0,NO_MENTION:0,CANCELLED:0});
  crossStatus.get(info.status)[c]++;
}

console.log("\n=== Classification summary (meta-doc PRs excluded) ===");
for (const k of ["DOC_DONE","STRONG_DONE","WEAK_MENTION","NO_MENTION","CANCELLED"]) {
  console.log(`  ${k.padEnd(14)}: ${counts[k]}`);
}
console.log(`  TOTAL         : ${entries.size}`);

console.log("\n=== Cross: doc status × classification ===");
console.log(`  ${"status".padEnd(14)}  DOC_DONE  STRONG  WEAK  NONE`);
for (const s of [...crossStatus.keys()].sort()) {
  const r = crossStatus.get(s);
  console.log(`  ${s.padEnd(14)}  ${String(r.DOC_DONE).padStart(8)}  ${String(r.STRONG_DONE).padStart(6)}  ${String(r.WEAK_MENTION).padStart(4)}  ${String(r.NO_MENTION).padStart(4)}`);
}

function dump(label, predicate, showPr=true){
  const rows = [...entries.values()].filter(i => predicate(i)).sort((a,b)=>a.rid.localeCompare(b.rid));
  console.log(`\n=== ${label} (${rows.length}) ===`);
  for (const info of rows) {
    const e = evidence.get(info.rid) || {strong:new Set(),weak:new Set()};
    let pstr = "";
    if (showPr) {
      const s = [...e.strong].sort((a,b)=>a-b).slice(0,4);
      const w = [...e.weak].sort((a,b)=>a-b).slice(0,3);
      if (s.length) pstr += " strong=" + s.map(x=>`#${x}`).join(",");
      if (w.length) pstr += " weak=" + w.map(x=>`#${x}`).join(",");
    }
    console.log(`  ${info.rid}  [${info.severity.padEnd(8)}] ${info.status.padEnd(12)} ${info.title.slice(0,60)}${pstr}`);
  }
  return rows;
}

dump("Likely DONE (doc != done but STRONG impl PR exists)",
     i => classify(i.rid,i)==="STRONG_DONE" && i.status !== "done");

dump("BLOCKED", i => i.status==="blocked");

dump("NO IMPL PR MENTION AT ALL (truly pending)",
     i => classify(i.rid,i)==="NO_MENTION" && i.status!=="done" && i.status!=="cancelled", false);

dump("WEAK MENTION ONLY (uncertain - PR refers to it as context)",
     i => classify(i.rid,i)==="WEAK_MENTION" && i.status!=="done" && i.status!=="cancelled");

const likelyDone = [...entries.values()].filter(i => classify(i.rid,i)==="STRONG_DONE" && i.status!=="done").length;
const blocked = [...entries.values()].filter(i => i.status==="blocked").length;
const noMen = [...entries.values()].filter(i => classify(i.rid,i)==="NO_MENTION" && i.status!=="done" && i.status!=="cancelled").length;
const weak = [...entries.values()].filter(i => classify(i.rid,i)==="WEAK_MENTION" && i.status!=="done" && i.status!=="cancelled").length;

console.log(`\n=== HEADLINE ===`);
console.log(`Total R-IDs                       : ${entries.size}`);
console.log(`Doc explicitly done               : ${counts.DOC_DONE}`);
console.log(`Likely done (STRONG impl PR)      : ${likelyDone}`);
console.log(`Blocked (gated externally)        : ${blocked}`);
console.log(`Weak mention (uncertain)          : ${weak}`);
console.log(`No impl PR mention (true TODO)    : ${noMen}`);
console.log(`Truly remaining (worst-case)      : ${entries.size - counts.DOC_DONE - likelyDone}`);
