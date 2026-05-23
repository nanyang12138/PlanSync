#!/usr/bin/env node
/**
 * Validates docs/REMEDIATION_PLAN.md against the machine-readable contract
 * documented in §"给 cron job 的解析约定". Run this in CI to keep the
 * cron / dispatch automation working as the document evolves.
 *
 * Modes:
 *   node scripts/lint-remediation.mjs               lint, exit 1 on errors
 *   node scripts/lint-remediation.mjs --json        machine-readable lint summary
 *   node scripts/lint-remediation.mjs --dispatch    pick the next R-ID to dispatch
 *                                                   (severity desc, R-ID asc tie-break),
 *                                                   prints the chosen R-ID on stdout or
 *                                                   nothing if no candidate. Exits 0
 *                                                   on success / no-pickup, 1 on lint
 *                                                   error. The bash dispatch.sh uses
 *                                                   this when available; the in-doc
 *                                                   bash example is a self-contained
 *                                                   fallback for hosts without node.
 *
 * Lint checks:
 *   1. Required template fields on every R-135+ entry (legacy R-001..R-134
 *      warn-only since they predate the strict template). `fix_steps` and
 *      similar multi-line fields are detected as either same-line content
 *      OR a child indented list (so R-200 / R-201 etc. don't false-fail).
 *   2. status ∈ {pending, in_progress, done, blocked, cancelled}.
 *   3. severity ∈ {CRITICAL, HIGH, MEDIUM, LOW}.
 *   4. The three dedup fields (superseded_by / interim_for / supersedes)
 *      are mutually exclusive — at most one per entry.
 *   5. Their values are pure machine-readable R-IDs (or comma-separated
 *      list for supersedes). No inline prose.
 *   6. depends_on / superseded_by / interim_for / supersedes cross-refs
 *      resolve to known R-IDs. Non-R-ID tokens are ERRORS, not skipped
 *      (#356).
 *   7. depends_on graph is acyclic.
 *   8. Severity totals in the appendix match the actual section count.
 *   9. R-ID space is unique (never reused).
 *  10. interim_for: R-Y must NOT also list R-Y in its depends_on (#330)
 *      — interim entries should declare the soft skip via interim_for
 *      and depend only on real prerequisites.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = path.resolve(__dirname, '..', 'docs', 'REMEDIATION_PLAN.md');

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
const SEVERITY_WEIGHT = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

/**
 * Parse the document into structured entries. Each entry's `fields` object
 * holds:
 *   { value: string, hasContent: boolean, lineNumber: number }
 *
 * `hasContent` is true when either:
 *   - the field has a same-line value (`- **fix_steps**: 1) ... 2) ...`),
 *     OR
 *   - the field is followed by an indented child list (numbered or
 *     bulleted) — this is the canonical multi-line form for `fix_steps`,
 *     and #343 reported that the previous version flagged R-201 because
 *     it only looked at the same-line text.
 */
export function parseEntries(text) {
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
      if (current) {
        entries.push(current);
        current = null;
      }
      continue;
    }
    if (current) {
      const field = line.match(/^- \*\*([a-z_]+)\*\*:\s*(.*)$/);
      if (field) {
        const key = field[1];
        const sameLineValue = field[2].trim();
        // Look ahead for an indented continuation block: lines that start
        // with at least two spaces and a numbered / bulleted item OR a
        // continuation of the bullet's hanging text.
        let multilineFollows = false;
        for (let j = i + 1; j < lines.length; j += 1) {
          const next = lines[j];
          if (next === '' || /^\s*$/.test(next)) continue;
          if (/^\s{2,}(\d+\.|-|\*)\s/.test(next) || /^\s{4,}\S/.test(next)) {
            multilineFollows = true;
            break;
          }
          break;
        }
        current.fields[key] = {
          value: sameLineValue,
          hasContent: sameLineValue.length > 0 || multilineFollows,
          lineNumber: i + 1,
        };
      }
    }
  }
  if (current) entries.push(current);
  return entries;
}

export function getFieldValue(entry, key) {
  return entry.fields[key]?.value ?? '';
}

export function parseIdList(value) {
  if (!value || value === '—') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function detectCycle(deps) {
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
      if (!color.has(next)) continue;
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

/**
 * Run the full lint and return { entries, sevCounts, errors, warnings }.
 * Pure function; suitable for unit tests.
 */
export function lint(text) {
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

    // 1. required fields — legacy R-001..R-134 warn-only.
    const idNumber = Number(e.id.slice(2));
    const isLegacy = idNumber < 135;
    for (const f of REQUIRED_FIELDS) {
      const field = e.fields[f];
      if (!field || !field.hasContent) {
        const msg = field
          ? `${e.id}: required field '${f}' has no content (line ${field.lineNumber}).`
          : `${e.id}: missing required field '${f}'.`;
        if (isLegacy) warnings.push(msg);
        else errors.push(msg);
      }
    }

    // 2. status
    const statusFirstWord = getFieldValue(e, 'status').split(/\s+/)[0];
    if (statusFirstWord && !VALID_STATUS.has(statusFirstWord)) {
      errors.push(`${e.id}: invalid status '${statusFirstWord}'.`);
    }

    // 4 + 5. dedup mutual exclusion + machine-readable values.
    const dedupPresent = DEDUP_FIELDS.filter((f) => {
      const v = getFieldValue(e, f);
      return v && v !== '—';
    });
    if (dedupPresent.length > 1) {
      errors.push(
        `${e.id}: ${dedupPresent.length} dedup fields present (${dedupPresent.join(', ')}); only one allowed.`,
      );
    }
    for (const f of DEDUP_FIELDS) {
      const v = getFieldValue(e, f);
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

    // 6. cross-reference resolution. #356: non-R-ID tokens are ERRORS, not
    // silently skipped. Previously a typo like `R-110.a` (Chinese paren or
    // sub-suffix) was passed to `continue` and the broken reference was
    // silently accepted.
    for (const f of [...DEDUP_FIELDS, 'depends_on']) {
      const v = getFieldValue(e, f);
      if (!v || v === '—') continue;
      for (const id of parseIdList(v)) {
        if (!ID_RE.test(id)) {
          errors.push(`${e.id}: ${f} contains non-machine-readable R-ID token '${id}'.`);
          continue;
        }
        if (!idMap.has(id)) {
          errors.push(`${e.id}: ${f} references unknown ${id}.`);
        }
      }
    }

    // 10. interim_for + depends_on coupling check (#330):
    // an interim entry should NOT also list its target in depends_on, or
    // the soft-skip rule and the hard-prerequisite rule contradict each
    // other (the entry says "I'm a transition for R-Y" while also saying
    // "I cannot start until R-Y is done", which is impossible by
    // construction).
    const interimTarget = getFieldValue(e, 'interim_for').trim();
    if (interimTarget && interimTarget !== '—') {
      const depIds = parseIdList(getFieldValue(e, 'depends_on'));
      if (depIds.includes(interimTarget)) {
        errors.push(
          `${e.id}: interim_for and depends_on both reference ${interimTarget}; ` +
            `interim entries must not also depend on their target.`,
        );
      }
    }
  }

  // 7. depends_on cycle detection (only over known IDs)
  const depsGraph = new Map();
  for (const e of entries) {
    const deps = parseIdList(getFieldValue(e, 'depends_on')).filter((id) => idMap.has(id));
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

  return { entries, sevCounts, errors, warnings, idMap };
}

/**
 * Pick the next R-ID a cron / dispatch.sh should pick up next, applying
 * the rules from §"给 cron job 的解析约定":
 *   - status == 'pending'
 *   - superseded_by empty
 *   - interim_for empty OR target.status NOT IN {in_progress, done, cancelled}
 *   - all depends_on entries have status IN {done, cancelled}
 *
 * Sort: severity desc (CRITICAL > HIGH > MEDIUM > LOW), R-ID asc on tie
 * (#328 — previously the bash example took the first match in file
 * order, which violated the spec).
 */
export function pickNextDispatch(entries) {
  const idMap = new Map(entries.map((e) => [e.id, e]));
  const candidates = entries.filter((e) => {
    if (getFieldValue(e, 'status').split(/\s+/)[0] !== 'pending') return false;
    const sup = getFieldValue(e, 'superseded_by').trim();
    if (sup && sup !== '—') return false;
    const interim = getFieldValue(e, 'interim_for').trim();
    if (interim && interim !== '—') {
      const tgt = idMap.get(interim);
      const tgtStatus = tgt ? getFieldValue(tgt, 'status').split(/\s+/)[0] : '';
      if (['in_progress', 'done', 'cancelled'].includes(tgtStatus)) return false;
    }
    const deps = parseIdList(getFieldValue(e, 'depends_on'));
    for (const d of deps) {
      if (!ID_RE.test(d)) return false;
      const dep = idMap.get(d);
      if (!dep) return false;
      const ds = getFieldValue(dep, 'status').split(/\s+/)[0];
      if (!['done', 'cancelled'].includes(ds)) return false;
    }
    return true;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const wa = SEVERITY_WEIGHT[a.severity] ?? 0;
    const wb = SEVERITY_WEIGHT[b.severity] ?? 0;
    if (wa !== wb) return wb - wa; // severity desc
    return a.id.localeCompare(b.id); // R-ID asc tie-break (#328)
  });
  return candidates[0];
}

function main() {
  const text = fs.readFileSync(PLAN_PATH, 'utf-8');
  const { entries, sevCounts, errors, warnings } = lint(text);

  if (process.argv.includes('--dispatch')) {
    if (errors.length > 0) {
      console.error(`refusing to dispatch: ${errors.length} lint error(s):`);
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    const pick = pickNextDispatch(entries);
    if (pick) {
      // Emit just the R-ID on stdout so the bash caller can capture it.
      process.stdout.write(`${pick.id}\n`);
    }
    process.exit(0);
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

// Only invoke main() when executed as a script. ESM equivalent of
// `require.main === module`: detect by URL.
const invokedAsMain =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedAsMain) {
  main();
}
