import { aiClient } from './client';
import {
  CONFLICT_PREDICTION_SYSTEM,
  buildConflictPredictionUser,
} from './prompts/conflict-prediction.prompt';
import { logger } from '../logger';
import { CONFLICT_PREDICTION_TOOL } from './schemas';

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

  // R-185: tool_use strict mode hard-fails on conflicts.taskIds < 2 at the
  // decoding layer (jsonSchema minItems: 2), removing the most common
  // historical hallucination ("conflict between one task"). The manual
  // checks below still run as defense-in-depth for the text-mode fallback
  // path and for non-tool-use providers.
  const response = await aiClient.complete(
    CONFLICT_PREDICTION_SYSTEM,
    buildConflictPredictionUser(tasks),
    { purpose: 'conflict_prediction', tool: CONFLICT_PREDICTION_TOOL },
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
        // #199/#216/#223: a "conflict" with fewer than 2 task ids is
        // semantically nonsense (you cannot have a conflict between zero
        // or one task). The original predicate accepted [] and [single]
        // because every() returns true vacuously, which let the UI
        // render conflict badges that pointed at a single (or no) task.
        if (obj.taskIds.length < 2) return false;
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
