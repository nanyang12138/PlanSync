/**
 * Drift engine unit tests — drift v3 (deliverable-id-based severity, R-154).
 *
 * Before R-154 the engine used the text-hash structural diff in
 * `@plansync/shared/drift/structural-diff.ts` over Plan.* String[] columns
 * and treated every plan change (goal, scope, constraints, standards) as a
 * potential severity driver. After R-154 severity is computed from the
 * PlanDeliverable diff (by `id`/`slug`), with the explicit "no link rows →
 * severity=low" opt-out that drops alert fatigue from unrelated changes.
 *
 * The exhaustive coverage of the new pure classifier lives in
 * `packages/shared/tests/drift/deliverable-diff.test.ts` (deterministic, no
 * DB). This file covers what only the engine can: stitching the per-version
 * deliverable diff with each task's link rows, mapping severity onto the
 * persisted enum, and carrying the "has-running-execution" signal through
 * to `persistDriftAlerts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above all imports, so the mock objects must
// be declared via vi.hoisted to live in the same hoisted scope.
const mocks = vi.hoisted(() => ({
  taskFindMany: vi.fn(),
  planFindFirst: vi.fn(),
  planFindMany: vi.fn(),
  planDeliverableFindMany: vi.fn(),
  driftAlertCreateManyAndReturn: vi.fn(),
  executionRunUpdateMany: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    task: { findMany: mocks.taskFindMany },
    plan: { findFirst: mocks.planFindFirst, findMany: mocks.planFindMany },
    planDeliverable: { findMany: mocks.planDeliverableFindMany },
    driftAlert: { createManyAndReturn: mocks.driftAlertCreateManyAndReturn },
    executionRun: { updateMany: mocks.executionRunUpdateMany },
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/email', () => ({ sendMail: vi.fn(), userEmail: (n: string) => `${n}@x` }));
vi.mock('@/lib/event-bus', () => ({
  eventBus: { publish: vi.fn(), publishToUser: vi.fn() },
}));
vi.mock('@/lib/ai/client', () => ({ aiClient: { isAvailable: false } }));
vi.mock('@/lib/ai/plan-diff', () => ({ getOrCreatePlanDiff: vi.fn() }));
vi.mock('@/lib/ai/impact-analysis', () => ({ analyzeTaskImpact: vi.fn() }));

// Same surface as the engine expects but bound to the hoisted mocks so each
// test sees the assertions made via mocks.*.
const tx = {
  task: { findMany: mocks.taskFindMany },
  plan: { findFirst: mocks.planFindFirst, findMany: mocks.planFindMany },
  planDeliverable: { findMany: mocks.planDeliverableFindMany },
  driftAlert: { createManyAndReturn: mocks.driftAlertCreateManyAndReturn },
  executionRun: { updateMany: mocks.executionRunUpdateMany },
} as const;

import { runDriftScan, persistDriftAlerts } from '@/lib/drift-engine';

interface PlanRowOpts {
  goal?: string;
  scope?: string;
  constraints?: string[];
  standards?: string[];
  deliverables?: string[];
}

function planRow(version: number, partial: PlanRowOpts = {}) {
  return {
    id: `plan-${version}`,
    projectId: 'p1',
    version,
    title: `v${version}`,
    goal: partial.goal ?? 'ship it',
    scope: partial.scope ?? 'web',
    constraints: partial.constraints ?? [],
    standards: partial.standards ?? [],
    deliverables: partial.deliverables ?? [],
    openQuestions: [] as string[],
    requiredReviewers: [] as string[],
  };
}

interface DeliverableInput {
  id: string;
  planId: string;
  slug: string;
  title?: string;
  body?: string;
  refUri?: string | null;
  // #2923: row lifecycle. Defaults to 'active'. A 'deprecated' row on the new
  // plan version models a deleted deliverable and is dropped from the new
  // version's live set by the engine.
  status?: string;
}

/**
 * Convenience: build a PlanDeliverable row with sensible defaults so each
 * test only has to spell out the columns it cares about (typically just
 * id + slug + body).
 */
function deliv(d: DeliverableInput) {
  return {
    id: d.id,
    planId: d.planId,
    slug: d.slug,
    title: d.title ?? d.slug,
    body: d.body ?? d.slug,
    refUri: d.refUri ?? null,
    status: d.status ?? 'active',
  };
}

interface TaskRowOpts {
  boundPlanVersion: number;
  status?: string;
  running?: boolean;
  // Deliverable ids the task is linked to via `task_deliverable_links`.
  // Empty array (the default) means "no link rows" — R-154 step 3 paths
  // through severity=low.
  linkedDeliverableIds?: string[];
}

function taskRow(id: string, partial: TaskRowOpts) {
  return {
    id,
    projectId: 'p1',
    title: `Task ${id}`,
    status: partial.status ?? 'todo',
    boundPlanVersion: partial.boundPlanVersion,
    // Legacy columns are kept around so the Prisma `include` shape stays
    // honest; the R-154 engine ignores them. Setting them to `[]` ensures
    // a regression that re-reads from the legacy column would fail to
    // produce 'high' (instead of silently relying on the legacy default).
    planDeliverableRefs: [] as string[],
    planConstraintRefs: [] as string[],
    planStandardRefs: [] as string[],
    executionRuns: partial.running ? [{ status: 'running' }] : [],
    deliverableLinks: (partial.linkedDeliverableIds ?? []).map((id) => ({
      deliverable: { id, slug: `slug-${id}` },
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // R-154 default: no PlanDeliverable rows. Tests that exercise the
  // deliverable diff override this with mockResolvedValueOnce.
  mocks.planDeliverableFindMany.mockResolvedValue([]);
});

describe('runDriftScan — R-154 deliverable-id-based severity', () => {
  it('removed deliverable → severity="high" for the task linked to it; other tasks → "low"', async () => {
    tx.task.findMany.mockResolvedValueOnce([
      taskRow('t-linked', { boundPlanVersion: 1, linkedDeliverableIds: ['d-rest'] }),
      taskRow('t-unrelated', { boundPlanVersion: 1, linkedDeliverableIds: ['d-docs'] }),
    ]);
    tx.plan.findFirst.mockResolvedValueOnce(planRow(2));
    tx.plan.findMany.mockResolvedValueOnce([planRow(1)]);
    // v1 had two deliverables; v2 dropped 'rest-api' → 'd-rest' is removed.
    mocks.planDeliverableFindMany.mockResolvedValueOnce([
      deliv({ id: 'd-rest', planId: 'plan-1', slug: 'rest-api', body: 'rest api spec' }),
      deliv({ id: 'd-docs', planId: 'plan-1', slug: 'docs', body: 'docs site' }),
      deliv({ id: 'd-docs-2', planId: 'plan-2', slug: 'docs', body: 'docs site' }),
    ]);

    const { alerts } = await runDriftScan(tx as unknown as never, 'p1', 2);
    const byId = new Map(alerts.map((a) => [a.taskId, a]));
    expect(byId.get('t-linked')?.severity).toBe('high');
    expect(byId.get('t-linked')?.structuralSeverity).toBe('breaking');
    expect(byId.get('t-linked')?.reason).toMatch(/removed: rest-api/);
    // The other task's linked deliverable is unchanged → low.
    expect(byId.get('t-unrelated')?.severity).toBe('low');
    expect(byId.get('t-unrelated')?.structuralSeverity).toBe('low');
  });

  it('modified body of a linked deliverable → severity="high"', async () => {
    tx.task.findMany.mockResolvedValueOnce([
      taskRow('t1', { boundPlanVersion: 1, linkedDeliverableIds: ['d-rest'] }),
    ]);
    tx.plan.findFirst.mockResolvedValueOnce(planRow(2));
    tx.plan.findMany.mockResolvedValueOnce([planRow(1)]);
    mocks.planDeliverableFindMany.mockResolvedValueOnce([
      deliv({ id: 'd-rest', planId: 'plan-1', slug: 'rest-api', body: 'OpenAPI v1' }),
      deliv({ id: 'd-rest-2', planId: 'plan-2', slug: 'rest-api', body: 'OpenAPI v2' }),
    ]);

    const { alerts } = await runDriftScan(tx as unknown as never, 'p1', 2);
    expect(alerts[0].severity).toBe('high');
    expect(alerts[0].structuralSeverity).toBe('breaking');
    expect(alerts[0].reason).toMatch(/modified body: rest-api/);
  });

  it('modified refUri only → severity="medium"', async () => {
    tx.task.findMany.mockResolvedValueOnce([
      taskRow('t1', { boundPlanVersion: 1, linkedDeliverableIds: ['d-fig'] }),
    ]);
    tx.plan.findFirst.mockResolvedValueOnce(planRow(2));
    tx.plan.findMany.mockResolvedValueOnce([planRow(1)]);
    mocks.planDeliverableFindMany.mockResolvedValueOnce([
      deliv({
        id: 'd-fig',
        planId: 'plan-1',
        slug: 'mock-figma',
        body: 'sign-in screen',
        refUri: 'https://figma.com/file/AAA',
      }),
      deliv({
        id: 'd-fig-2',
        planId: 'plan-2',
        slug: 'mock-figma',
        body: 'sign-in screen',
        refUri: 'https://figma.com/file/BBB',
      }),
    ]);

    const { alerts } = await runDriftScan(tx as unknown as never, 'p1', 2);
    expect(alerts[0].severity).toBe('medium');
    expect(alerts[0].structuralSeverity).toBe('medium');
    expect(alerts[0].reason).toMatch(/modified refUri: mock-figma/);
  });

  // R-154 verification (first half): rename title but id (slug) unchanged
  // and body/refUri identical → does NOT trigger high.
  it('rename title only (slug/body/refUri unchanged) → does NOT trigger high', async () => {
    tx.task.findMany.mockResolvedValueOnce([
      taskRow('t1', {
        boundPlanVersion: 1,
        linkedDeliverableIds: ['d-rest'],
        running: true,
      }),
    ]);
    tx.plan.findFirst.mockResolvedValueOnce(planRow(2));
    tx.plan.findMany.mockResolvedValueOnce([planRow(1)]);
    mocks.planDeliverableFindMany.mockResolvedValueOnce([
      deliv({
        id: 'd-rest',
        planId: 'plan-1',
        slug: 'rest-api',
        title: 'REST API',
        body: 'spec',
      }),
      deliv({
        id: 'd-rest-2',
        planId: 'plan-2',
        slug: 'rest-api',
        // Owner just polished the title; semantically identical contract.
        title: 'REST API (v1)',
        body: 'spec',
      }),
    ]);

    const { alerts } = await runDriftScan(tx as unknown as never, 'p1', 2);
    expect(alerts[0].severity).not.toBe('high');
    expect(alerts[0].severity).toBe('low');
    expect(alerts[0].structuralSeverity).toBe('low');
  });

  // R-207: empty link table is no longer an unconditional 'low'. A breaking
  // diff (deliverable removed or body rewritten) gates an unlinked task at
  // 'medium' so it cannot silently complete against a stale plan; a cosmetic
  // diff still stays 'low' (R-154 anti-fatigue preserved).
  it('task with no deliverableLinks + breaking diff (removed deliverable) → severity="medium" (R-207)', async () => {
    tx.task.findMany.mockResolvedValueOnce([
      taskRow('t-orphan', { boundPlanVersion: 1, linkedDeliverableIds: [] }),
    ]);
    tx.plan.findFirst.mockResolvedValueOnce(
      planRow(2, { goal: 'TOTALLY DIFFERENT GOAL', scope: 'mobile only' }),
    );
    tx.plan.findMany.mockResolvedValueOnce([planRow(1)]);
    // v2 removed 'old-thing' and added 'new-thing' → a breaking change at the
    // plan level. The unlinked task can't prove it's unaffected → gate medium.
    mocks.planDeliverableFindMany.mockResolvedValueOnce([
      deliv({ id: 'd-old', planId: 'plan-1', slug: 'old-thing', body: 'gone' }),
      deliv({ id: 'd-new', planId: 'plan-2', slug: 'new-thing', body: 'arrived' }),
    ]);

    const { alerts } = await runDriftScan(tx as unknown as never, 'p1', 2);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('medium');
    expect(alerts[0].structuralSeverity).toBe('medium');
    expect(alerts[0].reason).toMatch(/no deliverable links/i);
    expect(alerts[0].reason).toMatch(/breaking deliverable change/i);
  });

  it('task with no deliverableLinks + cosmetic diff (title-only rename) → severity="low" (R-207 keeps R-154 anti-fatigue)', async () => {
    tx.task.findMany.mockResolvedValueOnce([
      taskRow('t-orphan', { boundPlanVersion: 1, linkedDeliverableIds: [] }),
    ]);
    tx.plan.findFirst.mockResolvedValueOnce(planRow(2));
    tx.plan.findMany.mockResolvedValueOnce([planRow(1)]);
    // Same slug + same body across versions; only the title polished. No
    // breaking change → unlinked task stays low, no gate, no fatigue.
    mocks.planDeliverableFindMany.mockResolvedValueOnce([
      deliv({ id: 'd-old', planId: 'plan-1', slug: 'rest-api', title: 'REST API', body: 'spec' }),
      deliv({
        id: 'd-new',
        planId: 'plan-2',
        slug: 'rest-api',
        title: 'REST API (v1)',
        body: 'spec',
      }),
    ]);

    const { alerts } = await runDriftScan(tx as unknown as never, 'p1', 2);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('low');
    expect(alerts[0].structuralSeverity).toBe('low');
    expect(alerts[0].reason).toMatch(/no deliverable links/i);
    expect(alerts[0].reason).toMatch(/nothing breaking/i);
  });

  // #2923: a deliverable "deleted" in the new version is modelled as a row
  // with status='deprecated' (slug/body survive for the audit chains). The
  // engine must drop deprecated rows from the *new* version's live set so the
  // diff reports a removal. The old version's rows are left whole — note the
  // v1 row below is itself 'deprecated' (simulating the post-`supersedeDeliverables`
  // state inside the activate transaction), and it must STILL count as the
  // pre-deletion live deliverable, otherwise the removal would be invisible.
  it('linked deliverable deprecated on the new version → severity="high" (#2923)', async () => {
    tx.task.findMany.mockResolvedValueOnce([
      taskRow('t-linked', { boundPlanVersion: 1, linkedDeliverableIds: ['d-auth'] }),
    ]);
    tx.plan.findFirst.mockResolvedValueOnce(planRow(2));
    tx.plan.findMany.mockResolvedValueOnce([planRow(1)]);
    mocks.planDeliverableFindMany.mockResolvedValueOnce([
      // v1 'auth' — supersede already flipped it to 'deprecated' as a
      // forward-link artifact; it must still represent the live v1 deliverable.
      deliv({
        id: 'd-auth',
        planId: 'plan-1',
        slug: 'auth',
        body: 'auth spec',
        status: 'deprecated',
      }),
      // v2 'auth' — the deletion: same slug/body, status='deprecated'. Without
      // the #2923 filter this reads as 'unchanged' and passes at 'low'.
      deliv({
        id: 'd-auth-2',
        planId: 'plan-2',
        slug: 'auth',
        body: 'auth spec',
        status: 'deprecated',
      }),
    ]);

    const { alerts } = await runDriftScan(tx as unknown as never, 'p1', 2);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('high');
    expect(alerts[0].structuralSeverity).toBe('breaking');
    expect(alerts[0].reason).toMatch(/removed: auth/);
  });

  it('no-link task + deliverable deprecated on the new version → severity="medium" (#2923 R-207 gate)', async () => {
    tx.task.findMany.mockResolvedValueOnce([
      taskRow('t-orphan', { boundPlanVersion: 1, linkedDeliverableIds: [] }),
    ]);
    tx.plan.findFirst.mockResolvedValueOnce(planRow(2));
    tx.plan.findMany.mockResolvedValueOnce([planRow(1)]);
    mocks.planDeliverableFindMany.mockResolvedValueOnce([
      deliv({
        id: 'd-auth',
        planId: 'plan-1',
        slug: 'auth',
        body: 'auth spec',
        status: 'deprecated',
      }),
      deliv({
        id: 'd-auth-2',
        planId: 'plan-2',
        slug: 'auth',
        body: 'auth spec',
        status: 'deprecated',
      }),
    ]);

    const { alerts } = await runDriftScan(tx as unknown as never, 'p1', 2);
    expect(alerts).toHaveLength(1);
    // The deletion is a breaking change; an unlinked task can't prove it's
    // unaffected → gate at medium instead of slipping through at low.
    expect(alerts[0].severity).toBe('medium');
    expect(alerts[0].structuralSeverity).toBe('medium');
    expect(alerts[0].reason).toMatch(/no deliverable links/i);
    expect(alerts[0].reason).toMatch(/breaking deliverable change/i);
  });

  it('hasRunningExecution is carried on the alert independent of severity', async () => {
    tx.task.findMany.mockResolvedValueOnce([
      taskRow('t-running', { boundPlanVersion: 1, running: true }),
      taskRow('t-idle', { boundPlanVersion: 1, running: false }),
    ]);
    tx.plan.findFirst.mockResolvedValueOnce(planRow(2));
    tx.plan.findMany.mockResolvedValueOnce([planRow(1)]);

    const { alerts } = await runDriftScan(tx as unknown as never, 'p1', 2);
    expect(alerts.find((a) => a.taskId === 't-running')?.hasRunningExecution).toBe(true);
    expect(alerts.find((a) => a.taskId === 't-idle')?.hasRunningExecution).toBe(false);
  });

  it('falls back to severity="high" when the bound plan row is missing (defensive default)', async () => {
    tx.task.findMany.mockResolvedValueOnce([taskRow('t1', { boundPlanVersion: 99 })]);
    tx.plan.findFirst.mockResolvedValueOnce(planRow(2));
    tx.plan.findMany.mockResolvedValueOnce([]); // no v99 row

    const { alerts } = await runDriftScan(tx as unknown as never, 'p1', 2);
    expect(alerts[0].severity).toBe('high');
    expect(alerts[0].structuralSeverity).toBe('breaking');
    expect(alerts[0].reason).toMatch(/cannot compute structural diff/i);
  });

  it('cancelled tasks are excluded from the scan (unchanged contract)', async () => {
    // The where clause uses status notIn ['cancelled']. We assert that the
    // engine asks for that by inspecting the findMany call args.
    tx.task.findMany.mockResolvedValueOnce([]);
    await runDriftScan(tx as unknown as never, 'p1', 2);
    const call = tx.task.findMany.mock.calls[0]?.[0] as {
      where?: { status?: { notIn?: string[] } };
    };
    expect(call?.where?.status?.notIn).toContain('cancelled');
  });

  it('returns no alerts when all tasks are already on the new version', async () => {
    tx.task.findMany.mockResolvedValueOnce([]);
    const { alerts } = await runDriftScan(tx as unknown as never, 'p1', 2);
    expect(alerts).toEqual([]);
    expect(tx.plan.findFirst).not.toHaveBeenCalled();
  });
});

describe('persistDriftAlerts — pause rule keys off (severity >= medium) AND hasRunningExecution', () => {
  function setupCreate() {
    tx.driftAlert.createManyAndReturn.mockResolvedValueOnce([
      { id: 'a1' },
      { id: 'a2' },
      { id: 'a3' },
    ]);
    tx.executionRun.updateMany.mockResolvedValue({ count: 0 });
  }

  function buildAlerts() {
    return [
      // breaking + running → pause + block
      {
        taskId: 't-breaking-running',
        severity: 'high' as const,
        reason: 'breaking',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
        hasRunningExecution: true,
      },
      // medium + idle → block but no pause (nothing to interrupt)
      {
        taskId: 't-medium-idle',
        severity: 'medium' as const,
        reason: 'scope changed',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
        hasRunningExecution: false,
      },
      // low + running → must NOT pause and must NOT block; the change does
      // not affect this task by definition.
      {
        taskId: 't-low-running',
        severity: 'low' as const,
        reason: 'unrelated change',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
        hasRunningExecution: true,
      },
    ];
  }

  // Prisma-shaped tx; we expose enough of the API for persistDriftAlerts.
  const driftUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
  const persistTx = {
    driftAlert: {
      createManyAndReturn: tx.driftAlert.createManyAndReturn,
      // R-051: persistDriftAlerts supersedes prior open alerts before
      // creating new ones. Provide updateMany so the supersede step has
      // somewhere to go.
      updateMany: driftUpdateMany,
    },
    task: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    executionRun: { updateMany: tx.executionRun.updateMany },
  };

  beforeEach(() => {
    persistTx.task.updateMany.mockClear();
    tx.executionRun.updateMany.mockClear();
    tx.driftAlert.createManyAndReturn.mockClear();
    driftUpdateMany.mockClear();
  });

  it('gates every task with severity >= medium via executionGate; leaves low-severity tasks alone (R-140)', async () => {
    setupCreate();
    await persistDriftAlerts(persistTx as unknown as never, 'p1', buildAlerts());

    // R-140: per-severity gate value, so the engine calls updateMany once
    // per non-empty severity bucket (here both 'high' and 'medium' have at
    // least one alert). Neither call writes to task.status — that column
    // is reserved for owner-meaningful state.
    expect(persistTx.task.updateMany).toHaveBeenCalledTimes(2);
    const calls = persistTx.task.updateMany.mock.calls.map(
      (c) =>
        c[0] as {
          where: { id: { in: string[] } };
          data: { executionGate?: string; status?: string };
        },
    );
    const highCall = calls.find((c) => c.data.executionGate === 'drift_high');
    const mediumCall = calls.find((c) => c.data.executionGate === 'drift_medium');
    expect(highCall, 'expected one updateMany with executionGate=drift_high').toBeDefined();
    expect(mediumCall, 'expected one updateMany with executionGate=drift_medium').toBeDefined();
    expect(highCall!.where.id.in).toEqual(['t-breaking-running']);
    expect(mediumCall!.where.id.in).toEqual(['t-medium-idle']);
    // Crucially: no call sets status='blocked' anymore. The system gate is
    // executionGate; status stays at whatever the lifecycle was before.
    for (const call of calls) {
      expect(call.data.status).toBeUndefined();
    }
    // And low-severity tasks are never touched.
    for (const call of calls) {
      expect(call.where.id.in).not.toContain('t-low-running');
    }
  });

  it('pauses only the subset of blocked tasks that have a running execution', async () => {
    setupCreate();
    await persistDriftAlerts(persistTx as unknown as never, 'p1', buildAlerts());

    expect(tx.executionRun.updateMany).toHaveBeenCalledTimes(1);
    const pauseCall = tx.executionRun.updateMany.mock.calls[0][0] as {
      where: { taskId: { in: string[] }; status: string };
      data: { status: string };
    };
    expect(pauseCall.data.status).toBe('paused');
    expect(pauseCall.where.status).toBe('running'); // race protection
    expect(pauseCall.where.taskId.in).toEqual(['t-breaking-running']);
  });

  it('does nothing when all alerts are low severity (no block, no pause)', async () => {
    tx.driftAlert.createManyAndReturn.mockResolvedValueOnce([{ id: 'a1' }]);

    await persistDriftAlerts(persistTx as unknown as never, 'p1', [
      {
        taskId: 't-low',
        severity: 'low',
        reason: 'unrelated',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
        hasRunningExecution: true,
      },
    ]);

    expect(persistTx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.executionRun.updateMany).not.toHaveBeenCalled();
  });

  it('does nothing on an empty alert array (cheap exit)', async () => {
    await persistDriftAlerts(persistTx as unknown as never, 'p1', []);
    expect(tx.driftAlert.createManyAndReturn).not.toHaveBeenCalled();
    expect(persistTx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.executionRun.updateMany).not.toHaveBeenCalled();
    expect(driftUpdateMany).not.toHaveBeenCalled();
  });

  // R-051: at most one open DriftAlert per task. Before writing the new
  // alerts, persistDriftAlerts must mark every prior open alert on the
  // affected tasks as resolved/superseded so the partial unique index
  // `drift_alerts_one_open_per_task` is satisfied. The supersede step has to
  // run BEFORE createManyAndReturn — otherwise the createMany would race the
  // index. We verify both the call ordering and the supersede shape here.
  describe('R-051: supersedes prior open alerts before creating new ones', () => {
    it('updates prior open alerts on the affected tasks to resolved/superseded before createMany', async () => {
      setupCreate();
      const alerts = buildAlerts();
      await persistDriftAlerts(persistTx as unknown as never, 'p1', alerts);

      expect(driftUpdateMany).toHaveBeenCalledTimes(1);
      const supersedeCall = driftUpdateMany.mock.calls[0][0] as {
        where: { taskId: { in: string[] }; status: string };
        data: {
          status: string;
          resolvedAction: string;
          resolvedBy: string;
          resolvedAt: Date;
        };
      };
      expect(supersedeCall.where.status).toBe('open');
      expect(supersedeCall.where.taskId.in.sort()).toEqual(alerts.map((a) => a.taskId).sort());
      expect(supersedeCall.data.status).toBe('resolved');
      expect(supersedeCall.data.resolvedAction).toBe('superseded');
      expect(supersedeCall.data.resolvedBy).toBe('system');
      expect(supersedeCall.data.resolvedAt).toBeInstanceOf(Date);

      const supersedeOrder = driftUpdateMany.mock.invocationCallOrder[0];
      const createOrder = tx.driftAlert.createManyAndReturn.mock.invocationCallOrder[0];
      expect(supersedeOrder).toBeLessThan(createOrder);
    });

    it('dedupes task ids in the supersede WHERE clause so duplicate alerts on the same task only filter once', async () => {
      tx.driftAlert.createManyAndReturn.mockResolvedValueOnce([{ id: 'a1' }, { id: 'a2' }]);
      // Two alerts for the same task can happen if the diff yields one per
      // changed dimension; the supersede WHERE clause must still address
      // the task exactly once.
      const dupAlerts = [
        {
          taskId: 't-same',
          severity: 'high' as const,
          reason: 'changeA',
          currentPlanVersion: 2,
          taskBoundVersion: 1,
          hasRunningExecution: false,
        },
        {
          taskId: 't-same',
          severity: 'medium' as const,
          reason: 'changeB',
          currentPlanVersion: 2,
          taskBoundVersion: 1,
          hasRunningExecution: false,
        },
      ];

      await persistDriftAlerts(persistTx as unknown as never, 'p1', dupAlerts);

      const supersedeCall = driftUpdateMany.mock.calls[0][0] as {
        where: { taskId: { in: string[] } };
      };
      expect(supersedeCall.where.taskId.in).toEqual(['t-same']);
    });
  });
});
