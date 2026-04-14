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
import { registerSuggestionTools } from './tools/suggestion';
import { registerCommentTools } from './tools/comment';
import { registerTaskTools } from './tools/task';
import { registerExecutionTools, heartbeatManager } from './tools/execution';
import { registerDriftTools } from './tools/drift';
import { registerStatusTools, getDelegationAgent } from './tools/status';

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
    // Execution lifecycle
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
    // Execution lifecycle
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

  {
    const originalTool = server.tool.bind(server);
    (server as any).tool = function (name: string, ...rest: any[]) {
      // Execution mode: skip registration entirely — tool won't appear in AI's tool list
      if (execMode && !EXEC_ALLOWED.has(name)) return;

      // Wrap handler to check delegation mode at call time
      const originalHandler = rest[rest.length - 1];
      rest[rest.length - 1] = async (args: any) => {
        const delegationAgent = getDelegationAgent();
        if (delegationAgent && !DELEGATION_ALLOWED.has(name)) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'DELEGATION_BLOCKED',
                  message: `Delegation mode active (as: "${delegationAgent}") — "${name}" is blocked. Use plansync_plan_suggest to propose changes, or call plansync_delegation_clear first.`,
                }),
              },
            ],
          };
        }
        return originalHandler(args);
      };

      return originalTool(name, ...rest);
    };
  }

  if (execMode) {
    logger.info(
      { allowedTools: EXEC_ALLOWED.size, execTaskId: process.env.PLANSYNC_EXEC_TASK_ID },
      'Execution mode: tool filtering active',
    );
  }

  registerProjectTools(server, api);
  registerMemberTools(server, api);
  registerPlanTools(server, api, config);
  registerSuggestionTools(server, api);
  registerCommentTools(server, api);
  registerTaskTools(server, api);
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
  listener.start();

  const cleanup = () => {
    listener.stop();
    heartbeatManager.stopAll();
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  logger.info(
    { projectId: projectId ?? 'user-level', url: listenerUrl ?? 'project-events' },
    'Event listener started for real-time notifications',
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  logger.error({ err }, 'MCP Server failed to start');
  process.exit(1);
});
