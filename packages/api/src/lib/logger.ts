import pino from 'pino';
import { getRequestId } from './request-context';

/**
 * pino mixin that pulls the active request id off AsyncLocalStorage and
 * injects it into every log record emitted inside a request context.
 * Exported so it can be unit-tested directly without poking pino internals.
 */
export function requestIdMixin(): Record<string, string> {
  const reqId = getRequestId();
  return reqId ? { reqId } : {};
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  mixin: requestIdMixin,
  ...(process.env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, sync: true },
        },
      }
    : {}),
});
