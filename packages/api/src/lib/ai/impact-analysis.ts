import { aiClient } from './client';
import { IMPACT_ANALYSIS_SYSTEM, buildImpactAnalysisUser } from './prompts/impact-analysis.prompt';
import { logger } from '../logger';
import type { PlanDiffResult } from './plan-diff';
import { IMPACT_ANALYSIS_TOOL, impactAnalysisResultZ } from './schemas';

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
    { purpose: 'drift_impact', tool: IMPACT_ANALYSIS_TOOL },
  );
  if (!response) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch (err) {
    logger.error({ err }, 'Failed to parse impact analysis AI response');
    return null;
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
        affectedAreas: (p.affectedAreas as unknown[]).filter((x): x is string => typeof x === 'string'),
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
      return recovered;
    }
    logger.warn(
      { issues: safe.error.flatten(), parsed },
      'Invalid impact analysis response structure',
    );
    return null;
  }
  return safe.data;
}
