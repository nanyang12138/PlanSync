// R-033: createActivity must reject unknown type / actorType values via zod.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { createTestProject, cleanupProject, testPrisma } from '../helpers/request';

describe('R-033: createActivity zod validation', () => {
  const owner = 'r033-owner';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('rejects an unknown activity type with INTERNAL error', async () => {
    await expect(
      createActivity({
        projectId,
        // Deliberate typo — must be caught by zod before reaching the DB.
        type: 'task_complted' as never,
        actorName: owner,
        actorType: 'human',
        summary: 'should never persist',
      }),
    ).rejects.toThrow(AppError);

    // No row should have leaked into the DB.
    const leaked = await testPrisma.activity.findFirst({
      where: { projectId, type: 'task_complted' as never },
    });
    expect(leaked).toBeNull();
  });

  it('rejects an unknown actorType with INTERNAL error', async () => {
    try {
      await createActivity({
        projectId,
        type: 'plan_created',
        actorName: owner,
        actorType: 'robotic' as never,
        summary: 'should never persist',
      });
      throw new Error('createActivity should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(ErrorCode.INTERNAL);
    }
  });

  it('accepts every type currently used by route handlers (no false-positive break)', async () => {
    const typesInUse = [
      'project_created',
      'plan_created',
      'plan_proposed',
      'plan_activated',
      'plan_reactivated',
      'plan_draft_updated',
      'review_approved',
      'review_rejected',
      'suggestion_created',
      'suggestion_accepted',
      'suggestion_rejected',
      'task_created',
      'task_claimed',
      'task_declined',
      'task_completed',
      'task_rebound',
      'comment_added',
      'drift_detected',
      'drift_resolved',
      'member_added',
      'member_removed',
      'execution_started',
      'execution_superseded',
    ] as const;

    for (const t of typesInUse) {
      await createActivity({
        projectId,
        type: t,
        actorName: owner,
        actorType: 'system',
        summary: `regression check for ${t}`,
      });
    }

    const persisted = await testPrisma.activity.count({
      where: { projectId, actorType: 'system' },
    });
    expect(persisted).toBeGreaterThanOrEqual(typesInUse.length);
  });
});
