import { z } from 'zod';

export const TASK_TYPES = [
  'code',
  'research',
  'design',
  'bug',
  'refactor',
  'test',
  'docs',
] as const;
export const TASK_PRIORITIES = [
  { value: 'p0', label: 'P0 — Critical' },
  { value: 'p1', label: 'P1 — Normal' },
  { value: 'p2', label: 'P2 — Low' },
] as const;

export const taskTypeSchema = z.enum(TASK_TYPES);
export const taskPrioritySchema = z.enum(['p0', 'p1', 'p2']);
// R-192: `awaiting_evidence` is the new terminal-pending status assigned
// when an agent completes a run but the system cannot yet derive `done`
// from git + verification rule signals (PR not merged, no commit linked
// to a bound deliverable, drift unresolved). See `task-state-machine.ts`.
export const taskStatusSchema = z.enum([
  'todo',
  'in_progress',
  'blocked',
  'done',
  'cancelled',
  'awaiting_evidence',
]);
export const assigneeTypeSchema = z.enum(['human', 'agent', 'unassigned']);

const dateRangeRefinement = {
  check: (d: { startDate?: Date | null; dueDate?: Date | null }) =>
    !d.startDate || !d.dueDate || d.startDate <= d.dueDate,
  message: 'startDate must be on or before dueDate',
  path: ['dueDate'] as const,
};

// R-027/R-028: shapes are exported separately so MCP tools (which need a
// ZodRawShape, not a ZodEffects wrapping ZodObject) can import them directly
// and stay in sync with the API contract automatically.
export const createTaskShape = {
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  type: taskTypeSchema,
  priority: taskPrioritySchema.default('p1'),
  assignee: z.string().optional(),
  assigneeType: assigneeTypeSchema.default('unassigned'),
  branchName: z.string().optional(),
  agentContext: z.string().optional(),
  expectedOutput: z.string().optional(),
  agentConstraints: z.array(z.string()).default([]),
  planDeliverableRefs: z.array(z.string()).default([]),
  // Drift v2: which plan constraint / standard items this task depends on.
  // Empty = "depends on all" (conservative). Narrow these to reduce false
  // 'breaking' classifications for unrelated plan edits.
  planConstraintRefs: z.array(z.string()).default([]),
  planStandardRefs: z.array(z.string()).default([]),
  startDate: z.coerce.date().optional(),
  dueDate: z.coerce.date().optional(),
} as const;

export const createTaskSchema = z.object(createTaskShape).refine(dateRangeRefinement.check, {
  message: dateRangeRefinement.message,
  path: [...dateRangeRefinement.path],
});

export const updateTaskShape = {
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  type: taskTypeSchema.optional(),
  priority: taskPrioritySchema.optional(),
  status: taskStatusSchema.optional(),
  assignee: z.string().nullable().optional(),
  assigneeType: assigneeTypeSchema.optional(),
  branchName: z.string().nullable().optional(),
  prUrl: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), 'PR URL must use http(s)')
    .nullable()
    .optional(),
  agentContext: z.string().nullable().optional(),
  expectedOutput: z.string().nullable().optional(),
  agentConstraints: z.array(z.string()).optional(),
  planDeliverableRefs: z.array(z.string()).optional(),
  planConstraintRefs: z.array(z.string()).optional(),
  planStandardRefs: z.array(z.string()).optional(),
  startDate: z.coerce.date().nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
} as const;

export const updateTaskSchema = z.object(updateTaskShape).refine(dateRangeRefinement.check, {
  message: dateRangeRefinement.message,
  path: [...dateRangeRefinement.path],
});

export const claimTaskSchema = z.object({
  assigneeType: assigneeTypeSchema.default('agent'),
  startImmediately: z.boolean().default(true),
});

export const declineTaskSchema = z.object({});

export const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  type: taskTypeSchema,
  priority: taskPrioritySchema,
  status: taskStatusSchema,
  assignee: z.string().nullable(),
  assigneeType: assigneeTypeSchema,
  boundPlanVersion: z.number().int(),
  branchName: z.string().nullable(),
  prUrl: z.string().nullable(),
  agentContext: z.string().nullable(),
  expectedOutput: z.string().nullable(),
  agentConstraints: z.array(z.string()),
  planDeliverableRefs: z.array(z.string()),
  planConstraintRefs: z.array(z.string()),
  planStandardRefs: z.array(z.string()),
  startDate: z.coerce.date().nullable(),
  dueDate: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const executionRunStatusSchema = z.enum([
  'running',
  // R-002: a run becomes 'paused' the moment a new plan activates and the
  // engine identifies it as bound to a version that the new plan supersedes.
  // 'paused' is non-terminal — endedAt stays null — until either the agent
  // ack-pauses with a progress note (→ superseded) or the pause-ack timeout
  // scanner sweeps it (→ superseded with reason='pause_timeout'). The run
  // route hard-rejects heartbeat and complete in this state.
  'paused',
  'completed',
  'failed',
  'cancelled',
  'stale',
  'superseded',
]);

export const createExecutionRunSchema = z.object({
  taskId: z.string().optional(),
  executorType: z.enum(['human', 'agent']),
  executorName: z.string(),
  // #2941: the git branch this run will work on, recorded at start time.
  // Optional for backwards compatibility, but when supplied it becomes the
  // run's immutable ownership anchor: the `require_pr_merged` gate binds the
  // merged PR's head branch to this value so a mutable `task.prUrl` cannot be
  // repointed at a parallel run's / teammate's PR at complete time.
  branchName: z.string().optional(),
});

export const completeExecutionRunSchema = z.object({
  status: z.enum(['completed', 'failed']),
  outputSummary: z.string().optional(),
  filesChanged: z.array(z.string()).default([]),
  branchName: z.string().optional(),
  blockers: z.array(z.string()).default([]),
  driftSignals: z.array(z.string()).default([]),
  deliverablesMet: z.array(z.string()).default([]),
  // PR1 (advisory-review-ingest): an OPTIONAL bag of structured code-review
  // advisories produced by the exec environment (it ran a review lens on the
  // real working-tree diff; the server never sees the diff itself).
  //
  // Deliberately typed `z.unknown()` — NOT the strict `advisoryReviewSchema`
  // below — so a malformed advisory can NEVER turn `validateBody` into a 400
  // that blocks the whole `complete`. The rule for this feature is "always
  // advisory": the route runs `sanitizeAdvisoryReviews` (which drops bad
  // entries + truncates oversized ones, never throws) on this field instead.
  advisoryReviews: z.unknown().optional(),
});

export const executionRunSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  executorType: z.enum(['human', 'agent']),
  executorName: z.string(),
  boundPlanVersion: z.number().int(),
  status: executionRunStatusSchema,
  taskPackSnapshot: z.record(z.unknown()),
  lastHeartbeatAt: z.coerce.date().nullable(),
  outputSummary: z.string().nullable(),
  filesChanged: z.array(z.string()),
  branchName: z.string().nullable(),
  blockers: z.array(z.string()),
  driftSignals: z.array(z.string()),
  deliverablesMet: z.array(z.string()),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date().nullable(),
});

// ---------------------------------------------------------------------------
// Advisory code-review ingest (PR1 of the advisory-review feature)
// ---------------------------------------------------------------------------
//
// PlanSync is NOT a code host. The exec environment (which has the real
// working-tree diff) runs a review lens and submits *structured findings* at
// `complete` time. The server stores them as a `RunReview { kind:
// 'code_review_advisory' }` row and surfaces a summary to the owner — it
// never re-derives them, never sees the diff, and (this is the whole point)
// NEVER lets a review block completion. A review is a sticky note on the
// owner's desk, not a lock on the door; the only hard gates remain R-181
// (declarative rules) and R-192 (deterministic evidence).
//
// The strict schemas below are the producer contract (exec lens / CLI use
// them to shape the payload). The wire field on `completeExecutionRunSchema`
// stays `z.unknown()` so a producer that violates the contract degrades to a
// dropped advisory + warning, not a failed `complete`.

/** Caps that keep a (potentially hostile) exec payload from bloating the DB
 *  or the owner UI. Oversized inputs are TRUNCATED, not rejected. */
export const ADVISORY_REVIEW_CAPS = {
  maxReviewsPerComplete: 10,
  maxFindingsPerReview: 200,
  maxSummaryChars: 4000,
  maxMessageChars: 2000,
  maxSuggestionChars: 4000,
  maxFileChars: 1024,
  maxCategoryChars: 64,
  maxRefChars: 256,
} as const;

export const advisoryReviewSeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type AdvisoryReviewSeverity = z.infer<typeof advisoryReviewSeveritySchema>;

export const advisoryReviewFindingSchema = z.object({
  severity: advisoryReviewSeveritySchema,
  file: z.string().min(1).max(ADVISORY_REVIEW_CAPS.maxFileChars),
  // 0-based or 1-based is the producer's call; we only require non-negative.
  line: z.number().int().nonnegative().optional(),
  message: z.string().min(1).max(ADVISORY_REVIEW_CAPS.maxMessageChars),
  suggestion: z.string().max(ADVISORY_REVIEW_CAPS.maxSuggestionChars).optional(),
  // Self-reported model confidence — display only, NOT calibrated. Clamped to
  // [0,1] by the sanitizer.
  confidence: z.number().min(0).max(1).optional(),
  category: z.string().max(ADVISORY_REVIEW_CAPS.maxCategoryChars).optional(),
});
export type AdvisoryReviewFinding = z.infer<typeof advisoryReviewFindingSchema>;

export const advisoryReviewRefSchema = z.object({
  branchName: z.string().max(ADVISORY_REVIEW_CAPS.maxRefChars).optional(),
  headSha: z.string().max(ADVISORY_REVIEW_CAPS.maxRefChars).optional(),
  baseSha: z.string().max(ADVISORY_REVIEW_CAPS.maxRefChars).optional(),
});
export type AdvisoryReviewRef = z.infer<typeof advisoryReviewRefSchema>;

export const advisoryReviewSchema = z.object({
  kind: z.literal('code_review_advisory'),
  // Where the findings came from. Open string (not enum) so future producers
  // — github_pull_request_review ingest, third-party bots — slot in without a
  // schema bump; defaulted by the sanitizer when absent.
  source: z.string().min(1).max(ADVISORY_REVIEW_CAPS.maxCategoryChars),
  reviewedRef: advisoryReviewRefSchema.optional(),
  summary: z.string().max(ADVISORY_REVIEW_CAPS.maxSummaryChars).optional(),
  findings: z.array(advisoryReviewFindingSchema),
});
export type AdvisoryReview = z.infer<typeof advisoryReviewSchema>;

/** A sanitized review plus the per-review note of whether findings were
 *  dropped to satisfy `maxFindingsPerReview`. */
export interface SanitizedAdvisoryReview extends AdvisoryReview {
  truncated: boolean;
  counts: Record<AdvisoryReviewSeverity, number>;
}

export interface SanitizeAdvisoryReviewsResult {
  reviews: SanitizedAdvisoryReview[];
  warnings: string[];
}

function emptySeverityCounts(): Record<AdvisoryReviewSeverity, number> {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Pure, dependency-free, NEVER-THROWS sanitizer for the `advisoryReviews`
 * wire field. Coerces best-effort, drops what it can't use, truncates what's
 * oversized, and reports everything it did via `warnings`. The contract is
 * that the caller can hand this *anything* (a string, null, a giant array of
 * garbage) and get back a safe, bounded list — so the `complete` path can
 * stay "always advisory".
 */
export function sanitizeAdvisoryReviews(raw: unknown): SanitizeAdvisoryReviewsResult {
  const warnings: string[] = [];
  if (raw === undefined || raw === null) return { reviews: [], warnings };
  if (!Array.isArray(raw)) {
    warnings.push('advisoryReviews was not an array; ignored.');
    return { reviews: [], warnings };
  }

  const input = raw as unknown[];
  let items = input;
  if (input.length > ADVISORY_REVIEW_CAPS.maxReviewsPerComplete) {
    warnings.push(
      `advisoryReviews had ${input.length} entries; kept first ${ADVISORY_REVIEW_CAPS.maxReviewsPerComplete}.`,
    );
    items = input.slice(0, ADVISORY_REVIEW_CAPS.maxReviewsPerComplete);
  }

  const reviews: SanitizedAdvisoryReview[] = [];
  items.forEach((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      warnings.push(`advisoryReviews[${i}] was not an object; dropped.`);
      return;
    }
    const obj = entry as Record<string, unknown>;

    // Pre-coerce the loose bits the strict schema would otherwise reject, so a
    // mostly-good review survives instead of being dropped wholesale.
    const source =
      typeof obj.source === 'string' && obj.source.trim().length > 0
        ? truncate(obj.source, ADVISORY_REVIEW_CAPS.maxCategoryChars)
        : 'exec_agent';

    const rawFindings = Array.isArray(obj.findings) ? (obj.findings as unknown[]) : [];
    if (!Array.isArray(obj.findings)) {
      warnings.push(`advisoryReviews[${i}].findings missing or not an array; treated as empty.`);
    }

    let cappedFindings = rawFindings;
    let truncated = false;
    if (rawFindings.length > ADVISORY_REVIEW_CAPS.maxFindingsPerReview) {
      truncated = true;
      warnings.push(
        `advisoryReviews[${i}] had ${rawFindings.length} findings; kept first ${ADVISORY_REVIEW_CAPS.maxFindingsPerReview}.`,
      );
      cappedFindings = rawFindings.slice(0, ADVISORY_REVIEW_CAPS.maxFindingsPerReview);
    }

    const counts = emptySeverityCounts();
    const findings: AdvisoryReviewFinding[] = [];
    cappedFindings.forEach((f, j) => {
      if (typeof f !== 'object' || f === null) {
        warnings.push(`advisoryReviews[${i}].findings[${j}] was not an object; dropped.`);
        return;
      }
      const ff = f as Record<string, unknown>;
      const candidate = {
        severity: ff.severity,
        file:
          typeof ff.file === 'string'
            ? truncate(ff.file, ADVISORY_REVIEW_CAPS.maxFileChars)
            : ff.file,
        line: ff.line,
        message:
          typeof ff.message === 'string'
            ? truncate(ff.message, ADVISORY_REVIEW_CAPS.maxMessageChars)
            : ff.message,
        suggestion:
          typeof ff.suggestion === 'string'
            ? truncate(ff.suggestion, ADVISORY_REVIEW_CAPS.maxSuggestionChars)
            : ff.suggestion,
        confidence:
          typeof ff.confidence === 'number'
            ? Math.min(1, Math.max(0, ff.confidence))
            : ff.confidence,
        category:
          typeof ff.category === 'string'
            ? truncate(ff.category, ADVISORY_REVIEW_CAPS.maxCategoryChars)
            : ff.category,
      };
      const parsed = advisoryReviewFindingSchema.safeParse(candidate);
      if (!parsed.success) {
        warnings.push(`advisoryReviews[${i}].findings[${j}] invalid; dropped.`);
        return;
      }
      counts[parsed.data.severity] += 1;
      findings.push(parsed.data);
    });

    reviews.push({
      kind: 'code_review_advisory',
      source,
      ...(obj.reviewedRef !== undefined
        ? (() => {
            const refParsed = advisoryReviewRefSchema.safeParse(obj.reviewedRef);
            if (!refParsed.success) {
              warnings.push(`advisoryReviews[${i}].reviewedRef invalid; omitted.`);
              return {};
            }
            return { reviewedRef: refParsed.data };
          })()
        : {}),
      ...(typeof obj.summary === 'string'
        ? { summary: truncate(obj.summary, ADVISORY_REVIEW_CAPS.maxSummaryChars) }
        : {}),
      findings,
      truncated,
      counts,
    });
  });

  return { reviews, warnings };
}
