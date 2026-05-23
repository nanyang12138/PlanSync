#!/usr/bin/env node
// One-shot backfill: for every R-XXX entry whose doc-status is NOT "done"
// but has a STRONG implementation PR merged on GitHub, flip the status to
// "done" and add a `closed_in: PR#xxx[, PR#yyy,...]` line.
//
// "Strong" evidence rules (same as scripts/analyze-remediation-prs.mjs):
//   - merged PR's title/body/branch has a strong verb (close/fix/implement/
//     resolve/address/finish/complete) referring to the R-ID, OR
//   - branch is named after the R-ID (e.g. cursor/r182-...).
// Pure-doc meta PRs (docs(remediation): ..., chore(R-xxx): mark as blocked,
// chore(triage)..., chore(remediation): ...) are EXCLUDED.
//
// Inputs:
//   /workspace/docs/REMEDIATION_PLAN.md
//   /tmp/merged_full.json   (gh pr list --state merged --json number,title,headRefName,body)
//
// Writes the doc in place. Prints a summary of which R-IDs were updated
// (and which were skipped because they were already done or had no strong
// evidence).

import fs from "fs";

const DOC_PATH = "/workspace/docs/REMEDIATION_PLAN.md";
const PRS_PATH = "/tmp/merged_full.json";

const docText = fs.readFileSync(DOC_PATH, "utf8");

// --- 1. Parse all R-XXX entries, capturing per-entry line ranges so we can
//        do per-entry editing. ---
const lines = docText.split("\n");
const HEADER_RE = /^####\s+(R-\d+[a-z]?(?:\.[a-z0-9]+)?)\s+\[([A-Z]+)\]/;
const STATUS_RE = /^- \*\*status\*\*:\s*(\S+)(.*)$/;
const CLOSED_IN_RE = /^- \*\*closed_in\*\*:/;

const entries = [];
{
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const m = HEADER_RE.exec(lines[i]);
    if (m) {
      if (cur) { cur.endExclusive = i; entries.push(cur); }
      cur = { id: m[1], severity: m[2], headerLine: i, statusLine: -1, closedInLine: -1, status: "?" };
      continue;
    }
    if (cur) {
      const ms = STATUS_RE.exec(lines[i]);
      if (ms && cur.statusLine < 0) { cur.statusLine = i; cur.status = ms[1]; }
      if (CLOSED_IN_RE.test(lines[i]) && cur.closedInLine < 0) cur.closedInLine = i;
    }
  }
  if (cur) { cur.endExclusive = lines.length; entries.push(cur); }
}
console.error(`Parsed ${entries.length} R-entries (including template).`);

// --- 2. Build evidence from merged PRs (same logic as analyze-remediation-prs.mjs) ---
const prs = JSON.parse(fs.readFileSync(PRS_PATH, "utf8"));
const META_DOC_PR_RE = /^(docs\(remediation\)|chore\(R-\d+\): mark as |chore\(triage\)|chore\(remediation\))/i;
const metaPrs = new Set(prs.filter(p => META_DOC_PR_RE.test(p.title || "")).map(p => p.number));
console.error(`Excluded ${metaPrs.size} meta-doc PRs: ${[...metaPrs].sort((a,b)=>a-b).join(",")}`);

const R_RE = /\bR-\d+[a-z]?(?:\.[a-z0-9]+)?\b/g;
const STRONG_RE = /(?:close[sd]?|fix(?:e[sd])?|implement[sd]?|resolve[sd]?|address(?:e[sd])?|finish(?:e[sd])?|complete[sd]?)\b[^\n.]{0,200}?(R-\d+[a-z]?(?:\.[a-z0-9]+)?)/gi;
const REVERSE_STRONG_RE = /(R-\d+[a-z]?(?:\.[a-z0-9]+)?)\b[^\n.]{0,80}?(?:done|implemented|fixed|closed|resolved|completed?)/gi;

const strongEvidence = new Map(); // rid -> sorted list of PR numbers (asc)
function addStrong(rid, num) {
  if (!strongEvidence.has(rid)) strongEvidence.set(rid, new Set());
  strongEvidence.get(rid).add(num);
}

for (const pr of prs) {
  if (metaPrs.has(pr.number)) continue;
  const blob = [pr.title || "", pr.body || "", pr.headRefName || ""].join("\n");
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
  for (const rid of strong) addStrong(rid, pr.number);
}

// --- 3. Decide which entries to update ---
const toUpdate = []; // { entry, prs: number[] }
for (const e of entries) {
  if (e.id === "R-XXX") continue;
  if (e.status === "done") continue;
  if (e.status === "cancelled") continue;
  const ev = strongEvidence.get(e.id);
  if (!ev || ev.size === 0) continue;
  toUpdate.push({ entry: e, prs: [...ev].sort((a, b) => a - b) });
}

console.error(`\nPlanning to update ${toUpdate.length} entries:`);
for (const u of toUpdate) {
  console.error(`  ${u.entry.id} [${u.entry.severity}] ${u.entry.status} -> done   closed_in=${u.prs.map(p => "PR#" + p).join(", ")}`);
}

// --- 4. Apply edits to lines[] from the BOTTOM UP so indices stay valid ---
// Sort entries by statusLine desc.
toUpdate.sort((a, b) => b.entry.statusLine - a.entry.statusLine);

for (const u of toUpdate) {
  const e = u.entry;
  // Flip status line.
  const orig = lines[e.statusLine];
  const m = STATUS_RE.exec(orig);
  if (!m) {
    console.error(`!! ${e.id}: status line not recognised, skipping`);
    continue;
  }
  // Preserve any trailing text after status word (rare, but safe).
  lines[e.statusLine] = `- **status**: done${m[2]}`;

  // Insert / update closed_in.
  const closedLine = `- **closed_in**: ${u.prs.map(p => `PR#${p}`).join(", ")}`;
  if (e.closedInLine >= 0) {
    lines[e.closedInLine] = closedLine;
  } else {
    // Insert immediately after status line.
    lines.splice(e.statusLine + 1, 0, closedLine);
  }
}

const updated = lines.join("\n");
if (updated === docText) {
  console.error("No changes to write.");
  process.exit(0);
}
fs.writeFileSync(DOC_PATH, updated);
console.error(`\nWrote ${DOC_PATH} (${toUpdate.length} entries flipped to done).`);
