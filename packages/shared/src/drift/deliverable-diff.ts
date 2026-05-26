/**
 * R-154: deliverable-id-based plan diff and per-task severity classifier.
 *
 * The text-hash diff in `./structural-diff.ts` cannot tell apart "owner
 * renamed the title of an unchanged deliverable" from "owner replaced one
 * deliverable with a different one". After R-150 split `plans.deliverables:
 * String[]` into the `plan_deliverables` table — with stable `id`s linked
 * across plan versions via `supersededById` (R-152) — and after R-153
 * shipped `task_deliverable_links` recording which deliverables each task
 * is bound to, we have enough structure to compute the diff in terms of
 * identity rather than text.
 *
 * This module is the deterministic, AI-free engine that turns
 * `(old PlanDeliverable[], new PlanDeliverable[])` into a diff keyed by the
 * *old* deliverable id (so callers can answer "what happened to the
 * deliverable my task is linked to?") and the *added* new deliverable ids
 * (so callers can highlight what showed up). The "identity" is the `slug`
 * column, which `supersedeDeliverables` already preserves across versions:
 * renaming a slug → remove + add (drift's "the deliverable was replaced"
 * signal); renaming only the title → a "modified" entry with
 * `bodyChanged=false, refUriChanged=false, titleChanged=true`.
 *
 * Severity rules (consumed by `runDriftScan`):
 *
 *   - linked deliverable was REMOVED → 'breaking' (the contract the task
 *     was bound to is gone; the agent must stop and the owner must
 *     explicitly rebind or cancel).
 *   - linked deliverable was MODIFIED and `body` changed → 'breaking'
 *     (the contract text changed; agent must re-read).
 *   - linked deliverable was MODIFIED and only `refUri` changed →
 *     'medium' (e.g. the file-glob pattern moved; agent should re-orient).
 *   - everything else (only title changed, deliverable unchanged, or
 *     the diff entry is `unchanged`/`added`) → 'low'.
 *
 *   - Task with no `deliverableLinks` rows → 'low' regardless of what the
 *     diff says. Before R-154 the engine biased toward 'breaking' for
 *     legacy tasks; that produced an alert on every plan activation for
 *     every task in the project even when nothing the task actually owned
 *     had changed. R-154 step 3 trades that conservatism for the explicit
 *     contract: "if the task has not declared what it depends on, do not
 *     interrupt it." The migration to populate `deliverableLinks` for
 *     existing tasks lives in `syncTaskDeliverableLinks` (R-153).
 */

import type { Severity } from './severity';

/**
 * Bare-minimum PlanDeliverable shape the diff needs. Decoupled from Prisma
 * so this module stays pure and importable from non-server packages (CLI,
 * future browser code).
 */
export interface DeliverableLite {
  id: string;
  slug: string;
  title: string;
  body: string;
  refUri: string | null;
}

export type DeliverableDiffEntry =
  | { kind: 'removed' }
  | {
      kind: 'modified';
      bodyChanged: boolean;
      refUriChanged: boolean;
      titleChanged: boolean;
    }
  | { kind: 'added' }
  | { kind: 'unchanged' };

/**
 * Per-deliverable diff result.
 *
 * Keys are deliverable ids:
 *   - For `removed`/`modified`/`unchanged` entries the key is the *old*
 *     plan's row id (callers look up by `TaskDeliverableLink.deliverableId`,
 *     which references the version the task was bound to).
 *   - For `added` entries the key is the *new* plan's row id (callers
 *     surface the new arrival in UI; no severity impact on existing tasks
 *     because nothing was linked to it yet).
 */
export type DeliverableDiff = Map<string, DeliverableDiffEntry>;

/**
 * Compute the diff between two plan versions' deliverable lists.
 *
 * Matching is by `slug` — the same identity supersedeDeliverables uses to
 * wire `supersededById` across plan versions. This means:
 *   - same slug in both lists → `modified` (when body/title/refUri differs)
 *     or `unchanged` (when nothing differs).
 *   - slug present in `from` only → `removed`.
 *   - slug present in `to` only → `added`.
 *
 * Pure: no I/O, no clock, no randomness.
 */
export function diffDeliverables(from: DeliverableLite[], to: DeliverableLite[]): DeliverableDiff {
  const result: DeliverableDiff = new Map();
  const toBySlug = new Map<string, DeliverableLite>();
  for (const d of to) toBySlug.set(d.slug, d);
  const fromSlugs = new Set<string>();

  for (const oldD of from) {
    fromSlugs.add(oldD.slug);
    const newD = toBySlug.get(oldD.slug);
    if (!newD) {
      result.set(oldD.id, { kind: 'removed' });
      continue;
    }
    const bodyChanged = oldD.body !== newD.body;
    // Normalize null and empty string as equivalent — both mean "no
    // refUri set" from the owner's perspective and we don't want a write
    // path that fills the column with '' (instead of NULL) to look like
    // a real change.
    const fromRef = oldD.refUri ?? '';
    const toRef = newD.refUri ?? '';
    const refUriChanged = fromRef !== toRef;
    const titleChanged = oldD.title !== newD.title;
    if (bodyChanged || refUriChanged || titleChanged) {
      result.set(oldD.id, {
        kind: 'modified',
        bodyChanged,
        refUriChanged,
        titleChanged,
      });
    } else {
      result.set(oldD.id, { kind: 'unchanged' });
    }
  }
  for (const newD of to) {
    if (!fromSlugs.has(newD.slug)) {
      result.set(newD.id, { kind: 'added' });
    }
  }

  return result;
}

/**
 * Classify the impact of a deliverable diff on a single task, given the
 * deliverable ids the task is linked to (via `TaskDeliverableLink`).
 *
 * See module docblock for the precise severity rules. Pure function; safe
 * to call from any package.
 */
export function severityForTaskByDeliverables(
  linkedDeliverableIds: string[],
  diff: DeliverableDiff,
): Severity {
  // R-154 step 3: a task with no link rows is intentionally NOT alerted
  // on plan changes. The whole point of the link table is that the owner
  // explicitly declares which deliverables the task depends on; without a
  // declaration the engine has no basis to pause the task.
  if (linkedDeliverableIds.length === 0) return 'low';

  let worst: Severity = 'low';
  for (const id of linkedDeliverableIds) {
    const entry = diff.get(id);
    if (!entry) continue;
    if (entry.kind === 'removed') return 'breaking';
    if (entry.kind === 'modified') {
      if (entry.bodyChanged) return 'breaking';
      if (entry.refUriChanged && worst === 'low') worst = 'medium';
      // titleChanged on its own does NOT escalate — by design (per R-154
      // verification: "rename title but id unchanged → does NOT trigger
      // high").
    }
    // 'added' and 'unchanged' do not affect existing tasks.
  }
  return worst;
}

/**
 * Compact, human-readable summary of which linked deliverables changed,
 * suitable for the `DriftAlert.reason` column. Returns null when no linked
 * deliverable appears in the diff (the caller can supply a generic message).
 */
export function describeLinkedDeliverableChanges(
  linkedDeliverableIds: string[],
  diff: DeliverableDiff,
  deliverableSlugById: Map<string, string>,
): string | null {
  const parts: string[] = [];
  for (const id of linkedDeliverableIds) {
    const entry = diff.get(id);
    if (!entry) continue;
    const slug = deliverableSlugById.get(id) ?? id;
    if (entry.kind === 'removed') {
      parts.push(`removed: ${slug}`);
    } else if (entry.kind === 'modified') {
      const fields: string[] = [];
      if (entry.bodyChanged) fields.push('body');
      if (entry.refUriChanged) fields.push('refUri');
      if (entry.titleChanged) fields.push('title');
      parts.push(`modified ${fields.join('+')}: ${slug}`);
    }
  }
  return parts.length > 0 ? parts.join('; ') : null;
}
