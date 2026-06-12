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
 *   - Task with no `deliverableLinks` rows → 'medium' when the diff carries a
 *     breaking change (a deliverable removed or its body rewritten), else
 *     'low' (R-207). Before R-154 the engine biased toward 'breaking' for
 *     ALL legacy tasks; that produced an alert on every plan activation for
 *     every task in the project even when nothing material changed. R-154
 *     step 3 over-corrected to unconditional 'low', which left the headline
 *     "can never complete against a stale plan" promise off by default (new
 *     tasks have no links). R-207 keeps R-154's anti-fatigue guarantee for
 *     cosmetic changes (typo in goal, title rename, refUri move → still
 *     'low') but gates a no-link task at 'medium' when the contract it might
 *     depend on was genuinely broken — verify-before-complete rather than
 *     silent pass-through. Owners who want zero drift interruptions for a
 *     task still declare its links via `syncTaskDeliverableLinks` (R-153);
 *     once declared, the precise per-link rules above apply instead.
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
 * Does this diff carry a *breaking* change at the plan level — a deliverable
 * removed outright, or one whose `body` (the contract text an agent reads)
 * was rewritten? refUri-only, title-only, `added` and `unchanged` entries are
 * deliberately excluded: they are re-orient/cosmetic signals, not a broken
 * contract. Used to decide whether a task that has NOT declared its
 * dependencies should still be gated (R-207).
 *
 * Pure function; safe to call from any package.
 */
export function diffHasBreakingChange(diff: DeliverableDiff): boolean {
  for (const entry of diff.values()) {
    if (entry.kind === 'removed') return true;
    if (entry.kind === 'modified' && entry.bodyChanged) return true;
  }
  return false;
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
  // R-207: a task with no link rows used to return 'low' unconditionally
  // (R-154 step 3). That left PlanSync's headline promise — "agents can
  // never accidentally complete work bound to a stale plan" — false BY
  // DEFAULT: every newly-created task starts with zero deliverable links,
  // so a running no-link task could sail past the gate and complete() against
  // a superseded plan.
  //
  // The fix threads the needle instead of resurrecting R-154's alert fatigue:
  // a no-link task is escalated to 'medium' ONLY when the plan diff carries a
  // genuinely breaking change (a deliverable removed, or its body rewritten).
  // A typo fix in goal/scope, a title rename, or a refUri move produces no
  // breaking diff entry, so those still resolve to 'low' and do NOT pause the
  // project — R-154's anti-fatigue guarantee holds. But when the contract the
  // task *might* depend on materially changed and the task never declared
  // independence from it, we gate at 'medium' ("verify before completing")
  // rather than let it through silently. 'medium' (not 'breaking') because
  // without link rows we cannot prove the task is actually affected.
  if (linkedDeliverableIds.length === 0) {
    return diffHasBreakingChange(diff) ? 'medium' : 'low';
  }

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
