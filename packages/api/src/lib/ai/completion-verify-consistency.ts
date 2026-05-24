// R-189: completion-verify boundary-score self-consistency sampling.
//
// Motivation. R-180 turned the completion-verify gate from a hard 422
// into an advisory. The remaining UX pain is the 60-80 boundary zone:
// the model returns 72 once and the agent has no way to tell whether
// 72 is "you genuinely missed two things" or "the model would have
// said 80 if you asked again." Industry guidance (Maxim AI / Datadog
// production monitoring) recommends self-consistency sampling for
// exactly this case — generate N samples and look at the spread.
//
// Strategy.
//   * Only trigger on score in [60, 80] (the zone where extra samples
//     are most informative; clearly-passing and clearly-failing scores
//     don't justify the extra cost).
//   * Run N=2 additional samples (3 total counting the original).
//   * Take the median of the 3 scores.
//   * If max-min > 15 → mark `lowConfidence: true` and rewrite the
//     feedback to surface the spread; otherwise quietly use the median.
//   * Each follow-up sample is recorded under purpose
//     `completion_verify_consistency` so the R-182 dashboard can track
//     trigger rate + cost.
//
// Safety: never throws. Errors during sampling fall through with the
// original result intact — self-consistency is enhancement, not a
// blocker.

import type { Prisma } from '@prisma/client';
import { aiClient } from './client';
import { COMPLETION_VERIFY_TOOL, completionVerifyResultZ } from './schemas';
import { COMPLETION_VERIFY_PROMPT_VERSION } from './prompts/completion-verify.prompt';
import { logger } from '../logger';

const LOWER_BOUNDARY = 60;
const UPPER_BOUNDARY = 80;
const SPREAD_LOW_CONFIDENCE = 15;
const EXTRA_SAMPLES = 2;

export interface CompletionVerifyResult {
  verified: boolean;
  score: number;
  breakdown?: { specificity: number; coherence: number; coverage: number };
  gaps: string[];
  feedback: string;
}

export interface ConsistencyOutcome {
  /** The (possibly median-corrected) result the caller should persist. */
  result: CompletionVerifyResult;
  /** True when the spread was wide enough to flag the run for owner review. */
  lowConfidence: boolean;
  /** Per-sample score history (length 1 when no sampling ran, 3 when it did). */
  scores: number[];
  /** Optional metadata bag the caller can merge into RunReview.metadata. */
  metadataPatch: Prisma.JsonObject;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Decide whether the initial result needs extra sampling; if so, run
 * the extra calls and return the corrected result + metadata. Caller
 * uses the result for ExecutionRun.aiVerify* and the metadataPatch +
 * lowConfidence for the RunReview row.
 *
 * `system` and `user` are the EXACT strings used for the first call so
 * the extra samples are apples-to-apples. Provider-side caching (R-183)
 * means each extra call still hits the model — the cache key includes
 * the tool schema, so swapping nothing produces deterministic cache
 * hits which would defeat the self-consistency check; we therefore
 * salt the user message with a one-line "Sample N of 3" prefix that
 * affects neither the verdict logic nor the tool schema, but DOES
 * invalidate the cache.
 */
export async function applyCompletionVerifyConsistency(
  initial: CompletionVerifyResult,
  system: string,
  user: string,
): Promise<ConsistencyOutcome> {
  // Outside the boundary zone — nothing to do.
  if (initial.score < LOWER_BOUNDARY || initial.score > UPPER_BOUNDARY) {
    return {
      result: initial,
      lowConfidence: false,
      scores: [initial.score],
      metadataPatch: {},
    };
  }

  const scores: number[] = [initial.score];
  const feedbacks: string[] = [initial.feedback];
  for (let i = 1; i <= EXTRA_SAMPLES; i++) {
    try {
      const saltedUser = `Sample ${i + 1} of ${EXTRA_SAMPLES + 1} — answer independently of any earlier judgement.\n\n${user}`;
      const raw = await aiClient.complete(system, saltedUser, {
        purpose: 'completion_verify_consistency',
        // R-190a contract: every aiClient.complete call must carry the
        // prompt version of the system text being sent. We reuse the
        // base completion-verify prompt verbatim, so we tag with the
        // same version (R-185 will further suffix `-toolv1`).
        promptVersion: COMPLETION_VERIFY_PROMPT_VERSION,
        tool: COMPLETION_VERIFY_TOOL,
      });
      if (!raw) continue;
      // Issues #830 / #826: previously this branch only checked
      // `typeof parsed.score === 'number'`, so a model returning
      // `{ score: 150 }` or `{ score: -5 }` or missing required
      // fields would slip through and pollute the median + feedback.
      // Full zod validation gives us the 0..100 bound + the integer
      // requirement + the verified/gaps/feedback shape for free.
      const parsedUnknown: unknown = JSON.parse(raw);
      const safe = completionVerifyResultZ.safeParse(parsedUnknown);
      if (!safe.success) {
        logger.warn(
          {
            attempt: i + 1,
            issues: safe.error.issues
              .slice(0, 3)
              .map((iss) => `${iss.path.join('.') || '<root>'}:${iss.message}`),
          },
          'completion_verify_consistency_sample_invalid_shape — dropping',
        );
        continue;
      }
      scores.push(safe.data.score);
      feedbacks.push(safe.data.feedback);
    } catch (err) {
      logger.warn(
        { err, attempt: i + 1 },
        'completion_verify_consistency_sample_failed — using available samples',
      );
      // continue with whatever samples we have
    }
  }

  if (scores.length < 2) {
    // Could not gather any extra samples — degrade to original.
    return {
      result: initial,
      lowConfidence: false,
      scores,
      metadataPatch: { consistencySampleFailed: true },
    };
  }

  const med = Math.round(median(scores));
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  const spread = max - min;
  const lowConfidence = spread > SPREAD_LOW_CONFIDENCE;

  // Issue #829: the median can cross the 75 boundary in either
  // direction (e.g. initial verified=true at 76, median drops to 72,
  // so verified must flip to false; or initial verified=false at 70,
  // median rises to 78). Without this re-derivation the RunReview row
  // would show "score 78, verified=false" which the owner UI renders
  // as a contradiction. The PASS_THRESHOLD must match completion-verify
  // prompt: "Threshold: score >= 75 passes."
  const PASS_THRESHOLD = 75;
  const correctedResult: CompletionVerifyResult = {
    ...initial,
    score: med,
    verified: med >= PASS_THRESHOLD,
    feedback: lowConfidence
      ? `AI verification is unstable across ${scores.length} samples (${scores.join(' / ')}) — recommend human review. Original feedback: ${initial.feedback}`
      : initial.feedback,
  };
  return {
    result: correctedResult,
    lowConfidence,
    scores,
    metadataPatch: {
      consistencyScores: scores,
      consistencyMedian: med,
      consistencySpread: spread,
      consistencyLowConfidence: lowConfidence,
    },
  };
}

// Internal exports so tests can pin the boundary constants.
export const _R189_BOUNDARIES = {
  LOWER_BOUNDARY,
  UPPER_BOUNDARY,
  SPREAD_LOW_CONFIDENCE,
  EXTRA_SAMPLES,
} as const;
