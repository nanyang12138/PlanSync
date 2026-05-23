// R-125: activity.ts unit-test coverage — exercises the createActivity
// happy paths, metadata round-trip, every supported actorType, and the
// shape of the AppError thrown on invalid input. R-033 already covered
// the basic "reject unknown type" path; this file fills the gaps so the
// activity.ts module is no longer audit-only via integration suites.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { createTestProject, cleanupProject, testPrisma } from '../helpers/request';

describe('R-125: createActivity coverage', () => {
  const owner = 'r125-owner';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('persists a valid activity row and returns the created record', async () => {
    const row = await createActivity({
      projectId,
      type: 'project_created',
      actorName: owner,
      actorType: 'human',
      summary: 'project bootstrap',
    });

    expect(row.id).toMatch(/[0-9a-z]/i);
    expect(row.projectId).toBe(projectId);
    expect(row.type).toBe('project_created');
    expect(row.actorName).toBe(owner);
    expect(row.actorType).toBe('human');
    expect(row.summary).toBe('project bootstrap');
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.metadata).toBeNull();

    const fromDb = await testPrisma.activity.findUnique({ where: { id: row.id } });
    expect(fromDb).not.toBeNull();
    expect(fromDb?.summary).toBe('project bootstrap');
  });

  it('round-trips structured metadata through Prisma JSON column', async () => {
    const metadata = {
      planVersion: 3,
      reviewers: ['alice', 'bob'],
      breaking: true,
      nested: { reason: 'scope expansion' },
    };

    const row = await createActivity({
      projectId,
      type: 'plan_activated',
      actorName: owner,
      actorType: 'human',
      summary: 'activated plan v3',
      metadata,
    });

    const fromDb = await testPrisma.activity.findUnique({ where: { id: row.id } });
    expect(fromDb?.metadata).toEqual(metadata);
  });

  it.each(['human', 'agent', 'system'] as const)('accepts actorType=%s', async (actorType) => {
    const row = await createActivity({
      projectId,
      type: 'comment_added',
      actorName: `${actorType}-actor`,
      actorType,
      summary: `note from ${actorType}`,
    });
    expect(row.actorType).toBe(actorType);
  });

  it('throws AppError(INTERNAL) carrying invalidType context on bad type', async () => {
    try {
      await createActivity({
        projectId,
        type: 'totally_made_up_type' as never,
        actorName: owner,
        actorType: 'system',
        summary: 'should not persist',
      });
      throw new Error('createActivity should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.code).toBe(ErrorCode.INTERNAL);
      expect(appErr.message).toContain('totally_made_up_type');
      expect(appErr.details).toMatchObject({ invalidType: 'totally_made_up_type' });
    }

    const leaked = await testPrisma.activity.findFirst({
      where: { projectId, type: 'totally_made_up_type' as never },
    });
    expect(leaked).toBeNull();
  });

  it('throws AppError(INTERNAL) carrying invalidActorType context on bad actorType', async () => {
    try {
      await createActivity({
        projectId,
        type: 'task_created',
        actorName: owner,
        actorType: 'martian' as never,
        summary: 'should not persist either',
      });
      throw new Error('createActivity should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.code).toBe(ErrorCode.INTERNAL);
      expect(appErr.message).toContain('martian');
      expect(appErr.details).toMatchObject({ invalidActorType: 'martian' });
    }

    const leaked = await testPrisma.activity.findFirst({
      where: { projectId, actorName: owner, actorType: 'martian' as never },
    });
    expect(leaked).toBeNull();
  });

  it('rejects case-mismatched activity type (zod enum is case-sensitive)', async () => {
    // Guards against "looks-right-but-isnt" typos like Plan_Created — the
    // zod schema enumerates lowercase values only.
    await expect(
      createActivity({
        projectId,
        type: 'Plan_Created' as never,
        actorName: owner,
        actorType: 'system',
        summary: 'capitalization typo',
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('validates type before actorType (type error wins when both are bad)', async () => {
    // Documents current ordering so future refactors notice if precedence
    // changes — callers in route handlers rely on the type message format
    // when surfacing "add it to activityTypeSchema" hints.
    try {
      await createActivity({
        projectId,
        type: 'no_such_type' as never,
        actorName: owner,
        actorType: 'not_an_actor' as never,
        summary: 'both bad',
      });
      throw new Error('createActivity should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).details).toMatchObject({ invalidType: 'no_such_type' });
      expect((err as AppError).details).not.toHaveProperty('invalidActorType');
    }
  });
});
