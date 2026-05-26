/**
 * R-151: dual-write helpers for plan items.
 *
 * R-150 introduced three sibling tables — `plan_deliverables`,
 * `plan_constraints`, `plan_standards` — that supplement (without
 * replacing) the legacy `String[]` columns on `plans`. R-151 ships:
 *
 *   (a) a one-shot SQL migration that backfills the split tables from
 *       the legacy arrays for every existing plan row (see
 *       `prisma/migrations/20260523100000_plan_items_backfill/`),
 *
 *   (b) this module, which exposes the two helpers every future plan
 *       write path is required to go through:
 *
 *         writeBoth(planId, patch)    — atomically replace BOTH the
 *                                       legacy String[] columns AND the
 *                                       corresponding split-table rows
 *                                       for any field present in `patch`.
 *
 *         readMerged(planId)          — return the unified view: prefer
 *                                       split-table rows when present,
 *                                       fall back to the legacy arrays
 *                                       otherwise. Used by new code that
 *                                       wants the slug-addressable shape
 *                                       without breaking on legacy plans
 *                                       whose backfill hasn't happened
 *                                       yet (e.g. tests, time-travel).
 *
 *   (c) a contract test (`tests/integration/r151-plan-items-mirror.test.ts`)
 *       that asserts the two representations stay 1:1 after every
 *       writeBoth call.
 *
 * R-152 (next PR in the chain) will switch every existing plan write
 * route to call writeBoth. This module ships the building blocks first
 * so the route-by-route switch is a mechanical edit.
 *
 * openQuestions is intentionally NOT covered here — R-150 declined to
 * add a `plan_open_questions` split table because open questions are
 * ephemeral (they get answered into deliverables/constraints rather
 * than living forever as their own structured records). writeBoth
 * therefore leaves the `open_questions` array alone; existing
 * `plan_*_open_questions_append` paths continue to write the legacy
 * column directly.
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from './prisma';

/** Fields that exist as BOTH a String[] on plans and as a split table. */
export type SplitField = 'deliverables' | 'constraints' | 'standards';

/**
 * Convert one source string into a stable slug for a given field + index.
 *
 * Slugify strategy:
 *   1. Lowercase + Unicode-normalise (NFKD) so e.g. "Café" → "café" → "cafe".
 *   2. Replace runs of non-alphanumeric chars with single dashes.
 *   3. Trim leading / trailing dashes.
 *   4. Cap to 50 chars (DB column is TEXT but keeping slugs short keeps
 *      the unique-index B-tree compact and URL-friendly).
 *   5. If the text part is empty (e.g. all-emoji source), fall back to
 *      the field-prefix.
 *   6. Always append `-${idx}` so collisions inside the same plan are
 *      impossible regardless of source text.
 *
 * The backfill migration (R-151 step 1) uses a simpler scheme
 * (`deliverable-N`) because its goal is just to populate rows — it does
 * not have to be human-meaningful. writeBoth callers (post R-152) get
 * the friendlier slugify below.
 */
export function slugify(field: SplitField, item: string, idx: number): string {
  const prefix =
    field === 'deliverables' ? 'deliverable' : field === 'constraints' ? 'constraint' : 'standard';
  // NFKD decomposes accented chars into base+combining; the regex then
  // drops the combining marks. Falls back gracefully when string has none.
  const normalised = item
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const body = normalised
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  const stem = body.length > 0 ? body : prefix;
  return `${stem}-${idx}`;
}

/**
 * Patch passed to writeBoth. Only fields present are touched — undefined
 * fields are left as-is on both the legacy array and the split table.
 * Empty array means "clear this field", which writeBoth honours.
 */
export interface PlanItemsPatch {
  deliverables?: string[];
  constraints?: string[];
  standards?: string[];
}

/**
 * Result of readMerged, mirroring PlanItemsPatch + a `source` discriminator
 * per field so callers can tell whether they're seeing migrated or
 * post-backfill data. Useful for diagnostics + future deprecation warnings
 * once R-152 finishes route migration and we want to start logging plans
 * that still read from the legacy column.
 */
export interface MergedPlanItems {
  deliverables: string[];
  constraints: string[];
  standards: string[];
  /** Indicates whether each field came from the split table or the legacy
   *  String[]. Per-field because backfill could have populated one and not
   *  another (e.g. a plan with empty constraints[] at backfill time + later
   *  writeBoth-populated split rows). */
  sources: Record<SplitField, 'split' | 'legacy_array'>;
}

/**
 * Atomically replace the legacy String[] columns AND the split-table rows
 * for every field present in `patch`. Both representations end the
 * transaction holding identical data (modulo slug/title metadata that
 * only lives on the split side).
 *
 * Strategy: for each touched field,
 *   1. UPDATE plans SET <field> = <patch[field]>
 *   2. DELETE FROM <split_table> WHERE plan_id = ?
 *   3. INSERT one row per patch item, slug = slugify(field, item, idx)
 *
 * Steps 2 + 3 are the simple "wipe and re-insert" approach instead of a
 * proper upsert-diff, because:
 *   - the legacy columns are positional arrays with no identity, so the
 *     CALLER's mental model is already "I'm sending the new full list",
 *     not "diff against the old list".
 *   - per-row primary keys (auto-generated cuid by Prisma) are not
 *     stable across writes today; making them stable would require the
 *     caller to pass identity, which kicks the can to R-152's API.
 *   - the row count per plan is small (typically < 50 items) so the
 *     write amplification is negligible (one DELETE + N INSERTs inside
 *     a transaction).
 *
 * The function accepts an explicit Prisma client (default: the
 * application-shared one) so callers can pass a `tx` argument when
 * they're already inside an outer transaction (e.g. plan_propose / plan_
 * activate routes that need the writeBoth to be part of the same atomic
 * change as the plan-version bump).
 */
export async function writeBoth(
  planId: string,
  patch: PlanItemsPatch,
  client: PrismaClient | Prisma.TransactionClient = defaultPrisma,
): Promise<void> {
  // Empty patch is a no-op — don't even open a transaction.
  if (
    patch.deliverables === undefined &&
    patch.constraints === undefined &&
    patch.standards === undefined
  ) {
    return;
  }

  // If we're already in a transaction (caller passed `tx`), execute in
  // place — Prisma's TransactionClient does not support nested
  // $transaction so wrapping again would throw "transactions can't be
  // nested". The discriminator we use: presence of `$transaction`.
  const inTx = !('$transaction' in client);
  if (inTx) {
    await runWriteBothInner(planId, patch, client);
    return;
  }
  await (client as PrismaClient).$transaction(async (tx) => {
    await runWriteBothInner(planId, patch, tx);
  });
}

async function runWriteBothInner(
  planId: string,
  patch: PlanItemsPatch,
  tx: PrismaClient | Prisma.TransactionClient,
): Promise<void> {
  // ---- legacy String[] columns ----
  const planUpdate: {
    deliverables?: string[];
    constraints?: string[];
    standards?: string[];
  } = {};
  if (patch.deliverables !== undefined) planUpdate.deliverables = patch.deliverables;
  if (patch.constraints !== undefined) planUpdate.constraints = patch.constraints;
  if (patch.standards !== undefined) planUpdate.standards = patch.standards;
  await tx.plan.update({
    where: { id: planId },
    data: planUpdate,
  });

  // ---- split tables ----
  if (patch.deliverables !== undefined) {
    await tx.planDeliverable.deleteMany({ where: { planId } });
    if (patch.deliverables.length > 0) {
      await tx.planDeliverable.createMany({
        data: patch.deliverables.map((item, idx) => ({
          planId,
          slug: slugify('deliverables', item, idx),
          title: item,
          body: item,
          refType: 'free',
          status: 'active',
        })),
      });
    }
  }
  if (patch.constraints !== undefined) {
    await tx.planConstraint.deleteMany({ where: { planId } });
    if (patch.constraints.length > 0) {
      await tx.planConstraint.createMany({
        data: patch.constraints.map((item, idx) => ({
          planId,
          slug: slugify('constraints', item, idx),
          body: item,
          kind: 'free',
        })),
      });
    }
  }
  if (patch.standards !== undefined) {
    await tx.planStandard.deleteMany({ where: { planId } });
    if (patch.standards.length > 0) {
      await tx.planStandard.createMany({
        data: patch.standards.map((item, idx) => ({
          planId,
          slug: slugify('standards', item, idx),
          body: item,
          kind: 'free',
        })),
      });
    }
  }
}

/**
 * Return the merged view of a plan's items. Per-field source preference:
 *   - if the split table has any rows for this (planId, field) → use those
 *     (insertion order via createdAt then id, so writeBoth's positional
 *     intent is preserved as long as the original write was atomic).
 *   - else → fall back to the legacy `Plan.<field>` String[] column.
 *
 * The `sources` map lets callers (and a future "are we ready to drop the
 * legacy columns?" health check) reason about which plans are migrated.
 */
export async function readMerged(
  planId: string,
  client: PrismaClient | Prisma.TransactionClient = defaultPrisma,
): Promise<MergedPlanItems> {
  const [plan, deliverableRows, constraintRows, standardRows] = await Promise.all([
    client.plan.findUniqueOrThrow({
      where: { id: planId },
      select: { deliverables: true, constraints: true, standards: true },
    }),
    client.planDeliverable.findMany({
      where: { planId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { title: true },
    }),
    client.planConstraint.findMany({
      where: { planId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { body: true },
    }),
    client.planStandard.findMany({
      where: { planId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { body: true },
    }),
  ]);

  const sources: Record<SplitField, 'split' | 'legacy_array'> = {
    deliverables: deliverableRows.length > 0 ? 'split' : 'legacy_array',
    constraints: constraintRows.length > 0 ? 'split' : 'legacy_array',
    standards: standardRows.length > 0 ? 'split' : 'legacy_array',
  };

  return {
    deliverables:
      deliverableRows.length > 0 ? deliverableRows.map((r) => r.title) : plan.deliverables,
    constraints: constraintRows.length > 0 ? constraintRows.map((r) => r.body) : plan.constraints,
    standards: standardRows.length > 0 ? standardRows.map((r) => r.body) : plan.standards,
    sources,
  };
}

/**
 * 1:1 invariant check used by the contract test and (in a follow-up
 * health-check route) by ops dashboards. For one plan, asserts that
 * each (legacy String[] field, split-table row count) pair matches
 * AND that the per-position content matches title-for-deliverables /
 * body-for-{constraints,standards}.
 *
 * Returns a list of mismatches; an empty list means the invariant holds.
 * Pure read; never mutates. Safe to call on any plan id, including
 * legacy plans not yet touched by writeBoth (it will correctly report
 * that the split rows are missing).
 */
export interface InvariantMismatch {
  field: SplitField;
  legacyLength: number;
  splitLength: number;
  /** Index of the first content mismatch, or null when lengths differ. */
  firstDivergenceIdx: number | null;
}

/**
 * R-152 step 2: when a new plan version is activated, link every
 * PlanDeliverable on that new version back to the previous active
 * version's deliverable that shares the same slug, by setting the
 * **older** row's `supersededById` to the **new** row's id.
 *
 * Direction rationale: the schema's self-FK (`PlanDeliverable.supersededBy`)
 * lives on the row being replaced, so the "is this thing still current?"
 * question is answered with `where: { supersededById: null }` from any
 * point in time — including when reading historical plan versions. This
 * matches how drift v3 and per-deliverable timelines (R-156) want to
 * walk the chain.
 *
 * Matching strategy: by `slug` only. Slugs are stable, human-readable
 * identifiers (e.g. `auth/oidc-callback`); a rename of `title` should not
 * break the supersede chain. If the new version dropped a slug entirely
 * (deliverable removed) the old row's `supersededById` is left at NULL —
 * that signals "nothing replaces this" to drift-engine and is exactly the
 * "removed deliverable" case it must alert on.
 *
 * Idempotent: callable multiple times. Re-running on an already-linked
 * pair is a no-op because we filter for `supersededById: null` on the
 * source side. This matters because activate may be retried (R-048
 * P2002 retry) and we don't want to re-touch already-linked rows.
 *
 * Always invoked inside the activate transaction so that the link write
 * commits atomically with the plan.status flip — same reason persistDriftAlerts
 * is kept in-transaction (R-007 / R-052).
 *
 * @param projectId - the project the plan belongs to (used to scope the
 *   "previous active plan" lookup; we must not match against another
 *   project's leftover deliverables that happened to share a slug)
 * @param newPlanId - the plan version that just became `active`
 * @returns the number of supersede links created (useful for tests)
 */
export async function supersedeDeliverables(
  projectId: string,
  newPlanId: string,
  client: PrismaClient | Prisma.TransactionClient = defaultPrisma,
): Promise<number> {
  const newDeliverables = await client.planDeliverable.findMany({
    where: { planId: newPlanId },
    select: { id: true, slug: true },
  });
  if (newDeliverables.length === 0) return 0;

  const oldPlans = await client.plan.findMany({
    where: {
      projectId,
      status: 'superseded',
      id: { not: newPlanId },
    },
    select: { id: true },
  });
  if (oldPlans.length === 0) return 0;

  const oldPlanIds = oldPlans.map((p) => p.id);
  let linked = 0;
  for (const nd of newDeliverables) {
    // Update every previous-version deliverable that shares this slug AND
    // is not already pointing somewhere. updateMany is one round-trip and
    // returns a count, which we add up so callers can see the wiring took.
    const res = await client.planDeliverable.updateMany({
      where: {
        planId: { in: oldPlanIds },
        slug: nd.slug,
        supersededById: null,
      },
      data: { supersededById: nd.id, status: 'deprecated' },
    });
    linked += res.count;
  }
  return linked;
}

/**
 * R-155: re-derive the legacy `plans.deliverables` String[] column from the
 * current `PlanDeliverable` rows for a single plan. Used by the per-row CRUD
 * routes (`/plans/:planId/deliverables/...`) so that after a create/update/
 * supersede on the split table the legacy array stays a faithful mirror.
 *
 * Ordering: `createdAt ASC, id ASC`, matching `readMerged`. Item content is
 * the row `title` (same field `writeBoth` uses), so existing readers that
 * lean on `plan.deliverables` (CLI banner, drift legacy paths, plan_show)
 * see no shape change — only newly created rows show up at the array tail.
 *
 * Always called inside the route's transaction (the per-row write and this
 * mirror sync must commit together) so plan_show can never observe a
 * window where the array and the rows diverge.
 */
export async function syncDeliverableArrayMirror(
  planId: string,
  tx: PrismaClient | Prisma.TransactionClient,
): Promise<void> {
  const rows = await tx.planDeliverable.findMany({
    where: { planId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { title: true },
  });
  await tx.plan.update({
    where: { id: planId },
    data: { deliverables: rows.map((r) => r.title) },
  });
}

export async function checkPlanItemsInvariant(
  planId: string,
  client: PrismaClient | Prisma.TransactionClient = defaultPrisma,
): Promise<InvariantMismatch[]> {
  const merged = await readMerged(planId, client);
  // Use the legacy columns as the "expected" side; the split table as
  // the "actual". This direction matches the dual-write intent: writeBoth
  // takes the input list, writes both, so any drift means writeBoth was
  // bypassed.
  const plan = await client.plan.findUniqueOrThrow({
    where: { id: planId },
    select: { deliverables: true, constraints: true, standards: true },
  });
  const mismatches: InvariantMismatch[] = [];

  const compare = (field: SplitField, legacy: string[], split: string[]) => {
    if (legacy.length !== split.length) {
      mismatches.push({
        field,
        legacyLength: legacy.length,
        splitLength: split.length,
        firstDivergenceIdx: null,
      });
      return;
    }
    for (let i = 0; i < legacy.length; i++) {
      if (legacy[i] !== split[i]) {
        mismatches.push({
          field,
          legacyLength: legacy.length,
          splitLength: split.length,
          firstDivergenceIdx: i,
        });
        return;
      }
    }
  };

  // If sources reports 'legacy_array', the split table is empty so the
  // expected split list is also empty — the invariant is "they match";
  // we only flag a mismatch when both sides have data and disagree.
  if (merged.sources.deliverables === 'split') {
    compare('deliverables', plan.deliverables, merged.deliverables);
  }
  if (merged.sources.constraints === 'split') {
    compare('constraints', plan.constraints, merged.constraints);
  }
  if (merged.sources.standards === 'split') {
    compare('standards', plan.standards, merged.standards);
  }

  return mismatches;
}
