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
import { registerExecutionTools } from './tools/execution';
import { registerDriftTools } from './tools/drift';
import { registerStatusTools } from './tools/status';

async function main() {
  const config = loadConfig();
  const api = new ApiClient(config);

  const server = new McpServer({
    name: 'plansync',
    version: '0.1.0',
  });

  registerProjectTools(server, api);
  registerMemberTools(server, api);
  registerPlanTools(server, api);
  registerSuggestionTools(server, api);
  registerCommentTools(server, api);
  registerTaskTools(server, api);
  registerExecutionTools(server, api);
  registerDriftTools(server, api);
  registerStatusTools(server, api);

  logger.info({ apiUrl: config.apiBaseUrl, user: config.userName }, 'PlanSync MCP Server starting');

  const projectId = process.env.PLANSYNC_PROJECT_ID;
  if (projectId) {
    const listener = new EventListener(config, projectId, (eventType, data) => {
      if (eventType === 'plan_activated') {
        logger.warn(
          { version: data.version, activatedBy: data.activatedBy },
          '⚠ PLAN CHANGED: A new plan version has been activated. Check your running tasks for drift.',
        );
      } else if (eventType === 'drift_detected') {
        const alerts = data.alerts as Array<{ taskId: string; severity: string }>;
        logger.warn(
          { alertCount: alerts?.length },
          '⚠ DRIFT DETECTED: Your tasks may be affected by the plan change.',
        );
      } else if (eventType === 'drift_resolved') {
        logger.info({ action: data.action }, 'Drift alert resolved');
      } else if (eventType === 'task_completed') {
        logger.info({ taskId: data.taskId }, 'Task completed by a team member');
      }
    });
    listener.start();

    process.on('SIGTERM', () => listener.stop());
    process.on('SIGINT', () => listener.stop());
    logger.info({ projectId }, 'Event listener started for real-time notifications');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  logger.error({ err }, 'MCP Server failed to start');
  process.exit(1);
});
