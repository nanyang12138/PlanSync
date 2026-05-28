/**
 * R-181: declarative verification rules engine.
 *
 * Background
 * ----------
 * R-180 demoted the AI completion-verify path from a hard 422 gate to an
 * advisory `RunReview` row — agents could otherwise be trapped in a
 * complete→retry loop when the LLM scored their work 74/100. R-181 then
 * re-introduces a HARD gate, but a *deterministic, owner-configurable*
 * one: rows in `verification_rules` describe what evidence the owner
 * wants every (or some) run to provide, and the route 422s with a
 * structured `{ gate: 'rule', failedRules: [...] }` envelope when any
 * rule fails.
 *
 * The split is intentional and matches R-184's future UI work:
 *
 *   - `RunReview { kind: 'ai_verification', ... }`  — soft, informational
 *   - `422 { gate: 'rule', failedRules: ... }`      — hard, deterministic
 *
 * Adding a new rule kind
 * ----------------------
 * 1. Add the kind name to `VERIFICATION_RULE_KINDS` below.
 * 2. Add an evaluator branch to `evaluateRule`.
 * 3. Bump the docs / shared types if MCP / UI need to surface it.
 * No DB migration required — `verification_rules.kind` is a plain TEXT
 * column and `params` is JSONB.
 */

import type { Task, VerificationRule } from '@prisma/client';
import { prisma } from './prisma';

export const VERIFICATION_RULE_KINDS = [
  'require_files_changed',
  'require_commits_on_branch',
  'require_pr_merged',
  'require_deliverable_evidence_for_each_ref',
  'min_output_summary_chars',
] as const;

export type VerificationRuleKind = (typeof VERIFICATION_RULE_KINDS)[number];

export type VerificationRuleScope = 'project' | 'task_type' | 'task';

/**
 * Input fed to the evaluator. Mirrors the subset of
 * `completeExecutionRunSchema` body fields plus the underlying task row,
 * so the evaluator does not need to re-query Prisma per rule.
 */
export interface VerificationContext {
  task: Pick<Task, 'id' | 'type' | 'prUrl' | 'planDeliverableRefs'>;
  body: {
    outputSummary?: string;
    filesChanged?: string[];
    branchName?: string;
    deliverablesMet?: string[];
  };
}

/**
 * Result of one rule evaluation. `ok=true` means the rule was satisfied
 * (or skipped because its scope did not match — in that case the rule is
 * simply not included in the result list).
 */
export interface RuleEvaluation {
  ruleId: string;
  kind: VerificationRuleKind | string;
  ok: boolean;
  message: string;
}

/**
 * Decide whether a single rule applies to this run based on scope.
 * `scopeValue` is interpreted relative to `scope`:
 *   - project      — always applies.
 *   - task_type    — applies when `task.type === scopeValue`.
 *   - task         — applies when `task.id === scopeValue`.
 *
 * Returning false short-circuits the evaluator so a `min_output_summary_chars`
 * rule scoped to a single research task never inspects body fields produced
 * by an unrelated code task.
 */
function ruleApplies(rule: VerificationRule, task: VerificationContext['task']): boolean {
  switch (rule.scope as VerificationRuleScope) {
    case 'project':
      return true;
    case 'task_type':
      return Boolean(rule.scopeValue) && task.type === rule.scopeValue;
    case 'task':
      return Boolean(rule.scopeValue) && task.id === rule.scopeValue;
    default:
      // Unknown scope — fail closed at the evaluator (not the gate): skip
      // the rule but log so the owner can fix the row. We never want a
      // typo'd scope to silently 422 every run.
      console.warn(
        `[verification-rules] rule ${rule.id} has unknown scope ${rule.scope}; skipping`,
      );
      return false;
  }
}

/**
 * Pure evaluator for one rule. Exported so unit tests can exercise each
 * kind without a DB round-trip.
 */
export function evaluateRule(rule: VerificationRule, ctx: VerificationContext): RuleEvaluation {
  const params = (rule.params ?? {}) as Record<string, unknown>;

  switch (rule.kind as VerificationRuleKind) {
    case 'require_files_changed': {
      // Require at least one non-empty, non-whitespace string so that
      // [""] or [" "] cannot satisfy the gate (#993).
      const ok =
        ctx.body.filesChanged?.some((f) => typeof f === 'string' && f.trim().length > 0) ?? false;
      return {
        ruleId: rule.id,
        kind: rule.kind,
        ok,
        message: ok
          ? 'filesChanged provided'
          : 'require_files_changed: at least one non-empty entry in filesChanged is required',
      };
    }

    case 'require_commits_on_branch': {
      // The complete body carries `branchName` (the branch the agent worked
      // on); we treat its presence as the minimum signal that the agent
      // actually committed somewhere. A stricter "real commits via git
      // hooks" check is R-191/R-192 territory and intentionally out of
      // scope here — this rule keeps the gate cheap and side-effect free.
      const branch = ctx.body.branchName?.trim();
      const ok = Boolean(branch);
      return {
        ruleId: rule.id,
        kind: rule.kind,
        ok,
        message: ok
          ? `branchName=${branch}`
          : 'require_commits_on_branch: branchName must be provided on complete',
      };
    }

    case 'require_pr_merged': {
      // The agent sets `task.prUrl` via PATCH /tasks/:id when it opens
      // the PR; we treat a non-empty value as the minimum signal that a
      // PR exists. A real "merged" check requires the GitHub webhook
      // wiring landed in R-190 and is intentionally out of scope here.
      const prUrl = ctx.task.prUrl?.trim();
      const ok = Boolean(prUrl);
      return {
        ruleId: rule.id,
        kind: rule.kind,
        ok,
        message: ok
          ? `task.prUrl=${prUrl}`
          : 'require_pr_merged: task.prUrl must be set before complete (open a PR and PATCH the task)',
      };
    }

    case 'require_deliverable_evidence_for_each_ref': {
      // Every plan-deliverable ref on the task must appear as a substring
      // of at least one `deliverablesMet` entry. Substring matching keeps
      // the contract permissive — agents commonly write
      // "Deliverable A: implemented foo" which contains "Deliverable A".
      const refs = ctx.task.planDeliverableRefs ?? [];
      const met = ctx.body.deliverablesMet ?? [];
      const missing = refs.filter((ref) => !met.some((entry) => entry.includes(ref)));
      const ok = missing.length === 0;
      return {
        ruleId: rule.id,
        kind: rule.kind,
        ok,
        message: ok
          ? `all ${refs.length} deliverable refs covered`
          : `require_deliverable_evidence_for_each_ref: missing evidence for ${missing.join(', ')}`,
      };
    }

    case 'min_output_summary_chars': {
      const min = typeof params.min === 'number' ? params.min : 0;
      const len = (ctx.body.outputSummary ?? '').length;
      const ok = len >= min;
      return {
        ruleId: rule.id,
        kind: rule.kind,
        ok,
        message: ok
          ? `outputSummary length ${len} ≥ ${min}`
          : `min_output_summary_chars: outputSummary length ${len} < required ${min}`,
      };
    }

    default:
      // Unknown kind in the DB — same fail-closed-but-skip behaviour as
      // unknown scope: log so the owner notices, but never 422 the run
      // on a typo. New kinds should be added to VERIFICATION_RULE_KINDS
      // *and* this switch in the same commit.
      console.warn(`[verification-rules] rule ${rule.id} has unknown kind ${rule.kind}; skipping`);
      return {
        ruleId: rule.id,
        kind: rule.kind,
        ok: true,
        message: `unknown kind ${rule.kind}; skipped`,
      };
  }
}

export interface EvaluateAllResult {
  failed: RuleEvaluation[];
  evaluated: RuleEvaluation[];
}

/**
 * Load every enabled rule for a project, filter by scope, and evaluate.
 * Returns both the per-rule trace (for logging / RunReview) and the
 * subset that failed (the 422 envelope payload).
 */
export async function evaluateProjectVerificationRules(
  projectId: string,
  ctx: VerificationContext,
): Promise<EvaluateAllResult> {
  const rules = await prisma.verificationRule.findMany({
    where: { projectId, enabled: true },
  });
  const evaluated: RuleEvaluation[] = [];
  for (const rule of rules) {
    if (!ruleApplies(rule, ctx.task)) continue;
    evaluated.push(evaluateRule(rule, ctx));
  }
  return { failed: evaluated.filter((e) => !e.ok), evaluated };
}
