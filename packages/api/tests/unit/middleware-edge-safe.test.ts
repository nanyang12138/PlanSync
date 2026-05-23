import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, '../../src');
const MIDDLEWARE = resolve(SRC_ROOT, 'middleware.ts');
const REQUEST_CONTEXT_EDGE = resolve(SRC_ROOT, 'lib/request-context-edge.ts');
const REQUEST_CONTEXT_SERVER = resolve(SRC_ROOT, 'lib/request-context.ts');

/**
 * Edge-runtime safety guard (#294 / #333 / #338).
 *
 * Next.js middleware runs in the Edge Runtime, which cannot bundle the
 * Node-only `node:async_hooks` module. A single transitive import of
 * `node:async_hooks` from middleware.ts (or any of its imports) fails
 * the build at deploy time and is hard to catch in CI because the
 * default `next build` only flags it on the Edge codepath.
 *
 * Instead of trying to spin up a real Edge bundler in the test, we
 * verify the structural invariant: middleware.ts only imports from
 * modules that themselves do NOT import `node:async_hooks` (or any
 * `node:` builtin known to be Edge-incompatible).
 */
function readImports(filePath: string): string[] {
  const text = readFileSync(filePath, 'utf-8');
  // Match: `import ... from 'X'` (single or double quotes).
  // Ignore type-only imports — those are erased by tsc.
  const re = /^\s*import\s+(?:type\s+)?[^;]*\s+from\s+['"]([^'"]+)['"]/gm;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Skip lines that opened with `import type`.
    const slice = text.slice(m.index, m.index + m[0].length);
    if (/^\s*import\s+type\s/.test(slice)) continue;
    out.push(m[1]);
  }
  return out;
}

const EDGE_FORBIDDEN = new Set([
  'node:async_hooks',
  'async_hooks',
  'node:fs',
  'node:fs/promises',
  'fs',
  'fs/promises',
  'node:net',
  'node:tls',
  'node:dns',
  'node:child_process',
  'child_process',
]);

describe('middleware.ts Edge-runtime import safety (#294 / #333 / #338)', () => {
  it('middleware.ts itself does not import any Edge-forbidden Node builtin', () => {
    const imports = readImports(MIDDLEWARE);
    const bad = imports.filter((m) => EDGE_FORBIDDEN.has(m));
    expect(bad).toEqual([]);
  });

  it('middleware.ts imports request-context-edge, not the AsyncLocalStorage variant', () => {
    const imports = readImports(MIDDLEWARE);
    expect(
      imports.some(
        (m) => m === './lib/request-context-edge' || m.endsWith('/request-context-edge'),
      ),
    ).toBe(true);
    expect(
      imports.some((m) => m === './lib/request-context' || m.endsWith('/lib/request-context')),
    ).toBe(false);
  });

  it('request-context-edge.ts does NOT import node:async_hooks (the whole point of the split)', () => {
    const imports = readImports(REQUEST_CONTEXT_EDGE);
    expect(imports.filter((m) => EDGE_FORBIDDEN.has(m))).toEqual([]);
  });

  it('the edge-safe file exists and is non-empty', () => {
    expect(statSync(REQUEST_CONTEXT_EDGE).size).toBeGreaterThan(100);
  });

  it('the server-side request-context.ts re-exports REQUEST_ID_HEADER + resolveRequestId so callers do not have to switch import path', () => {
    const text = readFileSync(REQUEST_CONTEXT_SERVER, 'utf-8');
    // The re-export keeps `import { REQUEST_ID_HEADER, resolveRequestId } from './request-context'`
    // working everywhere the ALS variant is needed (auth.ts, logger.ts).
    expect(text).toMatch(/export\s*\{\s*REQUEST_ID_HEADER\s*,\s*resolveRequestId\s*\}/);
  });
});
