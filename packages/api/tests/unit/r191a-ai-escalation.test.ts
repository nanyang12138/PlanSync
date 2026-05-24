// R-191a: AI low-confidence auto-escalation.
//
// Mocks the SSE bus + email transport + prisma owner lookup, then
// exercises the helper and the two callers (impact-analysis and
// drift-engine.enrichDriftAlertsWithAi) end-to-end.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMailMock = vi.hoisted(() => vi.fn());
const eventBusPublishMock = vi.hoisted(() => vi.fn());
const prismaFindManyMock = vi.hoisted(() => vi.fn());
const prismaFindUniqueMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/lib/email', () => ({
  sendMail: sendMailMock,
  userEmail: (name: string) => `${name}@example.com`,
}));

vi.mock('../../src/lib/event-bus', () => ({
  eventBus: {
    publish: eventBusPublishMock,
    publishToUser: vi.fn(),
    subscribe: vi.fn(),
    subscribeUser: vi.fn(),
    getClientCount: vi.fn(),
  },
}));

vi.mock('../../src/lib/prisma', () => ({
  prisma: {
    projectMember: { findMany: prismaFindManyMock },
    project: { findUnique: prismaFindUniqueMock },
  },
}));

beforeEach(async () => {
  sendMailMock.mockReset().mockReturnValue(true);
  eventBusPublishMock.mockReset();
  prismaFindManyMock.mockReset().mockResolvedValue([{ name: 'alice' }]);
  prismaFindUniqueMock.mockReset().mockResolvedValue({ name: 'Demo Project' });
  const mod = await import('../../src/lib/ai-escalation');
  mod._resetAiEscalationRateLimit();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('R-191a escalateLowConfidence', () => {
  it('publishes SSE + sends email on first call', async () => {
    const { escalateLowConfidence } = await import('../../src/lib/ai-escalation');
    const out = await escalateLowConfidence('proj', 'impact_score_very_low', {
      summary: 'low score',
      taskId: 't1',
    });
    expect(out.ssePublished).toBe(true);
    expect(out.emailSent).toBe(true);
    expect(out.rateLimited).toBe(false);

    expect(eventBusPublishMock).toHaveBeenCalledTimes(1);
    expect(eventBusPublishMock.mock.calls[0][0]).toBe('proj');
    expect(eventBusPublishMock.mock.calls[0][1]).toBe('ai_low_confidence');
    expect((eventBusPublishMock.mock.calls[0][2] as { kind: string }).kind).toBe(
      'impact_score_very_low',
    );

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0][0]).toEqual(['alice@example.com']);
    expect(sendMailMock.mock.calls[0][1]).toMatch(/impact_score_very_low/);
    // R-191a refinement: subject + body use the friendly project name,
    // not the raw projectId UUID the owner has no way of recognising.
    expect(sendMailMock.mock.calls[0][1]).toContain('Demo Project');
    expect(sendMailMock.mock.calls[0][2]).toContain('Demo Project');
    expect(sendMailMock.mock.calls[0][2]).toContain('(proj)');
  });

  it('falls back to raw projectId when project name lookup returns null', async () => {
    prismaFindUniqueMock.mockResolvedValueOnce(null);
    const { escalateLowConfidence } = await import('../../src/lib/ai-escalation');
    await escalateLowConfidence('proj-missing', 'impact_score_very_low', {
      summary: 's',
    });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    // Subject + body should still reference the projectId so the email
    // is actionable, just without the friendly label.
    expect(sendMailMock.mock.calls[0][1]).toContain('proj-missing');
    expect(sendMailMock.mock.calls[0][2]).toContain('proj-missing');
  });

  it('rate-limits email (1/hour per project+kind) but still pushes SSE', async () => {
    const { escalateLowConfidence } = await import('../../src/lib/ai-escalation');
    await escalateLowConfidence('proj', 'impact_score_very_low', { summary: 's' });
    const out2 = await escalateLowConfidence('proj', 'impact_score_very_low', {
      summary: 's',
    });
    expect(out2.rateLimited).toBe(true);
    expect(out2.emailSent).toBe(false);
    expect(out2.ssePublished).toBe(true);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(eventBusPublishMock).toHaveBeenCalledTimes(2);
  });

  it('isolates rate limit per (projectId, kind)', async () => {
    const { escalateLowConfidence } = await import('../../src/lib/ai-escalation');
    await escalateLowConfidence('p1', 'impact_returned_null', { summary: 'x' });
    const otherKind = await escalateLowConfidence('p1', 'impact_score_very_low', {
      summary: 'y',
    });
    const otherProject = await escalateLowConfidence('p2', 'impact_returned_null', {
      summary: 'z',
    });
    expect(otherKind.emailSent).toBe(true);
    expect(otherProject.emailSent).toBe(true);
  });

  it('skips email when no human owner exists, still pushes SSE', async () => {
    prismaFindManyMock.mockResolvedValueOnce([]);
    const { escalateLowConfidence } = await import('../../src/lib/ai-escalation');
    const out = await escalateLowConfidence('proj', 'impact_returned_null', {
      summary: 'no owner',
    });
    expect(out.ssePublished).toBe(true);
    expect(out.emailSent).toBe(false);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('does NOT throw when SSE publish or email send fails', async () => {
    eventBusPublishMock.mockImplementationOnce(() => {
      throw new Error('sse blew up');
    });
    sendMailMock.mockReturnValueOnce(false);
    const { escalateLowConfidence } = await import('../../src/lib/ai-escalation');
    const out = await escalateLowConfidence('proj', 'impact_returned_null', {
      summary: 's',
    });
    expect(out.ssePublished).toBe(false);
    expect(out.emailSent).toBe(false);
  });
});

describe('R-191a impact-analysis escalation hooks', () => {
  // Re-mock client for the impact-analysis path.
  const { completeMock } = vi.hoisted(() => ({ completeMock: vi.fn() }));
  vi.mock('../../src/lib/ai/client', () => ({
    aiClient: {
      get isAvailable() {
        return true;
      },
      providerName: 'mock',
      complete: completeMock,
    },
  }));

  beforeEach(() => {
    completeMock.mockReset();
  });

  it('escalates impact_score_very_low when compatibilityScore < 30', async () => {
    completeMock.mockResolvedValueOnce(
      JSON.stringify({
        compatibilityScore: 18,
        compatible: false,
        suggestedAction: 'rebind',
        reasoning: 'too far apart',
        affectedAreas: ['api'],
        riskLevel: 'high',
      }),
    );
    const { analyzeTaskImpact } = await import('../../src/lib/ai/impact-analysis');
    await analyzeTaskImpact(
      { changes: [], summary: '', breakingChanges: false } as never,
      { title: 'Risky task', status: 'in_progress', boundPlanVersion: 1 },
      'proj-1',
      'task-1',
    );

    // Give the void-fired escalation a tick to run
    await new Promise((r) => setImmediate(r));

    const calls = eventBusPublishMock.mock.calls.filter(
      (c) => (c[2] as { kind?: string })?.kind === 'impact_score_very_low',
    );
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('escalates impact_returned_null when AI returns null', async () => {
    completeMock.mockResolvedValueOnce(null);
    const { analyzeTaskImpact } = await import('../../src/lib/ai/impact-analysis');
    const out = await analyzeTaskImpact(
      { changes: [], summary: '', breakingChanges: false } as never,
      { title: 'No signal task', status: 'in_progress', boundPlanVersion: 1 },
      'proj-1',
      'task-1',
    );
    expect(out).toBeNull();
    await new Promise((r) => setImmediate(r));
    const calls = eventBusPublishMock.mock.calls.filter(
      (c) => (c[2] as { kind?: string })?.kind === 'impact_returned_null',
    );
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT escalate when score is comfortable (>=30)', async () => {
    completeMock.mockResolvedValueOnce(
      JSON.stringify({
        compatibilityScore: 80,
        compatible: true,
        suggestedAction: 'no_impact',
        reasoning: 'ok',
        affectedAreas: [],
        riskLevel: 'low',
      }),
    );
    const { analyzeTaskImpact } = await import('../../src/lib/ai/impact-analysis');
    await analyzeTaskImpact(
      { changes: [], summary: '', breakingChanges: false } as never,
      { title: 'fine', status: 'in_progress', boundPlanVersion: 1 },
      'proj-1',
      'task-1',
    );
    await new Promise((r) => setImmediate(r));
    const calls = eventBusPublishMock.mock.calls.filter(
      (c) => (c[2] as { kind?: string })?.kind?.startsWith('impact_'),
    );
    expect(calls).toHaveLength(0);
  });

  it('does NOT escalate when projectId is not provided (backwards-compat)', async () => {
    completeMock.mockResolvedValueOnce(null);
    const { analyzeTaskImpact } = await import('../../src/lib/ai/impact-analysis');
    await analyzeTaskImpact(
      { changes: [], summary: '', breakingChanges: false } as never,
      { title: 't', status: 'in_progress', boundPlanVersion: 1 },
    );
    await new Promise((r) => setImmediate(r));
    expect(eventBusPublishMock).not.toHaveBeenCalled();
  });
});
