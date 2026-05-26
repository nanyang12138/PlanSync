// Type declarations for ./exec-shared.mjs — the shared, side-effect-free
// helpers used by both `/exec` (TypeScript CLI) and `bin/plansync --exec`
// (shell entry point via `exec-cli.mjs`).
//
// Keep this file in sync with `exec-shared.mjs`.

export type ExecAssigneeInput = {
  assignee?: string | null;
  assigneeType?: string | null;
};

export type ExecAssigneeDecision =
  | { ok: true; executorType: 'agent' | 'human'; executorName: string }
  | { ok: false; reason: string };

export function resolveExecAssignee(
  task: ExecAssigneeInput,
  currentUser: string,
): ExecAssigneeDecision;

// PR #1111 (R-?): /pack returns { data: <taskPack> } but legacy callers
// pass the raw taskPack. unwrapTaskPack handles both shapes and throws
// loudly when neither the envelope nor a recognizable taskPack is present.
export function unwrapTaskPack(response: unknown): unknown;

export function openDriftAlerts(taskPack: unknown): Array<{ status?: string; reason?: string }>;

export function buildExecPrompt(opts: { taskId: string; taskPack: unknown }): string;

export function buildExecMcpEnv(opts: {
  runId: string;
  taskId: string;
  projectId: string;
  sessionId: string;
  apiUrl?: string;
  apiKey?: string;
  user?: string;
  secret?: string;
}): Record<string, string>;

export function buildExecMcpConfigJson(opts: {
  runId: string;
  taskId: string;
  projectId: string;
  sessionId: string;
  localNodeBin: string;
  mcpServerDist: string;
  apiUrl?: string;
  apiKey?: string;
  user?: string;
  secret?: string;
}): string;
