import pino from 'pino';
import { env } from './env';
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

// R-112: read LOG_LEVEL / NODE_ENV from the validated `env` module (R-035) so
// typos like `LOG_LEVL=debug` fail fast at boot via zod instead of silently
// degrading to the `info` default, and so the inventory of consumed env vars
// stays in env.ts.
export const logger = pino({
  level: env.LOG_LEVEL,
  mixin: requestIdMixin,
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, sync: true },
        },
      }
    : {}),
});
