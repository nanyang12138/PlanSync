import { aiClient } from './client';
import {
  CONFLICT_PREDICTION_SYSTEM,
  buildConflictPredictionUser,
} from './prompts/conflict-prediction.prompt';
import { logger } from '../logger';

export interface ConflictResult {
  conflicts: Array<{
    taskIds: string[];
    type: string;
    severity: string;
    description: string;
    recommendation: string;
  }>;
}

export async function predictConflicts(
  tasks: Array<{
    id: string;
    title: string;
    description?: string | null;
    status: string;
    assignee?: string | null;
  }>,
): Promise<ConflictResult | null> {
  if (!aiClient.isAvailable) return null;
  if (tasks.length < 2) return { conflicts: [] };

  const response = await aiClient.complete(
    CONFLICT_PREDICTION_SYSTEM,
    buildConflictPredictionUser(tasks),
    { purpose: 'conflict_prediction' },
  );
  if (!response) return null;

  try {
    const parsed = JSON.parse(response);
    if (!parsed.conflicts || !Array.isArray(parsed.conflicts)) {
      logger.warn({ parsed }, 'Invalid conflict prediction response structure');
      return { conflicts: [] };
    }
    const validated = (parsed.conflicts as unknown[]).filter(
      (c): c is ConflictResult['conflicts'][number] => {
        if (typeof c !== 'object' || c === null) return false;
        const obj = c as Record<string, unknown>;
        // ConflictResult['conflicts'][number] has 5 required string-typed
        // fields (taskIds is string[]). Validating only taskIds + description
        // (the previous predicate) silently passed objects with undefined
        // type/severity/recommendation, which downstream UI rendered as
        // 'undefined' strings and caused noisy alerts.
        if (!Array.isArray(obj.taskIds)) return false;
        if (!obj.taskIds.every((t) => typeof t === 'string' && t.length > 0)) return false;
        if (typeof obj.type !== 'string' || obj.type.length === 0) return false;
        if (typeof obj.severity !== 'string' || obj.severity.length === 0) return false;
        if (typeof obj.description !== 'string' || obj.description.length === 0) return false;
        if (typeof obj.recommendation !== 'string' || obj.recommendation.length === 0) return false;
        return true;
      },
    );
    return { conflicts: validated };
  } catch (err) {
    logger.error({ err }, 'Failed to parse conflict prediction AI response');
    return null;
  }
}
