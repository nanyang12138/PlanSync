export interface McpConfig {
  apiBaseUrl: string;
  apiToken: string;
  userName: string;
  delegationSecret: string;
}

export function loadConfig(): McpConfig {
  const apiBaseUrl = process.env.PLANSYNC_API_URL || 'http://localhost:3001';
  const apiToken = process.env.PLANSYNC_API_KEY || '';
  const userName = process.env.PLANSYNC_USER || process.env.USER || 'unknown';
  const delegationSecret = process.env.PLANSYNC_SECRET || '';

  return { apiBaseUrl, apiToken, userName, delegationSecret };
}
