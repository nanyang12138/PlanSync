import { aiClient } from './client';
import {
  CONFLICT_PREDICTION_SYSTEM,
  buildConflictPredictionUser,
} from './prompts/conflict-prediction.prompt';
import { logger } from '../logger';
import { z } from 'zod';
import { CONFLICT_PREDICTION_TOOL, conflictPredictionResultZ } from './schemas';
import {
  assertIdsInAllowlist,
  logValidationWarnings,
} from './validate';

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

  // R-186: validate per-item rather than per-response. The legacy contract
  // (test #137) is "keep the valid conflicts, drop the invalid ones in the
  // same payload" — a per-response zod parse would reject the entire list
  // as soon as a single malformed entry sneaks in (which still happens
  // through the text-mode fallback path). We:
  //   1. JSON.parse the response (parse failure → null, legacy contract)
  //   2. Reject the whole thing only if the top-level shape lacks
  //      `conflicts: array`
  //   3. zod-validate each conflict independently; drop failures
  //   4. Run the R-186 allowlist guard on the per-item taskIds
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch (err) {
    logger.error({ err }, 'Failed to parse conflict prediction AI response');
    return null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { conflicts?: unknown }).conflicts)
  ) {
    logger.warn({ parsed }, 'Invalid conflict prediction response structure');
    return { conflicts: [] };
  }

  // Re-derive the per-item schema from the top-level zod so the source of
  // truth stays in schemas/. This keeps R-185 and R-186 consistent — any
  // future field added to the conflict shape is automatically picked up.
  const itemSchema = (
    conflictPredictionResultZ.shape.conflicts as z.ZodArray<z.ZodTypeAny>
  ).element;
  const inputIds = new Set(tasks.map((t) => t.id));
  const cleanedConflicts: ConflictResult['conflicts'] = [];
  const allWarnings: string[] = [];
  for (const raw of (parsed as { conflicts: unknown[] }).conflicts) {
    const itemParse = itemSchema.safeParse(raw);
    if (!itemParse.success) continue;
    const c = itemParse.data as ConflictResult['conflicts'][number];
    const allowResult = assertIdsInAllowlist(c.taskIds, inputIds, 'conflicts[].taskIds');
    allWarnings.push(...allowResult.warnings);
    if (allowResult.kept.length < 2) continue;
    cleanedConflicts.push({
      taskIds: allowResult.kept,
      type: c.type,
      severity: c.severity,
      description: c.description,
      recommendation: c.recommendation,
    });
  }
  logValidationWarnings('conflict_prediction', allWarnings);
  return { conflicts: cleanedConflicts };
}
