/**
 * Tests for R-074 — `/project <id>` must verify the project exists via the
 * API before switching cfg.project to it.
 *
 * Before R-074 the slash handler unconditionally assigned `cfg.project = id`,
 * which produced a silent empty banner whenever the id was a typo or had
 * been deleted. The fix introduces `validateProject(targetId, fetcher)`
 * which calls GET /api/projects/:id and returns a structured result with a
 * pre-formatted red error message that the handler prints.
 *
 * The tests below pin down:
 *   1. A 2xx response with `data.id` resolves with `ok: true` and the
 *      project payload, so the handler can pick up the canonical name.
 *   2. A non-existent id surfaces a red "not found" message that the
 *      handler will print verbatim — no silent fallthrough to an empty
 *      banner.
 *   3. Network / 5xx errors surface a red "Failed to verify" message that
 *      still includes the underlying error, so the user can tell auth
 *      failure from server outage.
 *   4. Empty / whitespace-only ids are rejected without hitting the API.
 *   5. The id is URL-encoded so a slash or space in the argument can't
 *      escape into a different path.
 */

import { describe, it, expect, vi } from 'vitest';
import { validateProject, type ProjectFetcher } from '../src/commands.js';
import { ApiError, RequestError } from '../src/api-errors.js';

const stripAnsi = (s: string) =>
  s.replace(
    // eslint-disable-next-line no-control-regex
    /\x1b\[[0-9;]*m/g,
    '',
  );

describe('validateProject (R-074)', () => {
  it('returns ok=true and the project payload on a 2xx response', async () => {
    const fetcher = vi.fn(async (_path: string) => ({
      data: { id: 'proj-1', name: 'Alpha' },
    })) as unknown as ProjectFetcher;

    const result = await validateProject('proj-1', fetcher);

    expect(result.ok).toBe(true);
    expect(result.project).toEqual({ id: 'proj-1', name: 'Alpha' });
    expect(result.errorMessage).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('/api/projects/proj-1');
  });

  it('returns ok=false with a red "not found" message on RequestError(404)', async () => {
    const fetcher = vi.fn(async (_path: string) => {
      throw new RequestError(404, 'Request failed 404 for GET /api/projects/missing');
    }) as unknown as ProjectFetcher;

    const result = await validateProject('missing', fetcher);

    expect(result.ok).toBe(false);
    expect(result.project).toBeUndefined();
    expect(result.errorMessage).toBeDefined();
    const plain = stripAnsi(result.errorMessage!);
    expect(plain).toMatch(/not found/i);
    expect(plain).toContain('missing');
    // ANSI red marker is present so the handler can print it as-is.
    expect(result.errorMessage).toMatch(/\x1b\[31m|\x1b\[91m/);
  });

  it('returns ok=false with a red "not found" message when the body has no id field', async () => {
    const fetcher = vi.fn(async (_path: string) => ({ data: null })) as unknown as ProjectFetcher;

    const result = await validateProject('ghost', fetcher);

    expect(result.ok).toBe(false);
    expect(stripAnsi(result.errorMessage!)).toMatch(/Project "ghost" not found/);
  });

  it('returns ok=false with a "Failed to verify" message on non-404 ApiError', async () => {
    const fetcher = vi.fn(async (_path: string) => {
      throw new ApiError(500, 'boom');
    }) as unknown as ProjectFetcher;

    const result = await validateProject('proj-1', fetcher);

    expect(result.ok).toBe(false);
    const plain = stripAnsi(result.errorMessage!);
    // Not-found path must not swallow a real server error.
    expect(plain).not.toMatch(/not found/i);
    expect(plain).toMatch(/Failed to verify project "proj-1"/);
    expect(plain).toContain('boom');
  });

  it('rejects empty / whitespace-only ids without hitting the API', async () => {
    const fetcher = vi.fn() as unknown as ProjectFetcher;

    const empty = await validateProject('', fetcher);
    const blank = await validateProject('   ', fetcher);

    expect(empty.ok).toBe(false);
    expect(blank.ok).toBe(false);
    expect(stripAnsi(empty.errorMessage!)).toMatch(/required/i);
    expect(stripAnsi(blank.errorMessage!)).toMatch(/required/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('URL-encodes the id so a slash cannot escape into a sibling path', async () => {
    const fetcher = vi.fn(async (_path: string) => ({
      data: { id: 'p/x', name: 'Weird' },
    })) as unknown as ProjectFetcher;

    const result = await validateProject('p/x', fetcher);

    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledWith('/api/projects/p%2Fx');
  });
});
