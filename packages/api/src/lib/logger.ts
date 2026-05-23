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

// R-112: read LOG_LEVEL / NODE_ENV off the validated `env` singleton instead
// of `process.env` so a typo (e.g. LOG_LEVEL=infoo) fails fast at boot via
// the zod schema in env.ts rather than silently degrading to pino's "info"
// default at runtime. Keeps env.ts the single inventory of runtime env vars.
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
