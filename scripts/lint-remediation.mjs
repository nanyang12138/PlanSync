#!/usr/bin/env node
/**
 * Validates docs/REMEDIATION_PLAN.md against the machine-readable contract
 * documented in §"给 cron job 的解析约定". Run this in CI to keep the
 * cron / dispatch automation working as the document evolves.
 *
 * Usage:
 *   node scripts/lint-remediation.mjs        # exit 0 on success, 1 on any error
 *   node scripts/lint-remediation.mjs --json # machine-readable summary
 *
 * Checks:
 *   1. Every `#### R-XXX [SEVERITY]` block has a parseable status, batch,
 *      depends_on, effort, files, fix_steps, verification field.
 *   2. status ∈ {pending, in_progress, done, blocked, cancelled}.
 *   3. severity ∈ {CRITICAL, HIGH, MEDIUM, LOW}.
 *   4. The three dedup fields (superseded_by / interim_for / supersedes)
 *      are mutually exclusive — at most one per entry.
 *   5. Their values are pure machine-readable R-IDs (or comma-separated
 *      list for supersedes). No inline prose.
 *   6. depends_on / superseded_by / interim_for / supersedes only refer to
 *      R-IDs that exist in the document.
 *   7. depends_on graph contains no cycles.
 *   8. Severity counts at the end of appendix A match the actual section
 *      headers.
 *   9. R-ID space is unique and never reused.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PLAN_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'docs',
  'REMEDIATION_PLAN.md',
);

const VALID_STATUS = new Set(['pending', 'in_progress', 'done', 'blocked', 'cancelled']);
const VALID_SEVERITY = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
const REQUIRED_FIELDS = [
  'status',
  'batch',
  'depends_on',
  'effort',
  'files',
  'fix_steps',
  'verification',
];
const DEDUP_FIELDS = ['superseded_by', 'interim_for', 'supersedes'];
const ID_RE = /^R-\d{3}$/;

function parseEntries(text) {
  const lines = text.split('\n');
  const entries = [];
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const header = line.match(/^#### (R-\d+) \[([A-Z]+)\] (.*)$/);
    if (header) {
      if (current) entries.push(current);
      current = {
        id: header[1],
        severity: header[2],
        title: header[3],
        startLine: i + 1,
        fields: {},
      };
      continue;
    }
    if (line.startsWith('#### ')) {
      // Different kind of `####` header — close out current entry.
      if (current) {
        entries.push(current);
        current = null;
      }
      continue;
    }
    if (current) {
      const field = line.match(/^- \*\*([a-z_]+)\*\*:\s*(.*)$/);
      if (field) current.fields[field[1]] = field[2].trim();
    }
  }
  if (current) entries.push(current);
  return entries;
}

function parseIdList(value) {
  if (!value || value === '—') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function detectCycle(deps) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  for (const id of deps.keys()) color.set(id, WHITE);
  const stack = [];
  function visit(id) {
    if (color.get(id) === GRAY) {
      const ix = stack.indexOf(id);
      return stack.slice(ix).concat(id);
    }
    if (color.get(id) === BLACK) return null;
    color.set(id, GRAY);
    stack.push(id);
    for (const next of deps.get(id) ?? []) {
      if (!color.has(next)) continue; // unknown ID — caller already errored
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  }
  for (const id of deps.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

function main() {
  const text = fs.readFileSync(PLAN_PATH, 'utf-8');
  const entries = parseEntries(text);
  const errors = [];
  const warnings = [];
  const idMap = new Map(entries.map((e) => [e.id, e]));

  // 9. R-ID uniqueness.
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.id)) {
      errors.push(`Duplicate R-ID '${e.id}' (see line ${e.startLine}).`);
    }
    seen.add(e.id);
  }

  for (const e of entries) {
    // 3. severity
    if (!VALID_SEVERITY.has(e.severity)) {
      errors.push(`${e.id}: invalid severity '${e.severity}'.`);
    }

    // 1. required fields
    //
    // Legacy entries (R-001..R-134) use a compact format that occasionally
    // omits files / fix_steps / verification — they predate the strict
    // template. Treat missing fields on those as warnings; new entries
    // (R-135+) must satisfy the full template.
    const idNumber = Number(e.id.slice(2));
    const isLegacy = idNumber < 135;
    for (const f of REQUIRED_FIELDS) {
      if (!(f in e.fields)) {
        const msg = `${e.id}: missing required field '${f}'.`;
        if (isLegacy) warnings.push(msg);
        else errors.push(msg);
      }
    }

    // 2. status
    const statusFirstWord = (e.fields.status || '').split(/\s+/)[0];
    if (statusFirstWord && !VALID_STATUS.has(statusFirstWord)) {
      errors.push(`${e.id}: invalid status '${statusFirstWord}'.`);
    }

    // 4 + 5. dedup mutual exclusion + machine-readable values.
    const dedupPresent = DEDUP_FIELDS.filter((f) => e.fields[f] && e.fields[f] !== '—');
    if (dedupPresent.length > 1) {
      errors.push(
        `${e.id}: ${dedupPresent.length} dedup fields present (${dedupPresent.join(', ')}); only one allowed.`,
      );
    }
    for (const f of DEDUP_FIELDS) {
      const v = e.fields[f];
      if (!v || v === '—') continue;
      const ids = parseIdList(v);
      if (ids.length === 0) {
        errors.push(`${e.id}: ${f} is set but contains no R-IDs.`);
      }
      for (const id of ids) {
        if (!ID_RE.test(id)) {
          errors.push(`${e.id}: ${f} contains non-machine-readable token '${id}'.`);
        }
      }
      if (f !== 'supersedes' && ids.length > 1) {
        errors.push(`${e.id}: ${f} must reference exactly one R-ID, found ${ids.length}.`);
      }
    }

    // 6. cross-reference resolution
    for (const f of [...DEDUP_FIELDS, 'depends_on']) {
      const v = e.fields[f];
      if (!v || v === '—') continue;
      for (const id of parseIdList(v)) {
        if (!ID_RE.test(id)) continue; // already errored above
        if (!idMap.has(id)) {
          errors.push(`${e.id}: ${f} references unknown ${id}.`);
        }
      }
    }
  }

  // 7. depends_on cycle detection (only over known IDs)
  const depsGraph = new Map();
  for (const e of entries) {
    const deps = parseIdList(e.fields.depends_on || '').filter((id) => idMap.has(id));
    depsGraph.set(e.id, deps);
  }
  const cycle = detectCycle(depsGraph);
  if (cycle) {
    errors.push(`depends_on cycle: ${cycle.join(' → ')}`);
  }

  // 8. severity counts
  const sevCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const e of entries) {
    if (sevCounts[e.severity] !== undefined) sevCounts[e.severity] += 1;
  }
  const claim = text.match(
    /CRITICAL: \d+ \+ \d+ = \*\*(\d+)\*\*[\s\S]*?HIGH: \d+ \+ \d+ = \*\*(\d+)\*\*[\s\S]*?MEDIUM: \d+ \+ \d+ = \*\*(\d+)\*\*[\s\S]*?LOW: \d+ \+ \d+ = \*\*(\d+)\*\*/,
  );
  if (!claim) {
    warnings.push('Could not locate severity totals block in appendix.');
  } else {
    const claimed = {
      CRITICAL: Number(claim[1]),
      HIGH: Number(claim[2]),
      MEDIUM: Number(claim[3]),
      LOW: Number(claim[4]),
    };
    for (const k of Object.keys(sevCounts)) {
      if (sevCounts[k] !== claimed[k]) {
        errors.push(
          `Appendix severity total for ${k} = ${claimed[k]} but actual is ${sevCounts[k]}.`,
        );
      }
    }
  }

  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify(
        { entries: entries.length, severity: sevCounts, errors, warnings },
        null,
        2,
      ),
    );
  } else {
    console.log(`docs/REMEDIATION_PLAN.md: parsed ${entries.length} entries.`);
    console.log(`  by severity: ${JSON.stringify(sevCounts)}`);
    if (warnings.length) {
      console.log(`  warnings (${warnings.length}):`);
      for (const w of warnings) console.log(`    - ${w}`);
    }
    if (errors.length) {
      console.error(`  errors (${errors.length}):`);
      for (const e of errors) console.error(`    - ${e}`);
    } else {
      console.log('  no errors.');
    }
  }

  process.exit(errors.length ? 1 : 0);
}

main();
