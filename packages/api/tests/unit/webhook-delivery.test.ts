/**
 * R-122 — webhook delivery unit tests (HMAC, retry, idempotency).
 *
 * Pin the behaviour of {@link deliverWithRetry} without spinning up a real
 * Postgres or HTTP server. Three properties matter for the rest of the system
 * to be auditable:
 *
 *  - HMAC: when a webhook secret is configured the request carries
 *    `X-PlanSync-Signature: sha256=<hex>` with the canonical payload, otherwise
 *    no signature header leaks downstream;
 *  - Retry: a non-2xx response retries up to 4 attempts (so one delivery row
 *    per attempt) and stops on the first 2xx; transport errors are also
 *    persisted instead of swallowed;
 *  - Idempotency: every attempt gets a fresh, unique `X-PlanSync-Delivery`
 *    UUID and the same UUID is recorded on the persisted WebhookDelivery row,
 *    so receivers can dedupe replays.
 *
 * The Postgres `prisma.webhookDelivery.create` call and `global.fetch` are
 * mocked so this file runs in pure unit mode (no DB, no network).
 */
import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type CreatedDelivery = {
  id: string;
  webhookId: string;
  event: string;
  responseCode: number;
  success: boolean;
  errorMessage: string | null;
  attempt: number;
  requestBody: unknown;
};

const created: CreatedDelivery[] = [];

vi.mock('@/lib/prisma', () => ({
  prisma: {
    webhookDelivery: {
      create: vi.fn(async ({ data }: { data: CreatedDelivery }) => {
        created.push(data);
        return data;
      }),
    },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { deliverWithRetry } from '@/lib/webhook';

const fetchMock = vi.fn();
const realSetTimeout = global.setTimeout;

beforeEach(() => {
  created.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  // The retry sleep is gated by setTimeout. Stub it to fire immediately so the
  // test does not wait the real backoff (0/1s/5s/30s) between attempts.
  vi.stubGlobal('setTimeout', ((fn: (...args: unknown[]) => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof realSetTimeout>;
  }) as typeof setTimeout);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeResponse(status: number, body = ''): Response {
  return new Response(body, { status });
}

describe('webhook deliverWithRetry — R-122', () => {
  it('HMAC: signs body with secret and omits signature when secret is null', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200));

    const secret = 'top-secret';
    const body = { event: 'plan_activated', planId: 'p1', n: 42 };
    const bodyStr = JSON.stringify(body);
    const expectedSig = crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');

    await deliverWithRetry('wh-1', 'http://hook.test/post', secret, {
      event: 'plan_activated',
      body,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentInit = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = sentInit.headers as Record<string, string>;
    expect(headers['X-PlanSync-Signature']).toBe(`sha256=${expectedSig}`);
    expect(headers['X-PlanSync-Event']).toBe('plan_activated');
    expect(headers['Content-Type']).toBe('application/json');
    expect(sentInit.body).toBe(bodyStr);

    fetchMock.mockResolvedValueOnce(makeResponse(200));
    await deliverWithRetry('wh-2', 'http://hook.test/post', null, {
      event: 'task_created',
      body: { taskId: 't1' },
    });
    const noSecretHeaders = fetchMock.mock.calls[1][1] as RequestInit;
    expect((noSecretHeaders.headers as Record<string, string>)['X-PlanSync-Signature']).toBeUndefined();
  });

  it('Retry: stops on first 2xx and persists exactly one row per attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(500, 'boom'))
      .mockResolvedValueOnce(makeResponse(503, 'still bad'))
      .mockResolvedValueOnce(makeResponse(200));

    await deliverWithRetry('wh-r', 'http://hook.test/post', null, {
      event: 'plan_activated',
      body: { v: 1 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(created).toHaveLength(3);
    expect(created.map((d) => d.attempt)).toEqual([1, 2, 3]);
    expect(created.map((d) => d.success)).toEqual([false, false, true]);
    expect(created[0].responseCode).toBe(500);
    expect(created[0].errorMessage).toMatch(/HTTP 500/);
    expect(created[2].errorMessage).toBeNull();
  });

  it('Retry: gives up after 4 attempts when every call fails (max retries)', async () => {
    fetchMock.mockResolvedValue(makeResponse(500, 'always-fail'));

    await deliverWithRetry('wh-fail', 'http://hook.test/post', null, {
      event: 'task_created',
      body: { taskId: 't1' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(created).toHaveLength(4);
    expect(created.every((d) => !d.success)).toBe(true);
    expect(created.map((d) => d.attempt)).toEqual([1, 2, 3, 4]);
  });

  it('Retry: persists transport errors (fetch throws) without crashing', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(makeResponse(200));

    await deliverWithRetry('wh-err', 'http://hook.test/post', null, {
      event: 'task_created',
      body: { taskId: 't1' },
    });

    expect(created).toHaveLength(2);
    expect(created[0].success).toBe(false);
    expect(created[0].responseCode).toBe(0);
    expect(created[0].errorMessage).toBe('ECONNREFUSED');
    expect(created[1].success).toBe(true);
  });

  it('Idempotency: each attempt has a unique X-PlanSync-Delivery UUID matched to the persisted row', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(500))
      .mockResolvedValueOnce(makeResponse(500))
      .mockResolvedValueOnce(makeResponse(200));

    await deliverWithRetry('wh-id', 'http://hook.test/post', null, {
      event: 'plan_activated',
      body: { v: 2 },
    });

    const sentIds = fetchMock.mock.calls.map(
      (c) => (c[1] as RequestInit).headers as Record<string, string>,
    ).map((h) => h['X-PlanSync-Delivery']);

    expect(sentIds).toHaveLength(3);
    // All delivery IDs are valid UUIDs
    for (const id of sentIds) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    }
    // All delivery IDs are distinct (no replay collision)
    expect(new Set(sentIds).size).toBe(3);
    // The id sent in the header is the same id stored in the DB row
    expect(created.map((d) => d.id)).toEqual(sentIds);
  });
});
