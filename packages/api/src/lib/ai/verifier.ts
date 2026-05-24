// R-187: lightweight LLM-as-Judge second pass for high-side-effect AI
// outputs.
//
// Background. Industry research (BoN-MAV / AEMA / arxiv 2502.20379)
// consistently shows that a single LLM judgement plateaus on accuracy
// while a second cheap pass keeps improving. PlanSync only needs the
// second pass on the two outputs that drive cascading side effects in
// the rest of the system:
//
//   1. plan-diff: `breakingChanges === true` triggers the drift impact
//      flow across every open task — a hallucinated true value is loud
//      and expensive.
//   2. impact-analysis: `suggestedAction === 'cancel'` is the most
//      destructive recommendation the model can make (the next UI step
//      cancels the task entirely) — a false cancel costs the user a
//      whole work run.
//
// Design choices.
//
//   * Use the same provider/model chain via aiClient.complete — we get
//     R-183 fallback + cache + R-182 observability for free; the second
//     pass shows up as its own `verifier_*` purpose in the dashboard.
//   * Single short prompt, max_tokens implicit via the verdict schema.
//     The verifier MUST NOT see the original prompt — only the input
//     facts and the candidate output. This eliminates the
//     "echo-chamber" failure mode where the judge inherits the
//     generator's bias.
//   * Three-valued verdict — `agree | reject | partial` — instead of
//     binary so we can leave "partial" outputs in place but flag them.
//   * Verifier never blocks the request: a `null` from the second pass
//     just means "couldn't verify" and the candidate is used as-is.
//     Hard gates live in R-181 (declarative verification_rules); R-187
//     is strictly advisory.

import { z } from 'zod';
import { aiClient } from './client';
import { logger } from '../logger';

const VERIFIER_RESULT_SCHEMA_Z = z.object({
  verdict: z.enum(['agree', 'reject', 'partial']),
  reasoning: z.string().max(800),
});

const VERIFIER_TOOL_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reasoning'],
  properties: {
    verdict: { type: 'string', enum: ['agree', 'reject', 'partial'] },
    reasoning: { type: 'string', maxLength: 800 },
  },
} as const;

export interface VerifierResult {
  verdict: 'agree' | 'reject' | 'partial';
  reasoning: string;
}

async function runVerifier(
  purpose: string,
  system: string,
  user: string,
): Promise<VerifierResult | null> {
  if (!aiClient.isAvailable) return null;
  const raw = await aiClient.complete(system, user, {
    purpose,
    tool: {
      name: 'emit_verdict',
      description: 'Emit your binary-style verdict on whether the candidate output is grounded.',
      jsonSchema: VERIFIER_TOOL_JSON_SCHEMA as unknown as Record<string, unknown>,
    },
  });
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const safe = VERIFIER_RESULT_SCHEMA_Z.safeParse(parsed);
    if (!safe.success) {
      logger.warn({ purpose, issues: safe.error.flatten() }, 'verifier_invalid_schema');
      return null;
    }
    return safe.data;
  } catch (err) {
    logger.warn({ purpose, err }, 'verifier_parse_failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// plan-diff verifier — only invoked when breakingChanges === true
// ---------------------------------------------------------------------------

const PLAN_DIFF_VERIFIER_SYSTEM = `You are a strict reviewer of plan-diff outputs.

You receive: (a) two source plans (their key fields), (b) a candidate diff
the previous model produced, including breakingChanges=true.

Decide: do the candidate's "from"/"to" pairs match the source plans
verbatim or near-verbatim, AND does at least one change describe a
genuinely breaking modification (e.g. a constraint removed, a goal
fundamentally rewritten, a deliverable removed)?

Return:
  verdict = "agree"   → the candidate is well-grounded; breakingChanges=true is justified
  verdict = "reject"  → the candidate is fabricated OR no change is actually breaking
  verdict = "partial" → some changes match but breakingChanges is not justified by the matched subset

Be terse — one short sentence of reasoning. Do not hedge.`;

export async function verifyPlanDiffBreaking(opts: {
  planA: { goal?: string | null; scope?: string | null; constraints?: unknown; standards?: unknown; deliverables?: unknown; openQuestions?: unknown };
  planB: { goal?: string | null; scope?: string | null; constraints?: unknown; standards?: unknown; deliverables?: unknown; openQuestions?: unknown };
  candidate: { changes: Array<{ aspect: string; from: string | null; to: string | null; type: string }>; summary: string; breakingChanges: boolean };
}): Promise<VerifierResult | null> {
  if (!opts.candidate.breakingChanges) return null;
  const user = [
    '## Plan A (before)',
    `goal: ${opts.planA.goal ?? 'N/A'}`,
    `scope: ${opts.planA.scope ?? 'N/A'}`,
    `constraints: ${JSON.stringify(opts.planA.constraints ?? [])}`,
    `standards: ${JSON.stringify(opts.planA.standards ?? [])}`,
    `deliverables: ${JSON.stringify(opts.planA.deliverables ?? [])}`,
    '',
    '## Plan B (after)',
    `goal: ${opts.planB.goal ?? 'N/A'}`,
    `scope: ${opts.planB.scope ?? 'N/A'}`,
    `constraints: ${JSON.stringify(opts.planB.constraints ?? [])}`,
    `standards: ${JSON.stringify(opts.planB.standards ?? [])}`,
    `deliverables: ${JSON.stringify(opts.planB.deliverables ?? [])}`,
    '',
    '## Candidate diff (must justify breakingChanges=true)',
    JSON.stringify(opts.candidate, null, 2),
  ].join('\n');
  return runVerifier('verifier_plan_diff_breaking', PLAN_DIFF_VERIFIER_SYSTEM, user);
}

// ---------------------------------------------------------------------------
// impact-analysis verifier — only invoked when suggestedAction === 'cancel'
// ---------------------------------------------------------------------------

const IMPACT_CANCEL_VERIFIER_SYSTEM = `You are a strict reviewer of drift-impact recommendations.

You receive: (a) the plan diff between two plan versions, (b) the task
that is bound to the older version, (c) a candidate impact analysis
that recommends suggestedAction="cancel".

Cancel is destructive — the task will be released without completing.
Decide: is the diff actually incompatible enough with this task that
cancelling (instead of rebinding) is the correct call?

Return:
  verdict = "agree"   → the cancellation is justified by the diff content
  verdict = "reject"  → the diff is compatible enough that rebind would be safer
  verdict = "partial" → the diff is messy but cancel is too extreme; downgrade to rebind

Be terse. One short sentence of reasoning.`;

export async function verifyImpactCancel(opts: {
  diff: { changes: unknown; summary?: string; breakingChanges?: boolean };
  task: { title: string; description?: string | null; type?: string | null; status: string; boundPlanVersion: number };
  candidate: { compatibilityScore: number; suggestedAction: string; reasoning: string; affectedAreas: string[]; riskLevel: string };
}): Promise<VerifierResult | null> {
  if (opts.candidate.suggestedAction !== 'cancel') return null;
  const user = [
    '## Plan Diff',
    JSON.stringify(opts.diff, null, 2),
    '',
    '## Task',
    `title: ${opts.task.title}`,
    `description: ${opts.task.description ?? 'N/A'}`,
    `type: ${opts.task.type ?? 'N/A'}`,
    `status: ${opts.task.status}`,
    `boundPlanVersion: v${opts.task.boundPlanVersion}`,
    '',
    '## Candidate impact analysis (suggestedAction=cancel)',
    JSON.stringify(opts.candidate, null, 2),
  ].join('\n');
  return runVerifier('verifier_impact_cancel', IMPACT_CANCEL_VERIFIER_SYSTEM, user);
}
