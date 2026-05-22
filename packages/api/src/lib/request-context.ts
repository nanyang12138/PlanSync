import { AsyncLocalStorage } from 'node:async_hooks';

export const REQUEST_ID_HEADER = 'x-request-id';

export interface RequestContext {
  reqId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.reqId;
}

/**
 * Lazily enter a request context for the rest of the current async chain.
 * Unlike `runWithRequestContext`, this does not require wrapping a callback —
 * route handlers can call it once (e.g. inside `authenticate`) and every
 * downstream awaited operation will see the same reqId.
 *
 * Safe to call multiple times: if a context already matches, this is a noop.
 */
export function enterRequestContext(ctx: RequestContext): void {
  const existing = storage.getStore();
  if (existing && existing.reqId === ctx.reqId) return;
  storage.enterWith(ctx);
}

/**
 * Convenience: pull the request id off the headers the middleware injected
 * (or fall back to minting a new one) and enter the context.
 */
export function enterRequestContextFromHeaders(headers: {
  get(name: string): string | null;
}): string {
  const reqId = resolveRequestId(headers.get(REQUEST_ID_HEADER));
  enterRequestContext({ reqId });
  return reqId;
}

/**
 * Reuse an inbound x-request-id from upstream proxies when it looks safe,
 * otherwise mint a new uuid v4. Limiting length + character set prevents log
 * injection from clients spoofing the header.
 */
const SAFE_REQ_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function resolveRequestId(inbound: string | null | undefined): string {
  if (inbound && SAFE_REQ_ID.test(inbound)) {
    return inbound;
  }
  return cryptoRandomUUID();
}

function cryptoRandomUUID(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  // Pure-JS UUIDv4 fallback. The request id is a non-secret correlation id,
  // so Math.random() is sufficient — and crucially this path stays free of
  // `node:crypto`, which Next.js middleware (Edge Runtime) cannot bundle.
  // globalThis.crypto.randomUUID is available in every supported runtime
  // (Edge Runtime, browsers, Node ≥19, Node 18 with --experimental-global-
  // webcrypto), so this fallback only fires on an exotic JS host.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
