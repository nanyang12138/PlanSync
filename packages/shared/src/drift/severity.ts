/**
 * Severity classifier — deterministic, no AI in the loop.
 *
 * Today the drift engine assigns severity by *task status*:
 *   - has running execution → high
 *   - todo/in_progress/blocked → medium
 *   - everything else → low
 *
 * That gives the same answer for "edited one word in an unrelated deliverable"
 * and "changed the constraint the task depends on", which is the user-facing
 * source of "drift severity is noise" complaints.
 *
 * This module decides severity by *what changed in the plan* relative to
 * *which plan items the task references*. AI is not consulted. The function
 * is pure so:
 *   1. it can be replayed deterministically in audit logs,
 *   2. the client UI can recompute severity locally for explanations,
 *   3. tests can pin behavior without mocks.
 *
 * Severity meanings (consumed by the drift gate and UI):
 *   - "breaking" — the task's contract changed; the running agent must stop
 *     and the owner must explicitly re-ack before any further progress.
 *   - "medium"   — surrounding context changed (scope/standards) in a way the
 *     task touches; agent should pause and re-orient but the deliverables
 *     themselves are intact.
 *   - "low"      — nothing the task references changed; informational only.
 */

import type { FieldChange, StructuralDiff } from './structural-diff';
import { itemKey } from './structural-diff';

export type Severity = 'breaking' | 'medium' | 'low';

/**
 * Subset of the Task fields the classifier needs. Decoupled from the Prisma
 * model so this stays pure and importable from any package.
 *
 * - `planDeliverableRefs`: the deliverables this task is responsible for. Today
 *   these are stored as the deliverable's raw text (see schema.prisma); the
 *   classifier normalizes via `itemKey()` to match diff entries.
 * - `planConstraintRefs` / `planStandardRefs`: not yet on the schema — when
 *   null/undefined, the task is treated as depending on **all** items of that
 *   field (conservative — biases toward "breaking" rather than silently
 *   downgrading). Once the schema migration lands and tasks declare these
 *   explicitly, this branch starts to filter and severity tightens for free.
 *
 * Empty array `[]` is treated identically to null: "depends on all". Owners
 * who explicitly want "this task depends on nothing in that field" should be
 * forbidden from creating such a task by the API layer; the classifier
 * defaults to "all" to keep regression-safe.
 */
export type TaskRefs = {
  planDeliverableRefs: string[];
  planConstraintRefs?: string[] | null;
  planStandardRefs?: string[] | null;
};

function normalizeKeys(refs: string[] | null | undefined): Set<string> | null {
  if (refs == null) return null; // null sentinel: "depends on all"
  if (refs.length === 0) return null;
  return new Set(refs.map(itemKey));
}

function touches(refKeys: Set<string> | null, change: FieldChange): boolean {
  // null = "all" — any change touches the task
  if (refKeys == null) return true;
  if (!('itemKey' in change)) return false; // scalar field, handled separately
  return refKeys.has(change.itemKey);
}

/**
 * Classify the impact of a plan diff on a single task.
 *
 * Two-pass algorithm: first scan for any "breaking" trigger, then "medium",
 * else "low". This guarantees the highest-severity match wins regardless of
 * change ordering — important because clients persist diffs and may replay
 * them in any order.
 */
export function severityForTask(task: TaskRefs, diff: StructuralDiff): Severity {
  const deliverableKeys = normalizeKeys(task.planDeliverableRefs);
  const constraintKeys = normalizeKeys(task.planConstraintRefs);
  const standardKeys = normalizeKeys(task.planStandardRefs);

  // Pass 1: breaking
  for (const ch of diff.changes) {
    if (ch.op === 'modify' && ch.field === 'goal') return 'breaking';
    if ((ch.op === 'add' || ch.op === 'remove') && ch.field === 'deliverables') {
      if (touches(deliverableKeys, ch)) return 'breaking';
    }
    if ((ch.op === 'add' || ch.op === 'remove') && ch.field === 'constraints') {
      if (touches(constraintKeys, ch)) return 'breaking';
    }
  }

  // Pass 2: medium
  for (const ch of diff.changes) {
    if (ch.op === 'modify' && ch.field === 'scope') return 'medium';
    if ((ch.op === 'add' || ch.op === 'remove') && ch.field === 'standards') {
      if (touches(standardKeys, ch)) return 'medium';
    }
  }

  return 'low';
}

/**
 * Classify many tasks at once. Returned in the same order as input; severity
 * for an empty diff is always 'low' (a no-op plan activate triggers nothing).
 */
export function severityForTasks<T extends TaskRefs & { id: string }>(
  tasks: T[],
  diff: StructuralDiff,
): Array<{ taskId: string; severity: Severity }> {
  if (diff.changes.length === 0) {
    return tasks.map((t) => ({ taskId: t.id, severity: 'low' as const }));
  }
  return tasks.map((t) => ({ taskId: t.id, severity: severityForTask(t, diff) }));
}
