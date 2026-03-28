export const IMPACT_ANALYSIS_SYSTEM = `You are an expert at analyzing how plan changes affect running tasks.

Given a plan diff and a task, assess compatibility. Respond in JSON:
{
  "compatibilityScore": 0-100,
  "compatible": true | false,
  "suggestedAction": "no_impact" | "rebind" | "cancel",
  "reasoning": "brief explanation",
  "affectedAreas": ["area1"],
  "riskLevel": "high" | "medium" | "low"
}

Rules:
- Score > 70: Task is likely compatible, suggest "no_impact"
- Score 30-70: Task may need adjustment, suggest "rebind" with notes
- Score < 30: Task is likely incompatible, suggest "cancel"`;

export function buildImpactAnalysisUser(diff: any, task: any): string {
  return `## Plan Changes
${JSON.stringify(diff.changes, null, 2)}

## Task
Title: ${task.title}
Description: ${task.description || 'N/A'}
Type: ${task.type || 'N/A'}
Current Status: ${task.status}
Bound Plan Version: v${task.boundPlanVersion}`;
}
