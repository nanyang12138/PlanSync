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
 * #2941: compare two git branch identifiers for equality, tolerating the
 * `refs/heads/` prefix on either side. The `pull_request.head.ref` GitHub
 * reports is the short name (`cursor/fix-foo`), while a run's recorded
 * `branchName` may have been stored either way depending on the caller — so
 * we strip the prefix and trim before comparing. Comparison is exact beyond
 * that (branch names are case-sensitive on the git side).
 */
function branchRefsEqual(a: string, b: string): boolean {
  const strip = (s: string) => s.trim().replace(/^refs\/heads\//, '');
  const na = strip(a);
  const nb = strip(b);
  return na.length > 0 && na === nb;
}

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
   * #2925 / #2932 / #2941: the current execution run.
   *
   * `startedAt` scopes webhook evidence to events recorded at or after the run
   * began, so neither a stale branch name pushed before this run
   * (`require_commits_on_branch`) nor a historically-merged PR repointed via
   * the mutable `task.prUrl` (`require_pr_merged`) can satisfy the gate.
   *
   * `branchName` is the branch the run registered AT START (immutable before
   * complete — see `createExecutionRunSchema`). When present it is the
   * `require_pr_merged` ownership anchor: the merged PR's head branch must
   * equal it, not merely be *a* branch that saw a push during the run window.
   * This closes the #2941 race where two concurrent runs share the same time
   * window — the startedAt cutoff alone cannot tell their PRs apart, but each
   * run's recorded branch can. `null`/absent ⇒ no anchor recorded, fall back
   * to the #2939 head-branch-push-in-window binding.
   *
   * Optional: when the whole `run` is absent the evidence is unscoped.
   */
  run?: { startedAt: Date; branchName?: string | null };
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
    /**
     * A merged `pull_request` event matching `task.prUrl` was found AND (when
     * a run is in scope) that PR is bound to the current run. Ownership binding
     * is layered:
     *   - #2939: the PR's head branch received pushed commits at/after
     *     `run.startedAt` (rejects PRs whose work predates the run).
     *   - #2941: when the run recorded its working branch at start
     *     (`run.branchName`), the PR's head branch must additionally *equal*
     *     that branch (rejects a parallel run's / teammate's PR that merged
     *     inside the overlapping window — the window check alone cannot tell
     *     concurrent runs' PRs apart).
     * Together these prevent a mutable `task.prUrl` from being repointed at an
     * unrelated PR to clear the gate.
     */
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
      // `ctx.verified.prMerged`). #2939 / #2941: when a run is in scope that
      // signal also requires the PR to be bound to the current run — its head
      // branch received pushed commits during the run (#2939) AND, when the run
      // recorded a working branch at start, the head branch equals it (#2941) —
      // so a mutable `task.prUrl` repointed at an unrelated or parallel run's
      // merged PR cannot clear the gate. No prUrl, PR not merged, or PR not
      // bound to this run ⇒ fail closed.
      const prUrl = ctx.task.prUrl?.trim();
      const ok = ctx.verified?.prMerged === true;
      return {
        ruleId: rule.id,
        kind: rule.kind,
        ok,
        message: ok
          ? `verified merged PR: ${prUrl}`
          : prUrl
            ? `require_pr_merged: PR ${prUrl} is not merged for this run yet — merge the PR for the branch you pushed in this run (and ensure the GitHub webhook is configured) before completing`
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
    const since = ctx.run?.startedAt;
    // #2932: scope the merged-PR evidence to this run's startedAt so a mutable
    // `task.prUrl` repointed at any historically-merged PR cannot satisfy the
    // gate. `task.prUrl` can be PATCHed right before complete; without the run
    // cutoff an agent could clear `require_pr_merged` by replaying an unrelated
    // already-merged PR from project history (mirrors the #2925 fix for
    // `require_commits_on_branch`).
    //
    // #2939: the startedAt cutoff alone is NOT sufficient — it only proves the
    // merge happened during the run window, not that the PR *belongs* to this
    // run. Because `task.prUrl` is mutable, an agent that did no work could
    // repoint it at ANY unrelated PR that merged after the run began (a
    // parallel run's PR, a teammate's PR) and clear the gate. We therefore also
    // bind PR ownership to the run: the merged PR's own head branch must have
    // received pushed commits at/after the run started. That head-branch push
    // (a GitHub-verified `github_push` to `refs/heads/<head.ref>`) is distinct
    // from the base-branch merge push GitHub emits for every merge, so it only
    // holds for a PR whose work was actually produced by the current run; an
    // unrelated, already-built PR cannot satisfy it merely by being merged.
    //
    // #2941: the head-branch-push-in-window binding above is still not enough
    // when two runs execute CONCURRENTLY. Their startedAt windows overlap, so a
    // parallel run that pushes to and merges its own PR inside this run's window
    // produces a head-branch push that satisfies the #2939 check — letting this
    // run repoint `task.prUrl` at that PR right before complete (a TOCTOU on the
    // mutable field) and clear the gate. The time window cannot tell the two
    // runs' PRs apart; their *branches* can. So when the run recorded its
    // working branch at start (`run.branchName`, immutable before complete) we
    // additionally require the merged PR's head ref to equal that branch. A PR
    // belonging to another run has a different head branch and is rejected,
    // even if it merged inside the window. Runs that did not record a branch
    // fall back to the #2939 window-only binding (no regression).
    const runBranch = ctx.run?.branchName?.trim() || null;
    let prMerged = false;
    if (prUrl) {
      const prInfo = await findPrMergeInfo(prisma, projectId, prUrl, since);
      if (prInfo.merged) {
        if (!since) {
          // Unscoped legacy path (no run window in scope) — preserve prior
          // behaviour. The R-192 `deriveTaskCompletionState` caller binds
          // attribution by commit SHA instead and does not pass a run.
          prMerged = true;
        } else if (!prInfo.headRef) {
          // Merged PR webhook payload omitted head.ref — we can't bind the PR
          // to this run, so fail closed rather than trusting the bare merge.
          prMerged = false;
        } else if (runBranch && !branchRefsEqual(prInfo.headRef, runBranch)) {
          // #2941: this run anchored to a specific branch and the merged PR's
          // head branch is a different one — i.e. the PR belongs to some other
          // run. Reject regardless of the in-window push so a repointed
          // `task.prUrl` cannot borrow a parallel run's merged PR.
          prMerged = false;
        } else {
          // Either the run anchored to this PR's head branch (#2941) or no
          // branch was recorded (#2939 back-compat). In both cases require the
          // GitHub-verified head-branch push during the run window.
          prMerged = await branchHasPushedCommits(prisma, projectId, prInfo.headRef, since);
        }
      }
    }
    verified.prMerged = prMerged;
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
