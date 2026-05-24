import { UNTRUSTED_INPUT_PREAMBLE, tagUntrusted } from '../sanitize';

// R-190a: stable identifier for THIS prompt revision. Bump the trailing
// `r<n>` segment whenever you change the body of `COMPLETION_VERIFY_SYSTEM`
// or `buildCompletionVerifyUser` in a way that could shift the model's
// behaviour. The golden-set regression test asserts the body hash matches
// what the version claims — so forgetting to bump fails CI immediately.
export const COMPLETION_VERIFY_PROMPT_VERSION = 'completion-verify@2026-05-24-r1';

// Task types whose completion evidence must include filesChanged when claims describe
// concrete file work. Decoupling this from the prompt text makes it cheap to add new
// task types (just update this set + TASK_TYPES in shared) without rewriting the prompt.
// `ops` is reserved for future use; not yet in the TASK_TYPES enum.
const FILE_PRODUCING_TASK_TYPES = new Set(['code', 'bug', 'refactor', 'test', 'docs', 'ops']);

export function isFileProducingType(t: string): boolean {
  return FILE_PRODUCING_TASK_TYPES.has(t);
}

// R-188: untrusted-input preamble at the top of every system prompt so
// the model is consistent across capabilities about how to treat
// <untrusted> tagged spans.
export const COMPLETION_VERIFY_SYSTEM = `${UNTRUSTED_INPUT_PREAMBLE}

You are a task completion verifier for a project management system.

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

  // R-188: every field below is agent / user controlled — task fields
  // come from whoever created the task, deliverablesMet/filesChanged/
  // outputSummary are exactly what the (potentially hostile) executing
  // agent submitted. Wrap each span so the verifier model cannot be
  // talked out of its scoring rubric by a "ignore previous instructions"
  // string inside a claim.
  sections.push(`Task: ${tagUntrusted(context.taskTitle, 'task')}`);
  sections.push(`Type: ${tagUntrusted(context.taskType, 'task')}`);
  if (context.taskDescription) {
    sections.push(`\nTask description:\n${tagUntrusted(context.taskDescription, 'task')}`);
  }
  if (context.expectedOutput) {
    sections.push(`\nExpected output: ${tagUntrusted(context.expectedOutput, 'task')}`);
  }

  if (context.planDeliverableRefs && context.planDeliverableRefs.length > 0) {
    sections.push(
      `\nPlan deliverable refs (each must be explicitly addressed):\n${context.planDeliverableRefs
        .map((d, i) => `${i + 1}. ${tagUntrusted(d, 'plan')}`)
        .join('\n')}`,
    );
  }

  sections.push(
    `\nAgent's claimed deliverablesMet (${deliverablesMet.length} items):\n${
      deliverablesMet.length > 0
        ? deliverablesMet.map((d, i) => `${i + 1}. ${tagUntrusted(d, 'user')}`).join('\n')
        : '(none provided)'
    }`,
  );

  const files = context.filesChanged ?? [];
  sections.push(
    `\nFiles changed (${files.length}):\n${
      files.length > 0 ? files.map((f) => tagUntrusted(f, 'user')).join('\n') : '(none reported)'
    }`,
  );

  if (context.outputSummary) {
    sections.push(`\nOutput summary:\n${tagUntrusted(context.outputSummary, 'user')}`);
  }

  // Evaluation instruction
  sections.push(
    '\nEvaluate the evidence across all three dimensions (specificity, coherence, coverage).',
    'Score >= 75 passes.',
  );

  return sections.join('\n');
}
