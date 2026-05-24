import { aiClient } from './client';
import {
  IMPACT_ANALYSIS_PROMPT_VERSION,
  IMPACT_ANALYSIS_SYSTEM,
  buildImpactAnalysisUser,
} from './prompts/impact-analysis.prompt';
import { logger } from '../logger';
import type { PlanDiffResult } from './plan-diff';
import { IMPACT_ANALYSIS_TOOL, impactAnalysisResultZ } from './schemas';
import { verifyImpactCancel } from './verifier';
import { escalateLowConfidence } from '../ai-escalation';

export interface ImpactResult {
  compatibilityScore: number;
  compatible: boolean;
  suggestedAction: 'no_impact' | 'rebind' | 'cancel';
  reasoning: string;
  affectedAreas: string[];
  riskLevel: string;
}

export async function analyzeTaskImpact(
  diff: PlanDiffResult,
  task: {
    title: string;
    description?: string | null;
    type?: string | null;
    status: string;
    boundPlanVersion: number;
  },
  // R-191a: caller may pass projectId so we can escalate low-confidence
  // signals to the owner. Optional for backward-compat with tests; when
  // omitted we skip the escalation path entirely (the analysis still
  // runs and returns the same shape).
  projectId?: string,
  taskId?: string,
): Promise<ImpactResult | null> {
  if (!aiClient.isAvailable) return null;

  // R-185: strict tool_use forces the model into a fixed-shape payload at
  // the decoding layer; we still run zod.safeParse below as a Layer-1
  // defense for two reasons: (a) the mock provider doesn't honour tool_use,
  // (b) an AMD deployment that silently ignores `tools` falls back to text
  // mode, and we must reject malformed text the same way the old code did.
  const response = await aiClient.complete(
    IMPACT_ANALYSIS_SYSTEM,
    buildImpactAnalysisUser(diff, task),
    {
      purpose: 'drift_impact',
      promptVersion: IMPACT_ANALYSIS_PROMPT_VERSION,
      tool: IMPACT_ANALYSIS_TOOL,
    },
  );
  if (!response) {
    // R-191a: a null response on the impact-analysis path means we have
    // no AI signal at all for a drift that COULD have been "no_impact"
    // or could have been "cancel" — the owner should know.
    if (projectId) {
      void escalateLowConfidence(projectId, 'impact_returned_null', {
        summary: `AI impact analysis returned no result for task "${task.title}". The drift alert will remain open without an AI recommendation; please review manually.`,
        taskId,
      });
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch (err) {
    logger.error({ err }, 'Failed to parse impact analysis AI response');
    return null;
  }

  // R-187 helper: after we've materialised a clean ImpactResult, run the
  // cancel-verifier only when the candidate recommends `cancel` (the
  // destructive branch). reject/partial verdict → downgrade to `rebind`
  // and append the verifier reasoning to affectedAreas so the owner has a
  // visible trail of "the AI wanted to cancel, but the verifier disagreed".
  // R-191a: if the AI is very confident this task is incompatible
  // (score < 30), notify the owner. The candidate stays returned so
  // downstream code keeps working; escalation is purely additive.
  async function maybeEscalateVeryLowScore(candidate: ImpactResult): Promise<void> {
    if (!projectId) return;
    if (candidate.compatibilityScore >= 30) return;
    void escalateLowConfidence(projectId, 'impact_score_very_low', {
      summary: `AI impact analysis scored task "${task.title}" at ${candidate.compatibilityScore}/100 against the active plan. Suggested action: ${candidate.suggestedAction}.`,
      taskId,
      details: {
        compatibilityScore: candidate.compatibilityScore,
        riskLevel: candidate.riskLevel,
        reasoning: candidate.reasoning,
      },
    });
  }

  async function maybeDowngradeCancel(candidate: ImpactResult): Promise<ImpactResult> {
    if (candidate.suggestedAction !== 'cancel') return candidate;
    const verdict = await verifyImpactCancel({
      diff,
      task,
      candidate,
    });
    if (!verdict || verdict.verdict === 'agree') return candidate;
    logger.warn(
      {
        taskTitle: task.title,
        boundPlanVersion: task.boundPlanVersion,
        verifierVerdict: verdict.verdict,
        verifierReasoning: verdict.reasoning,
      },
      'impact_cancel_downgraded_by_verifier',
    );
    return {
      ...candidate,
      suggestedAction: 'rebind',
      affectedAreas: [
        ...candidate.affectedAreas,
        `[verifier:${verdict.verdict}] downgraded from cancel — ${verdict.reasoning}`,
      ],
    };
  }

  const safe = impactAnalysisResultZ.safeParse(parsed);
  if (!safe.success) {
    // The legacy code applied a "score-recovery" rule when only
    // suggestedAction was bad. Keep that behaviour for the suggestedAction
    // case so a borderline-malformed text-mode response still surfaces a
    // useful verdict; for everything else, fail closed.
    if (
      typeof (parsed as Record<string, unknown>)?.compatibilityScore === 'number' &&
      Array.isArray((parsed as Record<string, unknown>)?.affectedAreas) &&
      typeof (parsed as Record<string, unknown>)?.reasoning === 'string'
    ) {
      const p = parsed as Record<string, unknown>;
      const score = p.compatibilityScore as number;
      const recovered: ImpactResult = {
        compatibilityScore: score,
        compatible: typeof p.compatible === 'boolean' ? p.compatible : score > 70,
        suggestedAction: score > 70 ? 'no_impact' : score > 30 ? 'rebind' : 'cancel',
        reasoning: p.reasoning as string,
        affectedAreas: (p.affectedAreas as unknown[]).filter(
          (x): x is string => typeof x === 'string',
        ),
        riskLevel:
          typeof p.riskLevel === 'string' && ['high', 'medium', 'low'].includes(p.riskLevel)
            ? (p.riskLevel as string)
            : score > 70
              ? 'low'
              : score > 30
                ? 'medium'
                : 'high',
      };
      logger.warn({ issues: safe.error.flatten() }, 'Impact analysis schema mismatch — recovered');
      await maybeEscalateVeryLowScore(recovered);
      return maybeDowngradeCancel(recovered);
    }
    logger.warn(
      { issues: safe.error.flatten(), parsed },
      'Invalid impact analysis response structure',
    );
    return null;
  }
  await maybeEscalateVeryLowScore(safe.data);
  return maybeDowngradeCancel(safe.data);
}
