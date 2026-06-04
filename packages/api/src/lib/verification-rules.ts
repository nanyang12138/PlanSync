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
import { findPrMergeInfo, branchHasPushedCommits } from './task-state-machine';

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
  /**
   * #2925: the current execution run. `startedAt` scopes webhook evidence
   * (currently `require_commits_on_branch`) to pushes recorded at or after
   * the run began, so a stale branch name pushed before this run cannot
   * satisfy the gate. Optional: when absent the evidence is unscoped.
   */
  run?: { startedAt: Date };
  /**
   * R-208: webhook-verified signals pre-computed by
   * `evaluateProjectVerificationRules` from the GitHub domain-event outbox.
   * The `require_pr_merged` / `require_commits_on_branch` evaluators consume
   * these instead of re-querying so `evaluateRule` stays a pure, DB-free
   * function unit tests can drive directly. A field is `undefined` when the
   * shell did not need it; the evaluators treat `undefined`/`false` the same
   * way (not verified ⇒ fail closed).
   */
  verified?: {
    /** A merged `pull_request` event matching `task.prUrl` was found. */
    prMerged?: boolean;
    /** A `github_push` with ≥1 commit to `body.branchName` was found. */
    branchHasCommits?: boolean;
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
      // R-208: this used to pass on the mere PRESENCE of `branchName` in the
      // complete body — a lying agent could type any string and clear the
      // gate. We now require webhook-verified evidence: a `github_push` with
      // at least one commit to that branch (pre-computed into
      // `ctx.verified.branchHasCommits` by the async shell). No branch name,
      // or no matching push event ⇒ fail closed.
      const branch = ctx.body.branchName?.trim();
      const ok = ctx.verified?.branchHasCommits === true;
      return {
        ruleId: rule.id,
        kind: rule.kind,
        ok,
        message: ok
          ? `verified pushed commits on branch ${branch}`
          : branch
            ? `require_commits_on_branch: no pushed commits found on branch "${branch}" — push your work (and ensure the GitHub webhook is configured) before completing`
            : 'require_commits_on_branch: branchName must be provided on complete',
      };
    }

    case 'require_pr_merged': {
      // R-208: the rule is named "merged" but used to pass on the mere
      // presence of `task.prUrl` — an open (or imaginary) PR cleared it.
      // We now require webhook-verified evidence that the PR is actually
      // MERGED (a `pull_request` event with action=closed, merged=true,
      // matching the task's prUrl — pre-computed into
      // `ctx.verified.prMerged`). No prUrl, or PR not merged ⇒ fail closed.
      const prUrl = ctx.task.prUrl?.trim();
      const ok = ctx.verified?.prMerged === true;
      return {
        ruleId: rule.id,
        kind: rule.kind,
        ok,
        message: ok
          ? `verified merged PR: ${prUrl}`
          : prUrl
            ? `require_pr_merged: PR ${prUrl} is not merged yet — merge it (and ensure the GitHub webhook is configured) before completing`
            : 'require_pr_merged: task.prUrl must be set and the PR merged before complete (open a PR, PATCH the task, then merge)',
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
  const applicable = rules.filter((rule) => ruleApplies(rule, ctx.task));

  // R-208: pre-compute webhook-verified signals ONCE for the rules that need
  // them, then hand an enriched context to the pure evaluator. We only query
  // when an applicable rule actually consumes the signal so projects without
  // these rules pay no extra round-trips.
  const verified: NonNullable<VerificationContext['verified']> = {};
  if (applicable.some((r) => r.kind === 'require_pr_merged')) {
    const prUrl = ctx.task.prUrl?.trim();
    verified.prMerged = prUrl ? (await findPrMergeInfo(prisma, projectId, prUrl)).merged : false;
  }
  if (applicable.some((r) => r.kind === 'require_commits_on_branch')) {
    const branch = ctx.body.branchName?.trim();
    // #2925: scope to pushes recorded at/after the run started so a branch
    // name reused from before this run cannot satisfy the gate.
    verified.branchHasCommits = branch
      ? await branchHasPushedCommits(prisma, projectId, branch, ctx.run?.startedAt)
      : false;
  }
  const enrichedCtx: VerificationContext = { ...ctx, verified };

  const evaluated: RuleEvaluation[] = applicable.map((rule) => evaluateRule(rule, enrichedCtx));
  return { failed: evaluated.filter((e) => !e.ok), evaluated };
}
