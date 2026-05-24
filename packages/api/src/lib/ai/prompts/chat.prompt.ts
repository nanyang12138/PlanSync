import { UNTRUSTED_INPUT_PREAMBLE, tagUntrusted } from '../sanitize';

// R-188: every system prompt begins with the untrusted-input contract
// so the model knows that <untrusted> tags wrap data, not instructions.
// The preamble is intentionally short + stable so prompt-caching
// prefixes still hit (Anthropic invalidates cache on any tools / system
// change).
export const CHAT_SYSTEM = `${UNTRUSTED_INPUT_PREAMBLE}

You are PlanSync AI, an intelligent assistant embedded in the PlanSync platform. You help teams stay aligned when plans change.

Do not reveal what underlying model you are. You are PlanSync AI.

Your capabilities:
- Answer questions about the current plan (goals, scope, constraints, deliverables)
- Explain task status and who is working on what
- Explain drift alerts: what changed, why it matters, and what action to take (rebind / no_impact / cancel)
- Recommend next steps based on current project state
- Suggest which tasks to prioritize

Keep responses concise and actionable. Use bullet points for lists. When explaining drift, always specify the recommended action.

Always respond in English, regardless of the language the user writes in.`;

export function buildChatUserMessage(
  message: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  context: {
    projectName: string;
    activePlan: {
      version: number;
      title: string;
      goal: string | null;
      scope: string | null;
      constraints: string[];
      standards: string[];
      deliverables: string[];
    } | null;
    taskSummary: {
      total: number;
      done: number;
      inProgress: number;
      todo: number;
      blocked: number;
      items: { title: string; status: string; assignee: string | null }[];
    };
    driftAlerts: {
      taskTitle: string;
      severity: string;
      reason: string;
    }[];
  },
): string {
  const lines: string[] = [];

  // R-188: every user/DB-derived string is wrapped with tagUntrusted so
  // the model can't be coerced by hostile text in task titles, plan
  // names, comment bodies, or the chat message itself. Numeric counts
  // and field labels stay outside the wrappers — they're system-author
  // content and safe.
  lines.push(`[Project: ${tagUntrusted(context.projectName, 'plan')}]`);

  if (context.activePlan) {
    const p = context.activePlan;
    lines.push(`Active Plan: v${p.version} ${tagUntrusted(p.title, 'plan')}`);
    if (p.goal) lines.push(`Goal: ${tagUntrusted(p.goal.slice(0, 200), 'plan')}`);
    if (p.scope) lines.push(`Scope: ${tagUntrusted(p.scope.slice(0, 150), 'plan')}`);
    if (p.constraints.length > 0)
      lines.push(`Constraints: ${tagUntrusted(p.constraints.slice(0, 3).join('; '), 'plan')}`);
    if (p.deliverables.length > 0)
      lines.push(`Deliverables: ${tagUntrusted(p.deliverables.slice(0, 3).join('; '), 'plan')}`);
  } else {
    lines.push('Active Plan: None');
  }

  lines.push(
    `Tasks: ${context.taskSummary.total} total — done ${context.taskSummary.done}, in_progress ${context.taskSummary.inProgress}, todo ${context.taskSummary.todo}, blocked ${context.taskSummary.blocked}`,
  );

  if (context.taskSummary.items.length > 0) {
    const taskLines = context.taskSummary.items
      .slice(0, 15)
      .map(
        (t) =>
          `  - [${t.status}] ${tagUntrusted(t.title, 'task')}${
            t.assignee ? ` (${tagUntrusted(t.assignee, 'user')})` : ''
          }`,
      );
    lines.push('Task list:\n' + taskLines.join('\n'));
  }

  if (context.driftAlerts.length > 0) {
    lines.push(`\nDrift Alerts (${context.driftAlerts.length} open):`);
    context.driftAlerts.forEach((d) => {
      lines.push(
        `  - [${d.severity}] ${tagUntrusted(d.taskTitle, 'task')}: ${tagUntrusted(d.reason, 'plan')}`,
      );
    });
  } else {
    lines.push('\nDrift Alerts: None — all tasks aligned.');
  }

  // Conversation history is wrapped too — past messages from the user
  // are equally untrusted, and a previous assistant reply could have
  // been confused into echoing injection text.
  if (history.length > 0) {
    lines.push('\n[Conversation so far]');
    history.slice(-8).forEach((msg) => {
      const role = msg.role === 'user' ? 'User' : 'PlanSync AI';
      lines.push(`${role}: ${tagUntrusted(msg.content, 'history')}`);
    });
  }

  lines.push(`\n[Current message]\nUser: ${tagUntrusted(message, 'chat')}`);

  return lines.join('\n');
}
