/**
 * R-139 — persistent webhook retry queue worker unit tests.
 *
 * Before R-139, `deliverWithRetry` carried the 0/1/5/30s back-off in
 * `setTimeout` chains. An API restart between attempts silently dropped
 * every pending retry. R-139 replaces that schedule with a durable
 * `webhook_jobs` row consumed by a dedicated worker.
 *
 * These tests pin three properties of the new worker without touching
 * Postgres or the network:
 *
 *   1. Success path — a `pending` row whose receiver returns 2xx ends
 *      as `delivered` (terminal) after exactly one HTTP attempt and
 *      records one `WebhookDelivery` row.
 *   2. Retry schedule — a 500 response on attempt 1 leaves the job
 *      `pending` with `attempt=1` and `nextAttemptAt = now + 1s`
 *      (matching the legacy back-off slot). After three 500s the row
 *      becomes terminal `failed` on the fourth attempt without making a
 *      fifth HTTP call.
 *   3. Crash safety — calling `processPendingWebhookJobs` again after
 *      a simulated crash (worker died after the row was inserted)
 *      still picks up the durable job and delivers it. This is the
 *      whole point of the queue and could not be exercised against the
 *      pre-R-139 in-memory path.
 *
 * The `prisma.webhookJob`, `prisma.webhook`, `prisma.webhookDelivery`
 * tables and `global.fetch` are mocked, so the file runs in pure unit
 * mode.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type JobStatus = 'pending' | 'in_flight' | 'delivered' | 'failed';

type WebhookJobRow = {
  id: string;
  webhookId: string;
  event: string;
  body: Record<string, unknown>;
  attempt: number;
  status: JobStatus;
  nextAttemptAt: Date;
  lastError: string | null;
};

type WebhookRow = {
  id: string;
  url: string;
  secret: string | null;
  active: boolean;
};

type WebhookDeliveryRow = {
  id: string;
  webhookId: string;
  event: string;
  responseCode: number;
  success: boolean;
  errorMessage: string | null;
  attempt: number;
  requestBody: unknown;
};

const jobsTable: WebhookJobRow[] = [];
const webhooksTable: WebhookRow[] = [];
const deliveriesTable: WebhookDeliveryRow[] = [];

function findJob(id: string): WebhookJobRow {
  const row = jobsTable.find((j) => j.id === id);
  if (!row) throw new Error(`mock job ${id} not found`);
  return row;
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    webhookJob: {
      findMany: vi.fn(
        async ({
          where,
          take,
        }: {
          where: { status: JobStatus; nextAttemptAt: { lte: Date } };
          orderBy: unknown;
          take: number;
        }) => {
          return jobsTable
            .filter((j) => j.status === where.status && j.nextAttemptAt <= where.nextAttemptAt.lte)
            .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
            .slice(0, take);
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status: JobStatus };
          data: Partial<WebhookJobRow>;
        }) => {
          const row = jobsTable.find((j) => j.id === where.id && j.status === where.status);
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<WebhookJobRow> }) => {
          const row = findJob(where.id);
          Object.assign(row, data);
          return row;
        },
      ),
    },
    webhook: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return webhooksTable.find((w) => w.id === where.id) ?? null;
      }),
    },
    webhookDelivery: {
      create: vi.fn(async ({ data }: { data: WebhookDeliveryRow }) => {
        deliveriesTable.push(data);
        return data;
      }),
    },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { processPendingWebhookJobs } from '@/lib/webhook-worker';

const fetchMock = vi.fn();

beforeEach(() => {
  jobsTable.length = 0;
  webhooksTable.length = 0;
  deliveriesTable.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function seedWebhook(id = 'wh-1', overrides: Partial<WebhookRow> = {}): WebhookRow {
  const row: WebhookRow = {
    id,
    url: 'http://hook.test/post',
    secret: null,
    active: true,
    ...overrides,
  };
  webhooksTable.push(row);
  return row;
}

function seedJob(overrides: Partial<WebhookJobRow> = {}): WebhookJobRow {
  const row: WebhookJobRow = {
    id: overrides.id ?? `job-${jobsTable.length + 1}`,
    webhookId: overrides.webhookId ?? 'wh-1',
    event: overrides.event ?? 'plan_activated',
    body: overrides.body ?? { v: 1 },
    attempt: overrides.attempt ?? 0,
    status: overrides.status ?? 'pending',
    nextAttemptAt: overrides.nextAttemptAt ?? new Date(0),
    lastError: overrides.lastError ?? null,
  };
  jobsTable.push(row);
  return row;
}

function makeResponse(status: number, body = ''): Response {
  return new Response(body, { status });
}

describe('R-139 webhook-worker — processPendingWebhookJobs', () => {
  it('success path: a pending job with a 2xx receiver ends as delivered after one HTTP call', async () => {
    seedWebhook();
    const job = seedJob();
    fetchMock.mockResolvedValueOnce(makeResponse(200));

    const result = await processPendingWebhookJobs({ now: new Date(1_000_000) });

    expect(result).toEqual({ processed: 1, delivered: 1, failed: 0, rescheduled: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetched = fetchMock.mock.calls[0];
    expect(fetched[0]).toBe('http://hook.test/post');
    const init = fetched[1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-PlanSync-Event']).toBe('plan_activated');
    expect(deliveriesTable).toHaveLength(1);
    expect(deliveriesTable[0].success).toBe(true);
    expect(deliveriesTable[0].attempt).toBe(1);
    const persisted = findJob(job.id);
    expect(persisted.status).toBe('delivered');
    expect(persisted.attempt).toBe(1);
  });

  it('retry schedule: 500 reschedules with the next back-off slot and never exceeds 4 attempts', async () => {
    seedWebhook();
    const job = seedJob();
    fetchMock.mockResolvedValue(makeResponse(500, 'boom'));

    // Attempt 1 — should requeue with next_attempt_at = now + 1s.
    const t0 = new Date(1_000_000);
    let result = await processPendingWebhookJobs({ now: t0 });
    expect(result).toEqual({ processed: 1, delivered: 0, failed: 0, rescheduled: 1 });
    let row = findJob(job.id);
    expect(row.status).toBe('pending');
    expect(row.attempt).toBe(1);
    expect(row.nextAttemptAt.getTime()).toBe(t0.getTime() + 1000);
    expect(row.lastError).toMatch(/HTTP 500/);

    // Attempt 2 — should requeue with next_attempt_at = now + 5s.
    const t1 = new Date(t0.getTime() + 1000);
    result = await processPendingWebhookJobs({ now: t1 });
    row = findJob(job.id);
    expect(row.attempt).toBe(2);
    expect(row.nextAttemptAt.getTime()).toBe(t1.getTime() + 5000);

    // Attempt 3 — should requeue with next_attempt_at = now + 30s.
    const t2 = new Date(t1.getTime() + 5000);
    result = await processPendingWebhookJobs({ now: t2 });
    row = findJob(job.id);
    expect(row.attempt).toBe(3);
    expect(row.nextAttemptAt.getTime()).toBe(t2.getTime() + 30000);

    // Attempt 4 — terminal failure, no further HTTP attempts.
    const t3 = new Date(t2.getTime() + 30000);
    result = await processPendingWebhookJobs({ now: t3 });
    expect(result).toEqual({ processed: 1, delivered: 0, failed: 1, rescheduled: 0 });
    row = findJob(job.id);
    expect(row.status).toBe('failed');
    expect(row.attempt).toBe(4);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(deliveriesTable).toHaveLength(4);
    expect(deliveriesTable.map((d) => d.attempt)).toEqual([1, 2, 3, 4]);

    // Another tick after the terminal state must do nothing: this is
    // the property that makes the queue safe to keep ticking forever.
    const t4 = new Date(t3.getTime() + 60_000);
    fetchMock.mockClear();
    result = await processPendingWebhookJobs({ now: t4 });
    expect(result.processed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('crash safety: a job inserted before a simulated worker restart is still delivered', async () => {
    // Simulate "API crashed between dispatchWebhooks INSERT and any
    // HTTP attempt". The job row exists; the worker has never touched
    // it; on next worker startup `processPendingWebhookJobs` must pick
    // it up. This is exactly what the pre-R-139 in-memory schedule
    // could not do — the entire retry plan lived in the dead process.
    seedWebhook();
    const job = seedJob({ nextAttemptAt: new Date(500_000) });
    fetchMock.mockResolvedValueOnce(makeResponse(200));

    const result = await processPendingWebhookJobs({ now: new Date(1_000_000) });

    expect(result.delivered).toBe(1);
    expect(findJob(job.id).status).toBe('delivered');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips jobs whose nextAttemptAt is in the future', async () => {
    seedWebhook();
    const future = new Date(2_000_000);
    seedJob({ nextAttemptAt: future });

    const result = await processPendingWebhookJobs({ now: new Date(1_000_000) });
    expect(result.processed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('terminal-fails the job when the parent webhook was deleted', async () => {
    // No webhook row in the table — simulates a deleted subscription.
    const job = seedJob({ webhookId: 'wh-gone' });

    const result = await processPendingWebhookJobs({ now: new Date(1_000_000) });
    expect(result).toEqual({ processed: 1, delivered: 0, failed: 1, rescheduled: 0 });
    const row = findJob(job.id);
    expect(row.status).toBe('failed');
    expect(row.lastError).toMatch(/deleted/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
