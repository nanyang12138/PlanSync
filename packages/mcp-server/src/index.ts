#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config';
import { ApiClient } from './api-client';
import { logger } from './logger';
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

  logger.info(
    { apiUrl: config.apiBaseUrl, user: config.userName },
    'PlanSync MCP Server starting',
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  logger.error({ err }, 'MCP Server failed to start');
  process.exit(1);
});
