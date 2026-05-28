/**
 * Repo-root .env loader for worker-side scripts.
 *
 * Same semantics as bash `set -a; . .env; set +a`:
 *   - existing process.env values WIN (env > .env)
 *   - DOUBLE-quoted values have surrounding quotes stripped AND
 *     `${VAR}` / `$VAR` references expanded (matches bash double-
 *     quote interpolation).
 *   - **single-quoted** values have surrounding quotes stripped but
 *     are passed VERBATIM — `$` and `${VAR}` stay literal. This
 *     mirrors bash single-quote semantics (closes #936) and is
 *     critical so an operator can store a password / secret that
 *     happens to contain a `$` without it being expanded or
 *     mangled.
 *   - bash-style `${VAR}` and `$VAR` references in unquoted /
 *     double-quoted values are expanded against the already-
 *     resolved env (existing process.env + earlier lines from
 *     this file) so values like
 *
 *         DATABASE_URL=postgresql://${USER}@localhost:${PG_PORT}/plansync_dev
 *
 *     resolve to a real connection string instead of being passed
 *     verbatim. (P0-8 / closes #571 #572 #605 #608 — without this,
 *     the worker would start, connect to literal `${USER}@…`, fail
 *     every 60s, and look healthy to liveness probes.)
 *   - blank / comment-only lines are skipped.
 *
 * #571 / #572 / #605 / #608: the previous version of worker-env-setup.ts
 * applied PLANSYNC_EVENT_BUS=postgres in --require land, which fired
 * before run-worker.ts's dotenv preamble. If `.env` set
 * PLANSYNC_EVENT_BUS=memory, the preamble's "env wins over .env" rule
 * meant the file value was silently overwritten by the default. The
 * fix is to load .env in --require land too, so the order is:
 *   1. existing env (from the operator's shell)
 *   2. .env file (filling in unset values)
 *   3. worker defaults (only when still unset)
 *
 * Idempotent — calling it twice is harmless.
 */
import path from 'node:path';
import fs from 'node:fs';

const VAR_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

type LookupFn = (name: string, visiting: Set<string>) => string | undefined;

function expandRefs(value: string, lookup: LookupFn, visiting: Set<string> = new Set()): string {
  return value.replace(
    VAR_REF_RE,
    (match, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare;
      if (!name) return match;
      const resolved = lookup(name, visiting);
      return resolved ?? match;
    },
  );
}

/**
 * Internal — exposed via {@link loadRepoDotenv} for production and
 * via the optional `envPath` parameter for tests so they don't have
 * to mutate the repository root `.env` file (closes #937 #943).
 */
export function loadDotenvFrom(envPath: string): void {
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf-8');

  // Two-pass: collect into a local map first so a value that
  // references another KEY defined later in the same file still
  // resolves. We track each entry's original quoting so single-
  // quoted values bypass `${VAR}` expansion (closes #936).
  type FileVar = { value: string; quoted: 'single' | 'double' | 'none' };
  const fileVars: Record<string, FileVar> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    let quoted: FileVar['quoted'] = 'none';
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      quoted = 'double';
      value = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      quoted = 'single';
      value = value.slice(1, -1);
    }
    fileVars[m[1]] = { value, quoted };
  }

  const lookup: LookupFn = (name, visiting) => {
    if (process.env[name] !== undefined) return process.env[name];
    const f = fileVars[name];
    if (!f) return undefined;
    if (f.quoted === 'single') return f.value;
    // Cycle guard (#2826): if we're already in the middle of expanding
    // `name`, returning undefined leaves the original `${name}` literal
    // in place — same fallback as an unresolved reference. Without this
    // guard, `A=${A}` or `A=${B} / B=${A}` would recurse forever and
    // blow the stack, killing the worker/API on startup.
    if (visiting.has(name)) return undefined;
    // Recursively expand so chained references (A=${USER}; B=...${A}...)
    // resolve correctly — returning the raw value would leave ${USER}
    // as a literal string in the expanded result (#1059).
    visiting.add(name);
    try {
      return expandRefs(f.value, lookup, visiting);
    } finally {
      visiting.delete(name);
    }
  };

  for (const [key, fv] of Object.entries(fileVars)) {
    if (process.env[key] !== undefined) continue;
    if (fv.quoted === 'single') {
      process.env[key] = fv.value;
      continue;
    }
    // Seed `visiting` with the current key so a value that directly
    // self-references (e.g. `A=${A}`) is treated as a cycle on the
    // very first hop and leaves `${A}` literal rather than recursing
    // (#2826).
    process.env[key] = expandRefs(fv.value, lookup, new Set([key]));
  }
}

export function loadRepoDotenv(): void {
  // From packages/api/scripts/* the repo root is three levels up.
  loadDotenvFrom(path.resolve(__dirname, '../../../.env'));
}
