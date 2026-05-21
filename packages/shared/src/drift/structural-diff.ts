/**
 * Structural plan diff — deterministic, AI-free.
 *
 * The drift engine today asks an LLM "what changed between v1 and v2"; that's
 * fine for human-readable summaries but it can't be relied on for security
 * decisions (severity, gate enforcement) because:
 *   1. it's non-deterministic (same input → different output across calls),
 *   2. it can fail / time out, leaving the system blind,
 *   3. an attacker controlling LLM output (e.g. via prompt injection in plan
 *      content) could trivially say "no breaking changes".
 *
 * This module derives a typed diff from the plan content itself. Severity
 * decisions (./severity.ts) and the API drift gate must consume this output.
 * AI is welcome to *narrate* the diff but must not produce it.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Array semantics
 *
 * Plan content arrays (`constraints`, `standards`, ...) are currently
 * `string[]` without stable IDs (see schema.prisma). We avoid making the
 * decision "was item X modified or removed+added?" because:
 *   1. The current code stores raw strings — there is no stable identity to
 *      anchor a modify event to.
 *   2. For the only downstream consumer that cares (severity), "modify of an
 *      item the task references" and "remove of an item the task references"
 *      both demand the same answer: breaking. So conflating them is safe and
 *      removes a class of false positives from fuzzy similarity matching.
 *
 * Once schema is migrated to `{ id, text }` items, this module gains a real
 * "modify" op and the matching here becomes exact-id. The severity rules need
 * no change.
 */

export type ArrayField =
  | 'constraints'
  | 'standards'
  | 'deliverables'
  | 'openQuestions'
  | 'requiredReviewers';

export type ScalarField = 'goal' | 'scope';

export type PlanContent = {
  goal: string;
  scope: string;
  constraints: string[];
  standards: string[];
  deliverables: string[];
  openQuestions: string[];
  requiredReviewers: string[];
};

export type ScalarChange = {
  op: 'modify';
  field: ScalarField;
  before: string;
  after: string;
};

export type ArrayChange =
  | { op: 'add'; field: ArrayField; itemKey: string; after: string }
  | { op: 'remove'; field: ArrayField; itemKey: string; before: string };

export type FieldChange = ScalarChange | ArrayChange;

export type StructuralDiff = {
  fromVersion: number;
  toVersion: number;
  changes: FieldChange[];
};

const ARRAY_FIELDS: ArrayField[] = [
  'constraints',
  'standards',
  'deliverables',
  'openQuestions',
  'requiredReviewers',
];

const SCALAR_FIELDS: ScalarField[] = ['goal', 'scope'];

/**
 * Stable, content-derived key for a free-text plan item.
 *
 * The current schema stores items as raw strings. We need *some* identity to
 * compare across versions; using a normalized hash of the text gives:
 *   - exact whitespace/case differences DO change the key (intentional: a
 *     change like "Use Postgres" → "Use Postgres 15" is semantically a
 *     remove+add, which severity correctly classifies as breaking if the task
 *     referenced the item).
 *   - the function is referentially transparent — same text → same key
 *     forever, so a diff persisted in the DB can be replayed years later
 *     against the same plan content and produce identical results.
 *
 * Implementation note: we use FNV-1a 32-bit hash (zero deps, no Node crypto
 * import — shared package must stay isomorphic for future browser use). 32
 * bits gives ~4B distinct keys; collision risk inside a single plan (typically
 * <50 items per field) is negligible.
 */
export function itemKey(text: string): string {
  const normalized = text.trim();
  let hash = 0x811c9dc5; // FNV-1a offset basis
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    // 32-bit FNV prime multiplication via shifts to stay in int32 land
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Compute the structural diff between two plan versions.
 *
 * Pure function. No I/O, no clock, no randomness. Safe to call from server
 * code, tests, and (eventually) the browser.
 */
export function diffPlans(
  from: PlanContent & { version: number },
  to: PlanContent & { version: number },
): StructuralDiff {
  const changes: FieldChange[] = [];

  for (const field of SCALAR_FIELDS) {
    if (from[field] !== to[field]) {
      changes.push({ op: 'modify', field, before: from[field], after: to[field] });
    }
  }

  for (const field of ARRAY_FIELDS) {
    const fromItems = new Map<string, string>();
    for (const item of from[field]) fromItems.set(itemKey(item), item);
    const toItems = new Map<string, string>();
    for (const item of to[field]) toItems.set(itemKey(item), item);

    for (const [key, text] of fromItems) {
      if (!toItems.has(key)) {
        changes.push({ op: 'remove', field, itemKey: key, before: text });
      }
    }
    for (const [key, text] of toItems) {
      if (!fromItems.has(key)) {
        changes.push({ op: 'add', field, itemKey: key, after: text });
      }
    }
  }

  return { fromVersion: from.version, toVersion: to.version, changes };
}
