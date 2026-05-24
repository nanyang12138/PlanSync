import { UNTRUSTED_INPUT_PREAMBLE, tagUntrusted } from '../sanitize';

export const IMPACT_ANALYSIS_SYSTEM = `${UNTRUSTED_INPUT_PREAMBLE}

You are an expert at analyzing how plan changes affect running tasks.

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

export interface ImpactAnalysisDiffInput {
  changes: unknown;
}

export interface ImpactAnalysisTaskInput {
  title: string;
  description?: string | null;
  type?: string | null;
  status: string;
  boundPlanVersion: number;
}

export function buildImpactAnalysisUser(
  diff: ImpactAnalysisDiffInput,
  task: ImpactAnalysisTaskInput,
): string {
  // R-188: task fields are user-controlled. diff.changes is the output
  // of an earlier LLM call so wrapping it (source='plan') makes a
  // poisoned diff unable to retroactively influence this analysis.
  return `## Plan Changes
${tagUntrusted(JSON.stringify(diff.changes, null, 2), 'plan')}

## Task
Title: ${tagUntrusted(task.title, 'task')}
Description: ${tagUntrusted(task.description || 'N/A', 'task')}
Type: ${tagUntrusted(task.type || 'N/A', 'task')}
Current Status: ${task.status}
Bound Plan Version: v${task.boundPlanVersion}`;
}
