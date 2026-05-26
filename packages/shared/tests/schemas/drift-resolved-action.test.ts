import { describe, it, expect } from 'vitest';
import {
  driftAlertSchema,
  driftResolveActionSchema,
  driftResolvedActionSchema,
  resolveDriftSchema,
} from '../../src/schemas/drift';

// Closes #709 — the persisted `resolved_action` column accepts four
// values (`rebind | cancel | no_impact | superseded`), but the
// user-facing PATCH only accepts the first three. Pre-fix, both
// sides shared one zod enum that omitted `superseded`, so any
// client / test that re-parsed a drift row written by the engine
// (via `persistDriftAlerts` retiring an older alert) would crash on
// the schema check. Split the schemas: tight enum on the write path,
// permissive enum on the read path.

const baseAlert = {
  id: 'da_123',
  projectId: 'prj_1',
  taskId: 'tsk_1',
  type: 'version_mismatch',
  severity: 'high',
  reason: 'plan changed',
  status: 'resolved',
  currentPlanVersion: 2,
  taskBoundVersion: 1,
  compatibilityScore: null,
  impactAnalysis: null,
  suggestedAction: null,
  createdAt: '2026-05-20T10:00:00.000Z',
  resolvedAt: '2026-05-20T11:00:00.000Z',
  resolvedBy: 'system',
} as const;

describe('drift resolve action schemas (closes #709)', () => {
  it('driftResolvedActionSchema accepts all four persisted values', () => {
    expect(driftResolvedActionSchema.parse('rebind')).toBe('rebind');
    expect(driftResolvedActionSchema.parse('cancel')).toBe('cancel');
    expect(driftResolvedActionSchema.parse('no_impact')).toBe('no_impact');
    expect(driftResolvedActionSchema.parse('superseded')).toBe('superseded');
  });

  it('driftResolveActionSchema (user-facing PATCH) does NOT accept superseded', () => {
    expect(() => driftResolveActionSchema.parse('superseded')).toThrow();
    expect(() => resolveDriftSchema.parse({ action: 'superseded' })).toThrow();
  });

  it('driftResolveActionSchema still accepts the three legitimate operator answers', () => {
    expect(resolveDriftSchema.parse({ action: 'rebind' }).action).toBe('rebind');
    expect(resolveDriftSchema.parse({ action: 'cancel' }).action).toBe('cancel');
    expect(resolveDriftSchema.parse({ action: 'no_impact' }).action).toBe('no_impact');
  });

  it('driftAlertSchema parses a row with resolvedAction=superseded', () => {
    const parsed = driftAlertSchema.parse({
      ...baseAlert,
      resolvedAction: 'superseded',
    });
    expect(parsed.resolvedAction).toBe('superseded');
    expect(parsed.resolvedBy).toBe('system');
  });

  it('driftAlertSchema still parses a row with resolvedAction=null (open alert)', () => {
    const parsed = driftAlertSchema.parse({
      ...baseAlert,
      status: 'open',
      resolvedAt: null,
      resolvedBy: null,
      resolvedAction: null,
    });
    expect(parsed.resolvedAction).toBeNull();
  });

  it('driftAlertSchema rejects a bogus resolvedAction value (defense in depth)', () => {
    expect(() =>
      driftAlertSchema.parse({
        ...baseAlert,
        resolvedAction: 'not-a-real-action',
      }),
    ).toThrow();
  });
});
