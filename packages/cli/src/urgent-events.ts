/**
 * Events that trigger an URGENT notification in the CLI — a 30s red flash in
 * the Ink prompt area above the input line (in addition to landing in
 * notifLog).
 *
 * This must stay in lockstep with the Web-side sticky warning toasts in
 * packages/api/src/components/notifications.tsx (see EVENT_HANDLERS and the
 * named-listener whitelist). Both surfaces represent
 * "user must act / be aware now".
 *
 * Lives in its own module (rather than inside `index.ts`) because `index.ts`
 * calls `main()` at module load, so it cannot be imported from a unit test
 * without spawning the REPL.
 */
export const URGENT_EVENTS: ReadonlySet<string> = new Set([
  'drift_detected',
  'execution_stale',
  'plan_activated',
  'review_requested',
  'review_approved',
  'review_rejected',
  'task_assigned',
  'suggestion_created',
  // Closes #1402 — R-192 evidence gate parked the task in `awaiting_evidence`.
  // The Web surface marks this as a sticky warning toast; the CLI must match
  // by flashing the prompt area, otherwise the user can miss the gate hit.
  'task_awaiting_evidence',
]);
