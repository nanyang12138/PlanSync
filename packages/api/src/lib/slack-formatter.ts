/** Slack Block Kit blocks for incoming webhooks (loosely typed). */
export type SlackBlock = Record<string, unknown>;

export function isSlackUrl(url: string): boolean {
  return url.includes('hooks.slack.com');
}

function dashboardUrl(projectId: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001').replace(/\/$/, '');
  return `${base}/projects/${projectId}`;
}

function viewButton(projectId: string): SlackBlock {
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'View in Dashboard', emoji: true },
        url: dashboardUrl(projectId),
        action_id: 'view_dashboard',
      },
    ],
  };
}

function header(text: string): SlackBlock {
  return {
    type: 'header',
    text: { type: 'plain_text', text, emoji: true },
  };
}

function sectionMarkdown(text: string): SlackBlock {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text },
  };
}

export function formatSlackMessage(
  event: string,
  projectName: string,
  data: Record<string, unknown>,
): SlackBlock[] {
  const projectId = String(data.projectId ?? '');
  const projectLine = `*Project:* ${projectName}${projectId ? ` (\`${projectId}\`)` : ''}`;

  switch (event) {
    case 'plan_activated': {
      const title = String(data.title ?? '');
      const version = data.version != null ? String(data.version) : '?';
      const by = String(data.activatedBy ?? '');
      return [
        header('Plan activated'),
        sectionMarkdown(`${projectLine}\n*Plan:* v${version} — ${title}\n*Activated by:* ${by}`),
        viewButton(projectId),
      ];
    }
    case 'drift_detected': {
      const alerts = data.alerts as
        | Array<{ alertId?: string; taskId?: string; severity?: string }>
        | undefined;
      const n = alerts?.length ?? 0;
      const lines =
        alerts
          ?.slice(0, 10)
          .map((a, i) => `${i + 1}. task \`${a.taskId ?? '?'}\` — ${a.severity ?? '?'}`) ?? [];
      const more = n > 10 ? `\n_…and ${n - 10} more_` : '';
      return [
        header('Drift detected'),
        sectionMarkdown(`${projectLine}\n*Alerts:* ${n}\n${lines.join('\n')}${more}`),
        viewButton(projectId),
      ];
    }
    case 'task_completed': {
      const taskId = String(data.taskId ?? '');
      const title = String(data.title ?? '');
      const by = String(data.completedBy ?? data.executorName ?? '');
      return [
        header('Task completed'),
        sectionMarkdown(`${projectLine}\n*Task:* ${title} (\`${taskId}\`)\n*By:* ${by}`),
        viewButton(projectId),
      ];
    }
    default:
      return [
        header(`PlanSync: ${event}`),
        sectionMarkdown(
          `${projectLine}\n\`\`\`${JSON.stringify(data, null, 2).slice(0, 2800)}\`\`\``,
        ),
        viewButton(projectId),
      ];
  }
}
