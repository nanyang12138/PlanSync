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

// R-112: pull LOG_LEVEL / NODE_ENV from the validated `env` helper instead of
// `process.env`. env.ts already enforces an enum for LOG_LEVEL (debug | info |
// warn | error) and NODE_ENV (development | test | production), so a typo no
// longer silently degrades to pino's default — it fails the boot guard in
// env.ts's validateEnv() with a clear path/message.
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
