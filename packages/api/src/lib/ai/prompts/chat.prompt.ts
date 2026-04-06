export const CHAT_SYSTEM = `You are PlanSync AI, an intelligent assistant embedded in the PlanSync platform. You help teams stay aligned when plans change.

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

  // Project context block
  lines.push(`[Project: ${context.projectName}]`);

  if (context.activePlan) {
    const p = context.activePlan;
    lines.push(`Active Plan: v${p.version} "${p.title}"`);
    if (p.goal) lines.push(`Goal: ${p.goal.slice(0, 200)}`);
    if (p.scope) lines.push(`Scope: ${p.scope.slice(0, 150)}`);
    if (p.constraints.length > 0)
      lines.push(`Constraints: ${p.constraints.slice(0, 3).join('; ')}`);
    if (p.deliverables.length > 0)
      lines.push(`Deliverables: ${p.deliverables.slice(0, 3).join('; ')}`);
  } else {
    lines.push('Active Plan: None');
  }

  lines.push(
    `Tasks: ${context.taskSummary.total} total — done ${context.taskSummary.done}, in_progress ${context.taskSummary.inProgress}, todo ${context.taskSummary.todo}, blocked ${context.taskSummary.blocked}`,
  );

  if (context.taskSummary.items.length > 0) {
    const taskLines = context.taskSummary.items
      .slice(0, 15)
      .map((t) => `  - [${t.status}] ${t.title}${t.assignee ? ` (${t.assignee})` : ''}`);
    lines.push('Task list:\n' + taskLines.join('\n'));
  }

  if (context.driftAlerts.length > 0) {
    lines.push(`\nDrift Alerts (${context.driftAlerts.length} open):`);
    context.driftAlerts.forEach((d) => {
      lines.push(`  - [${d.severity}] "${d.taskTitle}": ${d.reason}`);
    });
  } else {
    lines.push('\nDrift Alerts: None — all tasks aligned.');
  }

  // Conversation history
  if (history.length > 0) {
    lines.push('\n[Conversation so far]');
    history.slice(-8).forEach((msg) => {
      lines.push(`${msg.role === 'user' ? 'User' : 'PlanSync AI'}: ${msg.content}`);
    });
  }

  lines.push(`\n[Current message]\nUser: ${message}`);

  return lines.join('\n');
}
