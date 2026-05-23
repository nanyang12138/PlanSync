/**
 * Worker-process pre-flight env setup.
 *
 * Loaded via `node --require` (or ts-node's --require) from the `worker`
 * npm script BEFORE run-worker.ts and any of its imports. The single
 * responsibility is to set environment variables that other modules read
 * at module-load time — once `event-bus.ts` (or anything that transitively
 * imports it) is required, its singleton is created with whatever
 * PLANSYNC_EVENT_BUS resolves to right then. Putting that decision here
 * guarantees the worker always picks the cross-process backend, instead
 * of relying on every operator to set the env var by hand on every host.
 *
 * Reviewers (#232, #265, #273):
 *   - The worker's only output channel is eventBus.publish — scanner
 *     emits execution_stale / execution_superseded.
 *   - Without this preamble, when NODE_ENV !== 'production' the bus
 *     resolves to MemoryEventBus and every published event is fanned
 *     out only inside the worker process (= nowhere observable).
 *   - The API process's SSE / webhook subscribers see nothing, the
 *     symptom is "stale runs are detected but the UI never updates",
 *     and ops debugging starts at the wrong layer.
 *
 * Operator override: set PLANSYNC_EVENT_BUS=memory explicitly to opt
 * out (single-host single-process dev where you really do want only
 * an in-process bus). The check below honours any pre-existing value.
 */

if (!process.env.PLANSYNC_EVENT_BUS) {
  process.env.PLANSYNC_EVENT_BUS = 'postgres';
}
