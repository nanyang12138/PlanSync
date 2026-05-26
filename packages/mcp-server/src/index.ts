#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config';
import { ApiClient } from './api-client';
import { logger } from './logger';
import { EventListener } from './event-listener';
import { registerProjectTools } from './tools/project';
import { registerMemberTools } from './tools/member';
import { registerPlanTools } from './tools/plan';
import { registerDeliverableTools } from './tools/deliverable';
import { registerSuggestionTools } from './tools/suggestion';
import { registerCommentTools } from './tools/comment';
import { registerTaskTools } from './tools/task';
import { registerExecutionTools, heartbeatManager } from './tools/execution';
import { registerRunTool } from './tools/run';
import { registerDriftTools } from './tools/drift';
import { registerStatusTools, getDelegationAgent } from './tools/status';
import { onRunAborted } from './abort-signal';
import { patchServerToolRegistration } from './tool-wrapper';
import { ExecStateManager, readEnforceMode } from './exec-state-manager';

function pushNotification(
  server: McpServer,
  level: 'info' | 'warning' | 'error',
  message: string,
  data?: Record<string, unknown>,
): void {
  // sendLoggingMessage is async — use .catch() to handle rejected promises
  // (synchronous try/catch cannot catch async throws)
  Promise.resolve()
    .then(() =>
      server.server.sendLoggingMessage({
        level,
        logger: 'plansync',
        data: { message, ...data },
      }),
    )
    .catch((err: unknown) => {
      logger.warn({ err }, 'Failed to send MCP logging message');
    });
}

async function main() {
  const config = loadConfig();
  const api = new ApiClient(config);

  const server = new McpServer({
    name: 'plansync',
    version: '0.1.0',
    capabilities: { logging: {} },
  });

  // --- Unified tool access guard (execution mode + delegation mode) ---
  //
  // Two contexts restrict tool access:
  //   1. Execution mode (PLANSYNC_EXEC_TASK_ID set at startup)
  //      → Tools not in EXEC_ALLOWED are not registered at all (invisible to AI)
  //   2. Delegation mode (activeDelegationAgent set at runtime via plansync_my_work)
  //      → Tools not in DELEGATION_ALLOWED return DELEGATION_BLOCKED at call time
  //
  const execMode = Boolean(process.env.PLANSYNC_EXEC_TASK_ID);

  // Execution mode whitelist — tools allowed during task execution
  const EXEC_ALLOWED = new Set([
    // Read-only queries
    'plansync_task_list',
    'plansync_task_show',
    'plansync_task_pack',
    'plansync_plan_list',
    'plansync_plan_show',
    'plansync_plan_active',
    'plansync_plan_diff',
    'plansync_status',
    'plansync_who',
    'plansync_activity_list',
    'plansync_my_work',
    'plansync_drift_list',
    'plansync_member_list',
    'plansync_project_list',
    'plansync_project_show',
    'plansync_suggestion_list',
    'plansync_comment_list',
    'plansync_exec_context',
    'plansync_check_task_conflicts',
    // R-155: deliverable read-only views — exec-mode agents need to inspect
    // the structured deliverable rows when reasoning about which file
    // changes belong to their bound task. Writes stay owner-only via
    // `requireNotExecScoped` on the API side.
    'plansync_deliverable_list',
    'plansync_deliverable_show',
    // Execution lifecycle
    // R-204: `plansync_run(action, ...)` is the new unified surface; the
    // three `plansync_execution_*` names stay registered as deprecated
    // aliases for one release.
    'plansync_run',
    'plansync_execution_start',
    'plansync_execution_heartbeat',
    'plansync_execution_complete',
    // Collaboration (safe writes)
    'plansync_comment_create',
    'plansync_comment_edit',
    'plansync_comment_delete',
    'plansync_plan_suggest',
    'plansync_drift_resolve',
    'plansync_task_rebind',
  ]);

  // Delegation mode whitelist — tools allowed when "working as <agent>"
  const DELEGATION_ALLOWED = new Set([
    // All read-only (same as exec)
    'plansync_task_list',
    'plansync_task_show',
    'plansync_task_pack',
    'plansync_plan_list',
    'plansync_plan_show',
    'plansync_plan_active',
    'plansync_plan_diff',
    'plansync_status',
    'plansync_who',
    'plansync_activity_list',
    'plansync_my_work',
    'plansync_drift_list',
    'plansync_member_list',
    'plansync_project_list',
    'plansync_project_show',
    'plansync_suggestion_list',
    'plansync_comment_list',
    'plansync_exec_context',
    'plansync_check_task_conflicts',
    // R-155: deliverable reads available in delegation mode too. Writes
    // are owner-only and would fail at the API layer regardless, but
    // reads are useful when an agent reviews a plan and wants to see
    // structured deliverables instead of the legacy String[] mirror.
    'plansync_deliverable_list',
    'plansync_deliverable_show',
    // Execution lifecycle
    // R-204: unified `plansync_run` surface + deprecated aliases.
    'plansync_run',
    'plansync_execution_start',
    'plansync_execution_heartbeat',
    'plansync_execution_complete',
    // Collaboration
    'plansync_comment_create',
    'plansync_comment_edit',
    'plansync_comment_delete',
    'plansync_plan_suggest',
    'plansync_drift_resolve',
    'plansync_task_rebind',
    // Agent task operations (claim, decline, update own task)
    'plansync_task_claim',
    'plansync_task_decline',
    'plansync_task_update',
    // Plan review (agent's core delegation action)
    'plansync_review_approve',
    'plansync_review_reject',
    // Exit delegation
    'plansync_delegation_clear',
  ]);

  // R-037: centralised wrapper around `server.tool` registrations. Each tool
  // call now goes through:
  //   1. abort check (drift v2 run-abort flag)
  //   2. delegation check (DELEGATION_ALLOWED)
  //   3. try/catch around the handler → `{ isError: true, content: [...] }`
  //      envelope on any thrown error (ApiError or otherwise).
  // R-171: per-session FSM tracker. Only attached when an enforce mode is
  // configured AND a secret is available — without either, the manager
  // would be dead weight, so we omit it entirely to keep behaviour
  // identical to pre-R-171 for unconfigured deploys.
  const enforceMode = readEnforceMode();
  const execStateManager =
    enforceMode !== 'off' && config.delegationSecret
      ? new ExecStateManager({
          secret: config.delegationSecret,
          enforceMode,
          // runId / projectId / taskId get bound at exec_context /
          // execution_start time via execStateManager.bindRun(...).
        })
      : undefined;
  if (enforceMode !== 'off' && !config.delegationSecret) {
    logger.warn(
      { enforceMode },
      'R-171: PLANSYNC_EXEC_STATE_ENFORCE is set but PLANSYNC_SECRET is missing — FSM disabled',
    );
  }
  if (execStateManager) {
    logger.info({ enforceMode }, 'R-171: exec-state FSM enabled (rollout flag honored)');
  }

  patchServerToolRegistration(server as unknown as { tool: (...a: unknown[]) => unknown }, {
    execAllowed: execMode ? EXEC_ALLOWED : undefined,
    delegationAllowed: DELEGATION_ALLOWED,
    getDelegationAgent: () => getDelegationAgent() ?? undefined,
    execStateManager,
  });

  if (execMode) {
    logger.info(
      { allowedTools: EXEC_ALLOWED.size, execTaskId: process.env.PLANSYNC_EXEC_TASK_ID },
      'Execution mode: tool filtering active',
    );
  }

  // Drift v2: when the heartbeat detects RUN_PAUSED / RUN_STALE_VERSION /
  // RUN_RACE_LOST, push a structured notification to the client. The CLI
  // mcp-client recognises `data.type === 'execution_aborted'` and fires its
  // local AbortController so the ai-loop exits at the next turn boundary.
  // Generic MCP clients (Claude Code, Cursor, …) see an 'error'-level log
  // message they can render in chat. Heartbeat already stops itself; this
  // is purely the "tell the agent" half.
  onRunAborted((reason) => {
    Promise.resolve()
      .then(() =>
        server.server.sendLoggingMessage({
          level: 'error',
          logger: 'plansync',
          data: {
            type: 'execution_aborted',
            message: `⚠ EXECUTION ABORTED (${reason.code}): ${reason.message}`,
            ...reason,
          },
        }),
      )
      .catch((err: unknown) => {
        logger.warn({ err }, 'Failed to push execution_aborted notification');
      });
    heartbeatManager.stopAll();
  });

  registerProjectTools(server, api);
  registerMemberTools(server, api);
  registerPlanTools(server, api, config);
  registerDeliverableTools(server, api);
  registerSuggestionTools(server, api);
  registerCommentTools(server, api);
  registerTaskTools(server, api);
  // R-204: register `plansync_run` first so the new surface shows up
  // before its deprecated aliases in `tools/list`. Both write into the
  // same `server` object; ordering is purely cosmetic / hint-friendly.
  registerRunTool(server, api);
  registerExecutionTools(server, api);
  registerDriftTools(server, api);
  registerStatusTools(server, api, config);

  logger.info({ apiUrl: config.apiBaseUrl, user: config.userName }, 'PlanSync MCP Server starting');

  const projectId = process.env.PLANSYNC_PROJECT ?? null;
  // Always subscribe to user-level SSE so the user receives notifications from ALL their
  // projects, not just the currently active one. /api/user-events enriches each event with
  // projectId and projectName so we can prefix messages accordingly.
  const listenerUrl = `${config.apiBaseUrl}/api/user-events`;

  const listener = new EventListener(
    config,
    projectId,
    (eventType, data) => {
      // Prefix notification with [ProjectName] when event comes from user-level SSE
      // (user-events adds projectName to each event; project-specific SSE does not)
      const pfx = (msg: string) =>
        data.projectName ? `[${data.projectName as string}] ${msg}` : msg;

      switch (eventType) {
        case 'plan_activated': {
          const msg = pfx(
            `⚠ Plan v${data.version} activated by ${data.activatedBy}. Check your tasks for drift — running work may be affected.`,
          );
          logger.warn({ version: data.version, activatedBy: data.activatedBy }, msg);
          pushNotification(server, 'warning', msg, {
            version: data.version,
            activatedBy: data.activatedBy,
          });
          break;
        }
        case 'drift_detected': {
          const alerts = data.alerts as Array<{ taskId: string; severity: string }> | undefined;
          const highCount = alerts?.filter((a) => a.severity === 'high').length ?? 0;
          const medCount = alerts?.filter((a) => a.severity === 'medium').length ?? 0;
          const msg = pfx(
            `⚠ Drift detected: ${alerts?.length ?? 0} alert(s) (${highCount} high, ${medCount} medium). Pause execution and check drift alerts.`,
          );
          logger.warn({ alertCount: alerts?.length, highCount, medCount }, msg);
          pushNotification(server, 'warning', msg, { alerts: data.alerts });
          break;
        }
        case 'drift_resolved': {
          const msg = pfx(
            `Drift alert resolved (action: ${data.resolvedAction ?? data.action}, by: ${data.resolvedBy ?? 'unknown'})`,
          );
          logger.info({ alertId: data.alertId, action: data.resolvedAction ?? data.action }, msg);
          pushNotification(server, 'info', msg, { alertId: data.alertId });
          break;
        }
        case 'task_created': {
          logger.info({ taskId: data.taskId, title: data.title }, 'New task created');
          pushNotification(server, 'info', pfx(`New task created: "${data.title}"`), {
            taskId: data.taskId,
          });
          break;
        }
        case 'task_assigned': {
          const msg = pfx(`Task "${data.title}" assigned to ${data.assignee}`);
          logger.info({ taskId: data.taskId, assignee: data.assignee }, msg);
          pushNotification(server, 'info', msg, { taskId: data.taskId });
          break;
        }
        case 'task_unassigned': {
          const msg = pfx(`Task unassigned (was: ${data.previousAssignee})`);
          logger.info({ taskId: data.taskId, previousAssignee: data.previousAssignee }, msg);
          pushNotification(server, 'info', msg, { taskId: data.taskId });
          break;
        }
        case 'task_completed': {
          const msg = pfx(`Task "${data.title ?? data.taskId}" completed`);
          logger.info({ taskId: data.taskId }, msg);
          pushNotification(server, 'info', msg, { taskId: data.taskId });
          break;
        }
        case 'task_started': {
          logger.info(
            { taskId: data.taskId, executor: data.executorName, type: data.executorType },
            'Execution run started',
          );
          break;
        }
        case 'execution_stale': {
          const msg = pfx(
            `⚠ Execution run went stale (no heartbeat) — executor "${data.executorName}" may have crashed`,
          );
          logger.warn({ runId: data.runId, taskId: data.taskId }, msg);
          pushNotification(server, 'warning', msg, { runId: data.runId, taskId: data.taskId });
          break;
        }
        case 'suggestion_created': {
          const msg = pfx(
            `New plan suggestion by ${data.suggestedBy}: ${data.field} → "${data.value}"`,
          );
          logger.info({ suggestionId: data.suggestionId }, msg);
          pushNotification(server, 'info', msg, {
            suggestionId: data.suggestionId,
            planId: data.planId,
          });
          break;
        }
        case 'suggestion_resolved': {
          const msg = pfx(
            `Plan suggestion resolved (status: ${data.status ?? data.resolution}, by: ${data.resolvedBy ?? 'unknown'})`,
          );
          logger.info(
            {
              suggestionId: data.suggestionId,
              status: data.status ?? data.resolution,
              resolvedBy: data.resolvedBy,
            },
            msg,
          );
          pushNotification(server, 'info', msg, { suggestionId: data.suggestionId });
          break;
        }
        case 'plan_proposed': {
          const msg = pfx(`Plan "${data.title}" submitted for review by ${data.proposedBy}`);
          logger.info({ planId: data.planId }, msg);
          pushNotification(server, 'info', msg, { planId: data.planId });
          break;
        }
        case 'member_added': {
          logger.info(
            { name: data.name, role: data.role },
            `Member "${data.name}" added to project`,
          );
          break;
        }
        case 'member_removed': {
          logger.info(
            { memberName: data.memberName },
            `Member "${data.memberName}" removed from project`,
          );
          break;
        }
        default:
          logger.debug({ eventType, data }, 'Unhandled SSE event');
      }
    },
    undefined,
    listenerUrl,
  );
  // The CLI REPL subscribes to SSE directly and sets PLANSYNC_MCP_DISABLE_SSE=1
  // to prevent duplicate notifications. In all other contexts (Claude Code,
  // Codex, Cursor, Genie agent) we keep the MCP-side listener active.
  const sseDisabled = process.env.PLANSYNC_MCP_DISABLE_SSE === '1';
  if (!sseDisabled) {
    listener.start();
    logger.info(
      { projectId: projectId ?? 'user-level', url: listenerUrl ?? 'project-events' },
      'Event listener started for real-time notifications',
    );
  } else {
    logger.info('SSE listener disabled (PLANSYNC_MCP_DISABLE_SSE=1)');
  }

  const cleanup = () => {
    listener.stop();
    heartbeatManager.stopAll();
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  process.stdout.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  logger.error({ err }, 'MCP Server failed to start');
  process.exit(1);
});
