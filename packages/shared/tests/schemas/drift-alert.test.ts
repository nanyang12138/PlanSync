import { describe, it, expect } from 'vitest';
import { driftAlertSchema } from '../../src/schemas/drift';

const baseAlert = {
  id: 'da_123',
  projectId: 'prj_1',
  taskId: 'tsk_1',
  type: 'version_mismatch',
  severity: 'high',
  reason: 'plan changed',
  status: 'open',
  resolvedAction: null,
  currentPlanVersion: 2,
  taskBoundVersion: 1,
  compatibilityScore: null,
  impactAnalysis: null,
  suggestedAction: null,
  createdAt: '2026-05-20T10:00:00.000Z',
  resolvedAt: null,
  resolvedBy: null,
};

describe('driftAlertSchema — affectedAreas / planDiffId', () => {
  it('keeps affectedAreas and planDiffId when present (R-031)', () => {
    const parsed = driftAlertSchema.parse({
      ...baseAlert,
      affectedAreas: ['deliverable:rest api', 'constraint:use postgres'],
      planDiffId: 'pd_abc',
    });

    expect(parsed.affectedAreas).toEqual([
      'deliverable:rest api',
      'constraint:use postgres',
    ]);
    expect(parsed.planDiffId).toBe('pd_abc');
  });

  it('defaults affectedAreas to [] and planDiffId to null when omitted', () => {
    const parsed = driftAlertSchema.parse(baseAlert);

    expect(parsed.affectedAreas).toEqual([]);
    expect(parsed.planDiffId).toBeNull();
  });

  it('accepts null planDiffId from the API (drift without diff row)', () => {
    const parsed = driftAlertSchema.parse({
      ...baseAlert,
      affectedAreas: [],
      planDiffId: null,
    });

    expect(parsed.planDiffId).toBeNull();
  });

  it('rejects non-array affectedAreas', () => {
    expect(() =>
      driftAlertSchema.parse({
        ...baseAlert,
        affectedAreas: 'deliverable:rest api',
        planDiffId: null,
      }),
    ).toThrow();
  });

  it('rejects non-string entries inside affectedAreas', () => {
    expect(() =>
      driftAlertSchema.parse({
        ...baseAlert,
        affectedAreas: [123],
        planDiffId: null,
      }),
    ).toThrow();
  });
});
