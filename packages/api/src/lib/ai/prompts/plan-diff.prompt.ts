import { UNTRUSTED_INPUT_PREAMBLE, tagUntrusted } from '../sanitize';

export const PLAN_DIFF_SYSTEM = `${UNTRUSTED_INPUT_PREAMBLE}

You are an expert project analyst. Compare two plan versions and identify meaningful changes.

Respond in JSON format:
{
  "changes": [
    {
      "aspect": "goal" | "scope" | "constraints" | "standards" | "deliverables" | "openQuestions",
      "type": "added" | "removed" | "modified",
      "from": "old value or null",
      "to": "new value or null",
      "impact": "high" | "medium" | "low",
      "description": "brief description of the change",
      "affectedAreas": ["area1", "area2"]
    }
  ],
  "summary": "1-2 sentence overall summary of changes",
  "breakingChanges": true | false
}`;

export interface PlanDiffInput {
  version: number;
  status: string;
  title: string;
  goal?: string | null;
  scope?: string | null;
  constraints?: unknown;
  standards?: unknown;
  deliverables?: unknown;
  openQuestions?: unknown;
}

export function buildPlanDiffUser(planA: PlanDiffInput, planB: PlanDiffInput): string {
  // R-188: every plan field is user-controlled. Plan version + status
  // come from system state and stay outside the wrap.
  return `Compare these two plan versions:

## Plan v${planA.version} (${planA.status})
Title: ${tagUntrusted(planA.title, 'plan')}
Goal: ${tagUntrusted(planA.goal || 'N/A', 'plan')}
Scope: ${tagUntrusted(planA.scope || 'N/A', 'plan')}
Constraints: ${tagUntrusted(JSON.stringify(planA.constraints || []), 'plan')}
Standards: ${tagUntrusted(JSON.stringify(planA.standards || []), 'plan')}
Deliverables: ${tagUntrusted(JSON.stringify(planA.deliverables || []), 'plan')}
Open Questions: ${tagUntrusted(JSON.stringify(planA.openQuestions || []), 'plan')}

## Plan v${planB.version} (${planB.status})
Title: ${tagUntrusted(planB.title, 'plan')}
Goal: ${tagUntrusted(planB.goal || 'N/A', 'plan')}
Scope: ${tagUntrusted(planB.scope || 'N/A', 'plan')}
Constraints: ${tagUntrusted(JSON.stringify(planB.constraints || []), 'plan')}
Standards: ${tagUntrusted(JSON.stringify(planB.standards || []), 'plan')}
Deliverables: ${tagUntrusted(JSON.stringify(planB.deliverables || []), 'plan')}
Open Questions: ${tagUntrusted(JSON.stringify(planB.openQuestions || []), 'plan')}`;
}
