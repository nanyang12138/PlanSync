/**
 * Server-side request-context module.
 *
 * This file pulls in `node:async_hooks` to provide the AsyncLocalStorage
 * that lets `logger.warn(...)` etc. attach a per-request reqId without
 * threading it through every function signature. It is NOT safe to import
 * from `middleware.ts` (Edge Runtime); the middleware imports the
 * runtime-agnostic constants/helpers from `./request-context-edge.ts`
 * instead — see #294 / #333 / #338.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { REQUEST_ID_HEADER, resolveRequestId } from './request-context-edge';

export { REQUEST_ID_HEADER, resolveRequestId };

export interface RequestContext {
  reqId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Wrap a callback so every async operation it kicks off observes the
 * given context. Preferred over `enterRequestContext` whenever the
 * caller has a clean function boundary — `storage.run` automatically
 * restores the previous context on return, which is the only safe
 * primitive when concurrent requests interleave.
 */
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
 *
 * Reviewer note (#305 / #334): `storage.enterWith` does NOT pop the
 * context on return — once entered, every await/microtask in the same
 * async resource keeps seeing it. Concurrent in-flight requests can
 * still each observe their own context because every Next.js handler
 * starts in a fresh async resource. The danger is intentionally caching
 * the storage chain across resources (e.g. a top-level Promise that
 * outlives the request), so callers MUST avoid stashing references.
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
