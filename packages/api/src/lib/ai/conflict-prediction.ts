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
  );
  if (!response) return null;

  try {
    const parsed = JSON.parse(response);
    if (!parsed.conflicts || !Array.isArray(parsed.conflicts)) {
      logger.warn({ parsed }, 'Invalid conflict prediction response structure');
      return { conflicts: [] };
    }
    const validated = parsed.conflicts.filter(
      (c: any) => Array.isArray(c.taskIds) && typeof c.description === 'string',
    );
    return { conflicts: validated };
  } catch (err) {
    logger.error({ err }, 'Failed to parse conflict prediction AI response');
    return null;
  }
}
