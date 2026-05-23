/**
 * Edge-safe slice of the request-context module.
 *
 * Why a separate file: `node:async_hooks` is not bundleable by Next.js
 * middleware (Edge Runtime) — the import is resolved at build time and a
 * single transitive import of `node:async_hooks` fails the entire
 * middleware compile (#294 / #333 / #338). The middleware only needs the
 * header constant + the `resolveRequestId` validator/minter, both of
 * which are pure and runtime-agnostic. Putting them here lets
 * `middleware.ts` import without dragging in AsyncLocalStorage.
 *
 * Server code that needs the AsyncLocalStorage (logger, authenticate)
 * imports `./request-context.ts`, which re-exports from this file PLUS
 * the Node-only ALS surface.
 */

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Reuse an inbound x-request-id from upstream proxies when it looks safe,
 * otherwise mint a new uuid v4. Limiting length + character set prevents
 * log injection from clients spoofing the header.
 *
 * Safe characters: alphanumerics, dot, underscore, hyphen. 8..128 chars.
 * Wide enough for every common id format (uuid, ksuid, xid, ulid, traceId,
 * cf-ray) but tight enough to keep grep / structured-log queries simple.
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
  // Pure-JS UUIDv4 fallback. The request id is a non-secret correlation
  // id, so Math.random() is sufficient — and crucially this path stays
  // free of `node:crypto`, which the Edge Runtime cannot bundle either.
  // globalThis.crypto.randomUUID is available in every supported runtime
  // (Edge, browsers, Node ≥19, Node 18 with --experimental-global-webcrypto),
  // so this fallback only fires on an exotic JS host.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
