import { aiClient } from './client';
import { IMPACT_ANALYSIS_SYSTEM, buildImpactAnalysisUser } from './prompts/impact-analysis.prompt';
import { logger } from '../logger';
import type { PlanDiffResult } from './plan-diff';

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

  const response = await aiClient.complete(
    IMPACT_ANALYSIS_SYSTEM,
    buildImpactAnalysisUser(diff, task),
  );
  if (!response) return null;

  try {
    const parsed = JSON.parse(response);
    const validActions = ['no_impact', 'rebind', 'cancel'];
    if (
      typeof parsed.compatibilityScore !== 'number' ||
      typeof parsed.suggestedAction !== 'string' ||
      !Array.isArray(parsed.affectedAreas)
    ) {
      logger.warn({ parsed }, 'Invalid impact analysis response structure');
      return null;
    }
    if (!validActions.includes(parsed.suggestedAction)) {
      parsed.suggestedAction =
        parsed.compatibilityScore > 70
          ? 'no_impact'
          : parsed.compatibilityScore > 30
            ? 'rebind'
            : 'cancel';
    }
    return parsed as ImpactResult;
  } catch (err) {
    logger.error({ err }, 'Failed to parse impact analysis AI response');
    return null;
  }
}
