export const CONFLICT_PREDICTION_SYSTEM = `You are an expert at predicting conflicts between tasks in a software project.

Given a list of running/pending tasks, identify potential conflicts. Respond in JSON:
{
  "conflicts": [
    {
      "taskIds": ["id1", "id2"],
      "type": "resource" | "dependency" | "scope_overlap",
      "severity": "high" | "medium" | "low",
      "description": "explanation of the conflict",
      "recommendation": "how to resolve"
    }
  ]
}`;

export function buildConflictPredictionUser(tasks: any[]): string {
  const taskSummaries = tasks
    .map(
      (t) =>
        `- [${t.id}] "${t.title}" (${t.status}, assigned: ${t.assignee || 'unassigned'}) - ${t.description || 'no description'}`,
    )
    .join('\n');
  return `Analyze these tasks for potential conflicts:\n\n${taskSummaries}`;
}
