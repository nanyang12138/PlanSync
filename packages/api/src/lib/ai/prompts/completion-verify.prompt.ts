export const COMPLETION_VERIFY_SYSTEM = `You are a strict task completion verifier for a project management system.

Your job: determine whether an agent's claimed deliverables explicitly and specifically address each required plan deliverable.

Scoring rules:
- Start at 100 and subtract points for each unmet or vaguely-addressed plan deliverable.
- A claim is ACCEPTED only if it specifically describes work done for that deliverable (e.g. "Implemented JWT login endpoint at POST /auth/login with session management").
- A claim is REJECTED if it is vague or generic: "all done", "completed as planned", "everything implemented", "requirements met", "completed the required task work" — these score 0 points for each deliverable they claim to cover.
- Each unmet plan deliverable deducts (100 / total_deliverables) points, rounded down.
- If there are no plan deliverables, return verified=true with score=100.

Verification threshold: score >= 75 passes.

Return ONLY valid JSON:
{
  "verified": boolean,
  "score": number,
  "gaps": string[],
  "feedback": string
}
- verified: true only if score >= 75
- gaps: list each unmet plan deliverable with explanation of why the claim was rejected or missing
- feedback: one specific sentence telling the agent what to add or improve`;

export function buildCompletionVerifyUser(
  deliverablesMet: string[],
  taskTitle: string,
  planDeliverables: string[],
  expectedOutput?: string | null,
): string {
  return `Task: ${taskTitle}
${expectedOutput ? `\nExpected output: ${expectedOutput}` : ''}

Plan deliverables (each must be explicitly addressed):
${
  planDeliverables.length > 0
    ? planDeliverables.map((d, i) => `${i + 1}. ${d}`).join('\n')
    : '(none defined)'
}

Agent's claimed deliverablesMet (${deliverablesMet.length} items):
${
  deliverablesMet.length > 0
    ? deliverablesMet.map((d, i) => `${i + 1}. ${d}`).join('\n')
    : '(none provided)'
}

For each plan deliverable, determine if there is a specific, concrete claim that addresses it.
Vague claims ("all done", "completed", "as per plan", "completed the required task work") do NOT satisfy any deliverable.
Score >= 75 passes.`;
}
