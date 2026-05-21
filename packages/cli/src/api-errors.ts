/**
 * Typed errors and event bus for HTTP responses from the PlanSync API.
 *
 * R-025: `psRequest` used to `JSON.parse` the body regardless of status, so a
 * 401/403/500 response was silently turned into "no data" by callers — the
 * banner said "no plan yet" when the real problem was that the cached API key
 * had expired. These types let callers (and tests) tell the difference between
 * an empty result, an auth failure, and a transient server error.
 */

import { EventEmitter } from 'events';

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly bodyExcerpt: string;
  constructor(statusCode: number, message: string, bodyExcerpt = '') {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.bodyExcerpt = bodyExcerpt;
  }
}

export class AuthError extends ApiError {
  constructor(statusCode: number, message: string, bodyExcerpt = '') {
    super(statusCode, message, bodyExcerpt);
    this.name = 'AuthError';
  }
}

export class ServerError extends ApiError {
  constructor(statusCode: number, message: string, bodyExcerpt = '') {
    super(statusCode, message, bodyExcerpt);
    this.name = 'ServerError';
  }
}

export class RequestError extends ApiError {
  constructor(statusCode: number, message: string, bodyExcerpt = '') {
    super(statusCode, message, bodyExcerpt);
    this.name = 'RequestError';
  }
}

export interface AuthFailurePayload {
  statusCode: number;
  message: string;
  method: string;
  path: string;
}

export interface RawResponse {
  statusCode: number;
  body: string;
}

export type RawRequester = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<RawResponse>;

/**
 * Module-level event bus. The CLI's main loop subscribes to `authFailure`
 * once on startup and prints a red prompt asking the user to re-login.
 * Tests can also subscribe via `apiEvents.once('authFailure', ...)`.
 */
export const apiEvents = new EventEmitter();

/**
 * Status-code-aware request helper. Pulled out of `psRequest` so it can be
 * unit-tested without spinning up a real HTTP server.
 *
 *   - 2xx + JSON body  → resolved with parsed body
 *   - 401 / 403        → emit `authFailure`, reject with `AuthError`
 *   - 5xx              → retry once (network or response), reject with `ServerError`
 *   - other 4xx        → reject with `RequestError`
 *   - network errors   → retry once, then reject with the original error
 */
export async function performRequest<T>(
  method: string,
  path: string,
  body: unknown | undefined,
  fetcher: RawRequester,
): Promise<T> {
  const maxAttempts = 2;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: RawResponse;
    try {
      res = await fetcher(method, path, body);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) continue;
      throw err;
    }

    if (res.statusCode >= 200 && res.statusCode < 300) {
      if (!res.body) {
        return undefined as T;
      }
      try {
        return JSON.parse(res.body) as T;
      } catch {
        throw new ApiError(
          res.statusCode,
          `Failed to parse JSON response from ${method} ${path}`,
          res.body.slice(0, 200),
        );
      }
    }

    if (res.statusCode === 401 || res.statusCode === 403) {
      const message = `Authentication failed (${res.statusCode}). Please re-login (e.g. run ./bin/plansync).`;
      apiEvents.emit('authFailure', {
        statusCode: res.statusCode,
        message,
        method,
        path,
      } satisfies AuthFailurePayload);
      throw new AuthError(res.statusCode, message, res.body.slice(0, 200));
    }

    if (res.statusCode >= 500 && res.statusCode < 600) {
      lastError = new ServerError(
        res.statusCode,
        `Server error ${res.statusCode} from ${method} ${path}`,
        res.body.slice(0, 200),
      );
      if (attempt < maxAttempts) continue;
      throw lastError;
    }

    throw new RequestError(
      res.statusCode,
      `Request failed ${res.statusCode} for ${method} ${path}`,
      res.body.slice(0, 200),
    );
  }

  throw lastError ?? new Error('performRequest: no attempts made');
}
