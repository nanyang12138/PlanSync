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
import { registerStatusTools } from './tools/status';

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
  const listenerUrl = projectId ? undefined : `${config.apiBaseUrl}/api/user-events`;

  const listener = new EventListener(
    config,
    projectId,
    (eventType, data) => {
      switch (eventType) {
        case 'plan_activated': {
          const msg = `⚠ Plan v${data.version} activated by ${data.activatedBy}. Check your tasks for drift — running work may be affected.`;
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
          const msg = `⚠ Drift detected: ${alerts?.length ?? 0} alert(s) (${highCount} high, ${medCount} medium). Pause execution and check drift alerts.`;
          logger.warn({ alertCount: alerts?.length, highCount, medCount }, msg);
          pushNotification(server, 'warning', msg, { alerts: data.alerts });
          break;
        }
        case 'drift_resolved': {
          const msg = `Drift alert resolved (action: ${data.resolvedAction ?? data.action}, by: ${data.resolvedBy ?? 'unknown'})`;
          logger.info({ alertId: data.alertId, action: data.resolvedAction ?? data.action }, msg);
          pushNotification(server, 'info', msg, { alertId: data.alertId });
          break;
        }
        case 'task_created': {
          logger.info({ taskId: data.taskId, title: data.title }, 'New task created');
          pushNotification(server, 'info', `New task created: "${data.title}"`, {
            taskId: data.taskId,
          });
          break;
        }
        case 'task_assigned': {
          const msg = `Task "${data.title}" assigned to ${data.assignee}`;
          logger.info({ taskId: data.taskId, assignee: data.assignee }, msg);
          pushNotification(server, 'info', msg, { taskId: data.taskId });
          break;
        }
        case 'task_unassigned': {
          const msg = `Task unassigned (was: ${data.previousAssignee})`;
          logger.info({ taskId: data.taskId, previousAssignee: data.previousAssignee }, msg);
          pushNotification(server, 'info', msg, { taskId: data.taskId });
          break;
        }
        case 'task_completed': {
          const msg = `Task "${data.title ?? data.taskId}" completed`;
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
          const msg = `⚠ Execution run went stale (no heartbeat) — executor "${data.executorName}" may have crashed`;
          logger.warn({ runId: data.runId, taskId: data.taskId }, msg);
          pushNotification(server, 'warning', msg, { runId: data.runId, taskId: data.taskId });
          break;
        }
        case 'suggestion_created': {
          const msg = `New plan suggestion by ${data.suggestedBy}: ${data.field} → "${data.value}"`;
          logger.info({ suggestionId: data.suggestionId }, msg);
          pushNotification(server, 'info', msg, {
            suggestionId: data.suggestionId,
            planId: data.planId,
          });
          break;
        }
        case 'suggestion_resolved': {
          const msg = `Plan suggestion resolved (status: ${data.status ?? data.resolution}, by: ${data.resolvedBy ?? 'unknown'})`;
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
          const msg = `Plan "${data.title}" submitted for review by ${data.proposedBy}`;
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
