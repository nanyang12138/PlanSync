/**
 * Worker-process pre-flight env setup.
 *
 * Loaded via `node --require` (or ts-node's --require) from the `worker`
 * npm script BEFORE run-worker.ts and any of its imports. Two
 * responsibilities, in order:
 *
 *   1. Load the repo-root .env so unset shell vars get filled in. This
 *      MUST happen before step 2; #571 / #605 / #608 reported that the
 *      previous version of this file applied the PLANSYNC_EVENT_BUS
 *      default before .env was read, so a deliberate
 *      `PLANSYNC_EVENT_BUS=memory` in .env was silently overwritten by
 *      the default.
 *
 *   2. Apply worker-only defaults. Only PLANSYNC_EVENT_BUS=postgres
 *      today: the worker's only output channel is eventBus.publish; the
 *      memory backend (default in non-production) silently drops every
 *      event. Other workers (run-worker.ts) cannot set this env var
 *      because the bus singleton is created at module-load time, before
 *      any of their code runs — see #232 / #265 / #273 for the original
 *      report.
 *
 * The file is intentionally tiny — it runs on every worker boot.
 */
import { loadRepoDotenv } from './load-dotenv';

// 1. shell env > .env > defaults
loadRepoDotenv();

// 2. worker-side defaults
if (!process.env.PLANSYNC_EVENT_BUS) {
  process.env.PLANSYNC_EVENT_BUS = 'postgres';
}
