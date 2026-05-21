/**
 * R-044: In-memory sliding-window rate limiter for the notify route.
 *
 * Caps a single user to at most {@link MAX_CALLS} POST /notify calls within
 * any {@link WINDOW_MS} window. Throws {@link AppError} with
 * {@link ErrorCode.RATE_LIMITED} on the 4th call.
 *
 * Process-local — sufficient because the notify route is owner-only and not
 * a hot path. A multi-instance deployment that wants strict global limits
 * should swap this for Redis/Postgres-backed counters later.
 */
import { AppError, ErrorCode } from '@plansync/shared';

export const NOTIFY_WINDOW_MS = 5 * 60 * 1000;
export const NOTIFY_MAX_CALLS = 3;

const timestamps = new Map<string, number[]>();

export function checkNotifyRateLimit(
  userName: string,
  now: number = Date.now(),
  windowMs: number = NOTIFY_WINDOW_MS,
  maxCalls: number = NOTIFY_MAX_CALLS,
): void {
  const cutoff = now - windowMs;
  const arr = (timestamps.get(userName) ?? []).filter((t) => t > cutoff);

  if (arr.length >= maxCalls) {
    timestamps.set(userName, arr);
    const oldest = arr[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    throw new AppError(
      ErrorCode.RATE_LIMITED,
      `Notify rate limit exceeded: max ${maxCalls} calls per ${Math.round(windowMs / 60000)} minutes`,
      { retryAfterSec, limit: maxCalls, windowMs },
    );
  }

  arr.push(now);
  timestamps.set(userName, arr);
}

/** Test helper: drop all recorded timestamps. */
export function resetNotifyRateLimit(userName?: string): void {
  if (userName === undefined) {
    timestamps.clear();
  } else {
    timestamps.delete(userName);
  }
}
