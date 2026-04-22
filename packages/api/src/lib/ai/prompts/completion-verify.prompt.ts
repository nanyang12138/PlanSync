// Task types whose completion evidence must include filesChanged when claims describe
// concrete file work. Decoupling this from the prompt text makes it cheap to add new
// task types (just update this set + TASK_TYPES in shared) without rewriting the prompt.
// `ops` is reserved for future use; not yet in the TASK_TYPES enum.
const FILE_PRODUCING_TASK_TYPES = new Set(['code', 'bug', 'refactor', 'test', 'docs', 'ops']);

export function isFileProducingType(t: string): boolean {
  return FILE_PRODUCING_TASK_TYPES.has(t);
}

export const COMPLETION_VERIFY_SYSTEM = `You are a task completion verifier for a project management system.

Your job: evaluate whether an agent's submitted evidence demonstrates genuine, specific completion of the assigned task.

## Evidence Signals

You receive multiple signals — use them ALL:

1. **deliverablesMet** (agent's claims): What the agent says they did
2. **filesChanged** (file evidence): What files were actually modified
3. **outputSummary** (work summary): Agent's narrative of the work
4. **Task context** (title, type, description, expectedOutput): What was requested
5. **planDeliverableRefs** (if present): Specific plan deliverables this task must cover

## Evaluation Criteria

Score on a 0-100 scale across three dimensions:

### Specificity (up to 35 points)
- Claims must name concrete artifacts: endpoints, files, functions, test counts, specific behaviors
- REJECT vague claims: "all done", "completed", "completed as planned", "everything implemented", "requirements met", "completed the required task work", "task finished" — score 0 for this dimension
- Partial credit for a mix of specific and vague claims

### Coherence (up to 35 points)
- Do claims, filesChanged, and outputSummary tell a consistent story?
- For "file-producing" tasks (code, bug, refactor, test, docs, ops): if filesChanged is empty but claims describe file work (e.g. "implemented", "created", "wrote test", "updated README", "added Dockerfile") — this is suspicious, max 10 points for coherence
- For "file-optional" tasks (research, design): filesChanged being empty is expected and normal — do NOT penalize. Evaluate coherence between claims and outputSummary instead.
- Claims mention specific files not listed in filesChanged — deduct points
- Strong signal: filesChanged aligns with claimed work areas

### Scope Coverage (up to 30 points)
- If planDeliverableRefs are provided: each ref must be explicitly addressed by at least one claim. Deduct (30 / total_refs) points per unaddressed ref.
- If no planDeliverableRefs: evaluate against task description and expectedOutput — are the major goals addressed?
- If task has minimal context (title only): evaluate whether claims plausibly relate to the title — be more lenient on coverage but strict on specificity

## Anti-Gaming Rules
- Parroting the task description back is NOT evidence of work — claims must add detail beyond what the task already states
- Claims must describe HOW something was done, not just WHAT was requested
- Generic claims that could apply to any task score 0

Threshold: score >= 75 passes.

Return ONLY valid JSON:
{
  "verified": boolean,
  "score": number,
  "breakdown": { "specificity": number, "coherence": number, "coverage": number },
  "gaps": string[],
  "feedback": string
}
- verified: true only if score >= 75
- breakdown: points awarded per dimension
- gaps: list each unmet requirement with explanation
- feedback: one specific sentence telling the agent what to add or improve`;

export interface CompletionVerifyContext {
  taskTitle: string;
  taskType: string;
  taskDescription?: string | null;
  expectedOutput?: string | null;
  planDeliverableRefs?: string[];
  filesChanged?: string[];
  outputSummary?: string | null;
}

export function buildCompletionVerifyUser(
  deliverablesMet: string[],
  context: CompletionVerifyContext,
): string {
  const sections: string[] = [];

  // Task context
  sections.push(`Task: ${context.taskTitle}`);
  sections.push(`Type: ${context.taskType}`);
  if (context.taskDescription) {
    sections.push(`\nTask description:\n${context.taskDescription}`);
  }
  if (context.expectedOutput) {
    sections.push(`\nExpected output: ${context.expectedOutput}`);
  }

  // Plan deliverable refs (structured requirements, if any)
  if (context.planDeliverableRefs && context.planDeliverableRefs.length > 0) {
    sections.push(
      `\nPlan deliverable refs (each must be explicitly addressed):\n${context.planDeliverableRefs.map((d, i) => `${i + 1}. ${d}`).join('\n')}`,
    );
  }

  // Agent evidence: claims
  sections.push(
    `\nAgent's claimed deliverablesMet (${deliverablesMet.length} items):\n${
      deliverablesMet.length > 0
        ? deliverablesMet.map((d, i) => `${i + 1}. ${d}`).join('\n')
        : '(none provided)'
    }`,
  );

  // Agent evidence: files changed
  const files = context.filesChanged ?? [];
  sections.push(
    `\nFiles changed (${files.length}):\n${
      files.length > 0 ? files.join('\n') : '(none reported)'
    }`,
  );

  // Agent evidence: output summary
  if (context.outputSummary) {
    sections.push(`\nOutput summary:\n${context.outputSummary}`);
  }

  // Evaluation instruction
  sections.push(
    '\nEvaluate the evidence across all three dimensions (specificity, coherence, coverage).',
    'Score >= 75 passes.',
  );

  return sections.join('\n');
}
