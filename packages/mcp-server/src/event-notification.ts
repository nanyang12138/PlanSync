// Helpers for translating SSE event payloads into MCP notification
// strings. Extracted from `index.ts` so individual cases can be
// unit-tested without dragging in the `main()` side-effect that
// happens when the index module is imported.
//
// Currently this module only owns the `task_awaiting_evidence`
// formatter (fix for #1329). Other event cases live inline in
// `index.ts` because they pre-date the testability requirement and
// are covered by integration tests; relocating them here would be
// an unrelated refactor.

/**
 * Format the human-readable message for a `task_awaiting_evidence`
 * SSE event.
 *
 * Context — fix for issue #1329 (PR #1308 review finding
 * `00517b9f69f1`): the MCP-side SSE event dispatcher in `index.ts`
 * lacked a case for `task_awaiting_evidence`, so agents/IDEs
 * connected via MCP silently dropped the event when the R-192
 * gate parked a task awaiting PR-merged / deliverable-evidence
 * signals.
 *
 * Payload shape comes from the publisher in
 * `packages/api/src/app/api/projects/[projectId]/tasks/[taskId]/runs/[runId]/route.ts`
 * (awaiting-evidence branch) — mirrors `task_completed` plus a
 * `missing: TaskCompletionMissing[]` array. We accept both
 * `{ code, message }` objects (the canonical shape from
 * `task-state-machine.ts`) and bare strings, matching the same
 * defensive pattern the CLI uses in `describeEvent` so the MCP
 * notification keeps working if the publisher payload format
 * drifts slightly.
 */
export function formatAwaitingEvidenceMessage(data: Record<string, unknown>): string {
  const title =
    (typeof data.title === 'string' && data.title) ||
    (typeof data.taskId === 'string' && data.taskId) ||
    'task';
  const missing = Array.isArray(data.missing)
    ? (data.missing as Array<{ code?: string } | string>)
    : [];
  const codes = missing
    .map((m) => (typeof m === 'string' ? m : m?.code))
    .filter((c): c is string => typeof c === 'string' && c.length > 0);
  const detail = codes.length > 0 ? ` — missing ${codes.join(', ')}` : '';
  const prefix = data.projectName ? `[${data.projectName as string}] ` : '';
  return `${prefix}⚠ Task "${title}" awaiting evidence${detail}. Run finished but task did not — owner action required.`;
}
