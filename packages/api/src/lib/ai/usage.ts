// R-182 (supersedes R-144): persistence + aggregation for ai_calls.
//
// `recordAiCall` is the single insert path used by `aiClient.complete` for
// every LLM round-trip — success or failure. The aggregator powers
// `/api/ai-usage`, which is owner-only and bucketed by `purpose` so the
// owner can see per-call-site count / p50 latency / total tokens / cache
// hit ratio.
//
// `PLANSYNC_AI_OBSERVABILITY=false` opts out of the INSERT entirely; this
// is the documented rollback flag in REMEDIATION_PLAN.md R-182.

import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

export interface AiCallRecord {
  purpose: string;
  provider: string;
  model: string;
  promptHash: string;
  inputHash: string;
  outputHash: string | null;
  promptVersion: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  ok: boolean;
  errorCode: string | null;
  cacheHit: boolean;
}

function observabilityEnabled(): boolean {
  // Anything other than the literal string 'false' (case-insensitive) keeps
  // observability on. Default-on so opting in to AI logging is just enabling
  // any provider, with no extra env wiring.
  const raw = process.env.PLANSYNC_AI_OBSERVABILITY;
  if (typeof raw !== 'string') return true;
  return raw.toLowerCase() !== 'false';
}

export async function recordAiCall(record: AiCallRecord): Promise<void> {
  if (!observabilityEnabled()) return;

  await prisma.aiCall.create({
    data: {
      purpose: record.purpose,
      provider: record.provider,
      model: record.model,
      promptHash: record.promptHash,
      inputHash: record.inputHash,
      outputHash: record.outputHash,
      promptVersion: record.promptVersion,
      latencyMs: record.latencyMs,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      ok: record.ok,
      errorCode: record.errorCode,
      cacheHit: record.cacheHit,
    },
  });
}

export interface AiUsageBucket {
  purpose: string;
  count: number;
  okCount: number;
  errorCount: number;
  cacheHits: number;
  cacheHitRatio: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

// R-182 fix_steps step 3: `/api/ai-usage` aggregates by purpose
// (count / p50 latency / total token / cache hit ratio). We do the math in
// the Node process rather than SQL so unit tests can call this directly
// without dragging in window functions.
export async function aggregateAiUsage(opts: {
  since?: Date;
  until?: Date;
}): Promise<{ buckets: AiUsageBucket[]; totalCalls: number; rangeFrom: Date | null; rangeTo: Date | null }> {
  const where: Prisma.AiCallWhereInput = {};
  if (opts.since || opts.until) {
    where.createdAt = {};
    if (opts.since) (where.createdAt as Prisma.DateTimeFilter).gte = opts.since;
    if (opts.until) (where.createdAt as Prisma.DateTimeFilter).lte = opts.until;
  }

  const rows = await prisma.aiCall.findMany({
    where,
    select: {
      purpose: true,
      latencyMs: true,
      ok: true,
      cacheHit: true,
      inputTokens: true,
      outputTokens: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  type Acc = {
    latencies: number[];
    okCount: number;
    errorCount: number;
    cacheHits: number;
    inputTokens: number;
    outputTokens: number;
  };
  const byPurpose = new Map<string, Acc>();
  for (const row of rows) {
    let acc = byPurpose.get(row.purpose);
    if (!acc) {
      acc = {
        latencies: [],
        okCount: 0,
        errorCount: 0,
        cacheHits: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      byPurpose.set(row.purpose, acc);
    }
    acc.latencies.push(row.latencyMs);
    if (row.ok) acc.okCount += 1;
    else acc.errorCount += 1;
    if (row.cacheHit) acc.cacheHits += 1;
    if (typeof row.inputTokens === 'number') acc.inputTokens += row.inputTokens;
    if (typeof row.outputTokens === 'number') acc.outputTokens += row.outputTokens;
  }

  const buckets: AiUsageBucket[] = [];
  for (const [purpose, acc] of byPurpose.entries()) {
    const sorted = [...acc.latencies].sort((a, b) => a - b);
    const total = acc.okCount + acc.errorCount;
    buckets.push({
      purpose,
      count: total,
      okCount: acc.okCount,
      errorCount: acc.errorCount,
      cacheHits: acc.cacheHits,
      cacheHitRatio: total > 0 ? acc.cacheHits / total : 0,
      p50LatencyMs: percentile(sorted, 0.5),
      p95LatencyMs: percentile(sorted, 0.95),
      totalInputTokens: acc.inputTokens,
      totalOutputTokens: acc.outputTokens,
    });
  }

  buckets.sort((a, b) => b.count - a.count);

  return {
    buckets,
    totalCalls: rows.length,
    rangeFrom: rows.length > 0 ? rows[0].createdAt : null,
    rangeTo: rows.length > 0 ? rows[rows.length - 1].createdAt : null,
  };
}
