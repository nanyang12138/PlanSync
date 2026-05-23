// R-110: project PATCH 写 activity
//
// The PATCH /projects/:projectId endpoint is the canonical owner-driven
// project-edit surface (rename, repo url change, phase transition, etc.).
// Before R-110 it returned the updated row but skipped the audit log, so
// audit consumers could not tell who changed which field on a project or
// when a project moved between planning/active/completed. This test
// asserts that:
//   1. editing a project field writes an `activity` row with
//      type=project_updated;
//   2. the activity captures the changed fields and the editor's name;
//   3. phase transitions additionally record phaseFrom/phaseTo metadata.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PATCH as projectPATCH } from '@/app/api/projects/[projectId]/route';
import { makeReq, createTestProject, cleanupProject, testPrisma } from '../helpers/request';

describe('R-110: project PATCH writes activity', () => {
  const owner = 'r110-owner';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('PATCH project description → activity row type=project_updated with fields metadata', async () => {
    const before = await testPrisma.activity.count({
      where: { projectId, type: 'project_updated' },
    });

    const res = await projectPATCH(
      makeReq(`/api/projects/${projectId}`, {
        method: 'PATCH',
        userName: owner,
        body: { description: 'r110 updated description' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(200);

    const after = await testPrisma.activity.findMany({
      where: { projectId, type: 'project_updated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(after.length).toBe(before + 1);

    const activity = after[0];
    expect(activity.actorName).toBe(owner);
    expect(activity.actorType).toBe('human');
    expect(activity.summary).toContain('updated');

    const md = activity.metadata as {
      fields?: string[];
      phaseFrom?: string;
      phaseTo?: string;
    } | null;
    expect(md?.fields).toEqual(['description']);
    // No phase change in this edit.
    expect(md?.phaseFrom).toBeUndefined();
    expect(md?.phaseTo).toBeUndefined();
  });

  it('PATCH project phase → activity records phaseFrom/phaseTo', async () => {
    const before = await testPrisma.activity.count({
      where: { projectId, type: 'project_updated' },
    });

    const res = await projectPATCH(
      makeReq(`/api/projects/${projectId}`, {
        method: 'PATCH',
        userName: owner,
        body: { phase: 'active' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.phase).toBe('active');

    const after = await testPrisma.activity.findMany({
      where: { projectId, type: 'project_updated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(after.length).toBe(before + 1);

    const activity = after[0];
    const md = activity.metadata as {
      fields?: string[];
      phaseFrom?: string;
      phaseTo?: string;
    } | null;
    expect(md?.fields).toEqual(['phase']);
    expect(md?.phaseFrom).toBe('planning');
    expect(md?.phaseTo).toBe('active');
  });
});
