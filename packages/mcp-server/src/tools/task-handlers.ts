/**
 * R-205 — shared internal handlers for the five task actions.
 *
 * Both the legacy `plansync_task_{create,update,claim,decline,rebind}` tools
 * (`tools/task.ts` + `tools/status.ts`) and the new unified
 * `plansync_task(action, ...)` tool (`tools/task-action.ts`) route through
 * these helpers so the wire-level contract is bit-identical regardless of
 * which surface the caller picked. This is the single source of truth for:
 *
 *   - URL routing (`/api/projects/.../tasks[/{taskId}/{claim|decline|rebind}]`)
 *   - delegation-aware client selection (in delegation mode, writes are
 *     issued as the agent rather than the human owner)
 *   - post-write verification GET (claim / decline) that surfaces a
 *     "operation may have failed" warning when the post-state doesn't
 *     match what the handler advertised
 *
 * The handlers expect their arguments to already be schema-validated.
 */
import { ApiClient } from '../api-client';
import { getDelegationAgent } from './status';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export interface TaskHandlerContext {
  api: ApiClient;
}

/**
 * In delegation mode ("work as <agent>"), any write that records the
 * caller's identity (claim/decline/update task) must be issued as that
 * agent — not as the human owner who is driving the session. Without
 * this, claims land on the owner's name and tasks look like the wrong
 * person picked them up.
 *
 * Reads (and writes that don't carry an identity) can use the raw api.
 */
function effectiveApi(api: ApiClient): ApiClient {
  const agent = getDelegationAgent();
  return agent ? api.withUser(agent) : api;
}

export interface TaskCreateArgs {
  projectId: string;
  body: Record<string, unknown>;
}

export async function handleTaskCreate(
  args: TaskCreateArgs,
  ctx: TaskHandlerContext,
): Promise<ToolResult> {
  const { projectId, body } = args;
  const result = await effectiveApi(ctx.api).post(`/api/projects/${projectId}/tasks`, body);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export interface TaskUpdateArgs {
  projectId: string;
  taskId: string;
  body: Record<string, unknown>;
}

export async function handleTaskUpdate(
  args: TaskUpdateArgs,
  ctx: TaskHandlerContext,
): Promise<ToolResult> {
  const { projectId, taskId, body } = args;
  const result = await effectiveApi(ctx.api).patch(
    `/api/projects/${projectId}/tasks/${taskId}`,
    body,
  );
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export interface TaskClaimArgs {
  projectId: string;
  taskId: string;
  assigneeType?: 'human' | 'agent';
  startImmediately?: boolean;
}

export async function handleTaskClaim(
  args: TaskClaimArgs,
  ctx: TaskHandlerContext,
): Promise<ToolResult> {
  const client = effectiveApi(ctx.api);
  const result = await client.post(`/api/projects/${args.projectId}/tasks/${args.taskId}/claim`, {
    assigneeType: args.assigneeType || 'agent',
    ...(args.startImmediately !== undefined ? { startImmediately: args.startImmediately } : {}),
  });
  const verify = await client.get<{ data?: { status?: string } }>(
    `/api/projects/${args.projectId}/tasks/${args.taskId}`,
  );
  const verifiedStatus = verify.data?.status ?? 'unknown';
  const expectedStatus = args.startImmediately === false ? 'todo' : 'in_progress';
  if (verifiedStatus !== expectedStatus) {
    return {
      content: [
        {
          type: 'text',
          text:
            `Claim call succeeded but task status is still "${verifiedStatus}", not "${expectedStatus}". ` +
            `Tell the user the claim may have failed.`,
        },
      ],
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export interface TaskDeclineArgs {
  projectId: string;
  taskId: string;
}

export async function handleTaskDecline(
  args: TaskDeclineArgs,
  ctx: TaskHandlerContext,
): Promise<ToolResult> {
  const client = effectiveApi(ctx.api);
  const result = await client.post(
    `/api/projects/${args.projectId}/tasks/${args.taskId}/decline`,
    {},
  );
  const verify = await client.get<{ data?: { assignee?: string | null } }>(
    `/api/projects/${args.projectId}/tasks/${args.taskId}`,
  );
  const verifiedAssignee = verify.data?.assignee;
  if (verifiedAssignee !== null && verifiedAssignee !== undefined && verifiedAssignee !== '') {
    return {
      content: [
        {
          type: 'text',
          text:
            `Decline call succeeded but task still has assignee "${verifiedAssignee}". ` +
            `Tell the user the decline may have failed.`,
        },
      ],
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export interface TaskRebindArgs {
  projectId: string;
  taskId: string;
}

export async function handleTaskRebind(
  args: TaskRebindArgs,
  ctx: TaskHandlerContext,
): Promise<ToolResult> {
  const { projectId, taskId } = args;
  // Rebind does not need delegation-aware client selection — the API does
  // not record the caller identity on the rebind action; it only changes
  // the bound plan version. We mirror the existing behaviour in
  // `tools/status.ts` which uses the raw api.
  const result = await ctx.api.post(`/api/projects/${projectId}/tasks/${taskId}/rebind`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}
