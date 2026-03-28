export const PLAN_DIFF_SYSTEM = `You are an expert project analyst. Compare two plan versions and identify meaningful changes.

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

export function buildPlanDiffUser(planA: any, planB: any): string {
  return `Compare these two plan versions:

## Plan v${planA.version} (${planA.status})
Title: ${planA.title}
Goal: ${planA.goal || 'N/A'}
Scope: ${planA.scope || 'N/A'}
Constraints: ${JSON.stringify(planA.constraints || [])}
Standards: ${JSON.stringify(planA.standards || [])}
Deliverables: ${JSON.stringify(planA.deliverables || [])}
Open Questions: ${JSON.stringify(planA.openQuestions || [])}

## Plan v${planB.version} (${planB.status})
Title: ${planB.title}
Goal: ${planB.goal || 'N/A'}
Scope: ${planB.scope || 'N/A'}
Constraints: ${JSON.stringify(planB.constraints || [])}
Standards: ${JSON.stringify(planB.standards || [])}
Deliverables: ${JSON.stringify(planB.deliverables || [])}
Open Questions: ${JSON.stringify(planB.openQuestions || [])}`;
}
