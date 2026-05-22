import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { Writable } from 'node:stream';
import pino from 'pino';
import { middleware } from '../../src/middleware';
import {
  REQUEST_ID_HEADER,
  enterRequestContext,
  enterRequestContextFromHeaders,
  getRequestId,
  resolveRequestId,
  runWithRequestContext,
} from '../../src/lib/request-context';
import { requestIdMixin } from '../../src/lib/logger';

function makeRequest(opts: { pathname?: string; reqId?: string | null } = {}): NextRequest {
  const headers = new Headers();
  if (opts.reqId) headers.set(REQUEST_ID_HEADER, opts.reqId);
  const url = `http://localhost${opts.pathname ?? '/api/projects'}`;
  return new NextRequest(url, { method: 'GET', headers });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('R-111 request correlation id', () => {
  describe('middleware', () => {
    it('mints a fresh uuid request id and echoes it on the response', () => {
      const res = middleware(makeRequest());
      const echoed = res.headers.get(REQUEST_ID_HEADER);
      expect(echoed).toBeTruthy();
      expect(echoed!).toMatch(UUID_RE);
    });

    it('reuses an inbound x-request-id from upstream proxies when it looks safe', () => {
      const inbound = 'edge-7c3a9f1b-2d4e-4f6c-9b8a-5e1d2c3f4a5b';
      const res = middleware(makeRequest({ reqId: inbound }));
      expect(res.headers.get(REQUEST_ID_HEADER)).toBe(inbound);
    });

    it('rejects suspicious inbound request ids and mints a fresh uuid instead', () => {
      for (const bad of ['x', 'x'.repeat(200), 'rid;DROP TABLE', 'rid with spaces']) {
        const res = middleware(makeRequest({ reqId: bad }));
        const echoed = res.headers.get(REQUEST_ID_HEADER);
        expect(echoed).toBeTruthy();
        expect(echoed).not.toBe(bad);
        expect(echoed!).toMatch(UUID_RE);
      }
    });

    it('OPTIONS preflight still carries the request id', () => {
      const headers = new Headers({ origin: 'http://localhost:3001' });
      const req = new NextRequest('http://localhost/api/projects', {
        method: 'OPTIONS',
        headers,
      });
      const res = middleware(req);
      expect(res.status).toBe(204);
      expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(UUID_RE);
    });
  });

  describe('resolveRequestId', () => {
    it('returns the inbound id when it matches the safe pattern', () => {
      const inbound = 'edge-abcd1234.req_5';
      expect(resolveRequestId(inbound)).toBe(inbound);
    });

    it('mints a fresh uuid when input is null/empty/unsafe', () => {
      expect(resolveRequestId(null)).toMatch(UUID_RE);
      expect(resolveRequestId('')).toMatch(UUID_RE);
      expect(resolveRequestId('a a')).toMatch(UUID_RE);
      expect(resolveRequestId('x'.repeat(200))).toMatch(UUID_RE);
      expect(resolveRequestId('short')).toMatch(UUID_RE);
    });
  });

  describe('AsyncLocalStorage', () => {
    it('runWithRequestContext exposes reqId across async awaits and tears down after', async () => {
      const rid = 'unit-test-rid-aaaaaaaa';
      const result = await runWithRequestContext({ reqId: rid }, async () => {
        const sync = getRequestId();
        await Promise.resolve();
        const afterAwait = getRequestId();
        return { sync, afterAwait };
      });
      expect(result.sync).toBe(rid);
      expect(result.afterAwait).toBe(rid);
      expect(getRequestId()).toBeUndefined();
    });

    it('enterRequestContextFromHeaders pulls the id off middleware-injected headers', () => {
      const rid = 'inbound-rid-cccccccc';
      const headers = new Headers({ [REQUEST_ID_HEADER]: rid });
      const inner = runWithRequestContext({ reqId: 'placeholder-ridxxxx' }, () => {
        const returned = enterRequestContextFromHeaders(headers);
        return { returned, current: getRequestId() };
      });
      expect(inner.returned).toBe(rid);
      expect(inner.current).toBe(rid);
    });

    it('enterRequestContext lets sequentially awaited work share the same reqId', async () => {
      const rid = 'enter-rid-dddddddd';
      const seen: Array<string | undefined> = [];
      await runWithRequestContext({ reqId: 'outer-rid-eeeeeeee' }, async () => {
        enterRequestContext({ reqId: rid });
        seen.push(getRequestId());
        await Promise.resolve();
        seen.push(getRequestId());
      });
      expect(seen).toEqual([rid, rid]);
    });
  });

  describe('pino requestIdMixin', () => {
    it('auto-injects reqId into every log record emitted inside a request context', async () => {
      const records: Array<Record<string, unknown>> = [];
      const sink = new Writable({
        write(chunk, _enc, cb) {
          for (const line of chunk.toString().split('\n')) {
            if (!line.trim()) continue;
            try {
              records.push(JSON.parse(line));
            } catch {
              // not JSON — ignore
            }
          }
          cb();
        },
      });

      const testLogger = pino({ level: 'debug', mixin: requestIdMixin }, sink);

      const rid = 'log-mixin-rid-ffffffff';
      await runWithRequestContext({ reqId: rid }, async () => {
        testLogger.info('first event');
        testLogger.warn({ extra: 1 }, 'second event');
      });
      testLogger.info('outside context');

      await new Promise((r) => setImmediate(r));

      const inside = records.filter((r) => r.msg !== 'outside context');
      const outside = records.find((r) => r.msg === 'outside context');
      expect(inside.length).toBeGreaterThanOrEqual(2);
      for (const r of inside) expect(r.reqId).toBe(rid);
      expect(outside?.reqId).toBeUndefined();
    });

    it('emits no reqId field when no request context is active', () => {
      const mixed = requestIdMixin();
      expect(mixed).toEqual({});
    });

    it('returns the active reqId when called inside runWithRequestContext', () => {
      const rid = 'sync-mixin-rid-99999999';
      const mixed = runWithRequestContext({ reqId: rid }, () => requestIdMixin());
      expect(mixed).toEqual({ reqId: rid });
    });
  });
});
