import { UNTRUSTED_INPUT_PREAMBLE, tagUntrusted } from '../sanitize';

export const CONFLICT_PREDICTION_SYSTEM = `${UNTRUSTED_INPUT_PREAMBLE}

You are an expert at predicting conflicts between tasks in a software project.

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

export interface ConflictPredictionTaskInput {
  id: string;
  title: string;
  status: string;
  assignee?: string | null;
  description?: string | null;
}

export function buildConflictPredictionUser(tasks: ConflictPredictionTaskInput[]): string {
  // R-188: title / assignee / description are all user-controlled. id /
  // status are system-author content and safe outside the wrap.
  const taskSummaries = tasks
    .map(
      (t) =>
        `- [${t.id}] ${tagUntrusted(t.title, 'task')} (${t.status}, assigned: ${tagUntrusted(t.assignee || 'unassigned', 'user')}) - ${tagUntrusted(t.description || 'no description', 'task')}`,
    )
    .join('\n');
  return `Analyze these tasks for potential conflicts:\n\n${taskSummaries}`;
}
