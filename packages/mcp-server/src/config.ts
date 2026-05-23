export interface McpConfig {
  apiBaseUrl: string;
  apiToken: string;
  userName: string;
  delegationSecret: string;
}

/**
 * R-040: Validate token presence at config-load time.
 *
 * Previously the MCP server happily started with an empty `PLANSYNC_API_KEY`
 * and only failed at first request — sending `Authorization: Bearer ` to the
 * API and getting back a confusing 401. That made first-time setup feel
 * broken ("the tool list shows up but every call fails") and produced
 * misleading error chains in logs.
 *
 * We now fail fast with a clear, actionable message that points the user at
 * the bin/plansync onboarding flow. The dev-only `AUTH_DISABLED=true` escape
 * hatch is preserved so the api integration tests + local "no-auth" demo
 * mode can keep spinning up the MCP server without provisioning a key.
 */
export function loadConfig(): McpConfig {
  const apiBaseUrl = process.env.PLANSYNC_API_URL || 'http://localhost:3001';
  const apiToken = process.env.PLANSYNC_API_KEY || '';
  const userName = process.env.PLANSYNC_USER || process.env.USER || 'unknown';
  const delegationSecret = process.env.PLANSYNC_SECRET || '';
  const authDisabled = process.env.AUTH_DISABLED === 'true';

  if (!apiToken && !authDisabled) {
    throw new Error(
      'PLANSYNC_API_KEY is not set. The MCP server cannot authenticate to the PlanSync API ' +
        'without an API key. Run `./bin/plansync` to log in and provision a key, or export ' +
        'PLANSYNC_API_KEY=<your-key> before starting the MCP server. ' +
        '(For local development without auth, set AUTH_DISABLED=true.)',
    );
  }

  return { apiBaseUrl, apiToken, userName, delegationSecret };
}
