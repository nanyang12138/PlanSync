// R-191a: AI low-confidence auto-escalation.
//
// When the AI subsystem produces a low-confidence signal (impact score
// < 30, AI returned null on a critical path, repeated drift-enrich
// failures, etc.), surface it to the project owner BEFORE the silent
// fail propagates. Industry pattern: AWS Bedrock Custom Intervention
// uses a RAGAS threshold → SNS notify-human flow for exactly this.
//
// Mechanics.
//   * One owner email per (projectId, kind) per hour — uses an
//     in-memory token bucket so a misbehaving provider can't flood the
//     mailbox.
//   * SSE is always pushed (no rate limit) so a live UI surfaces every
//     event in real time; the owner can configure the email cadence
//     later if needed.
//   * Both channels are best-effort: a failure to send mail / publish
//     SSE is logged but never thrown, because escalation must not
//     interfere with the caller's primary flow.
//
// Caller responsibility: just call `escalateLowConfidence(...)` with a
// short `kind` string and a free-form payload. The module decides who
// the owner is, whether to email, and what the subject line should be.

import { prisma } from './prisma';
import { logger } from './logger';
import { eventBus } from './event-bus';
import { sendMail, userEmail } from './email';

const ESCALATION_WINDOW_MS = 60 * 60 * 1000;

const lastSentByKey = new Map<string, number>();

export type AiLowConfidenceKind =
  | 'impact_score_very_low'
  | 'impact_returned_null'
  | 'drift_enrich_systematic_failure'
  | 'completion_verify_unstable';

export interface AiEscalationPayload {
  /** Free-form summary the owner UI / email body can render verbatim. */
  summary: string;
  /** Optional pointer back to the originating task / drift / run. */
  taskId?: string;
  runId?: string;
  driftAlertId?: string;
  /** Anything else worth showing in the email; keys are not interpreted. */
  details?: Record<string, unknown>;
}

function rateLimitKey(projectId: string, kind: AiLowConfidenceKind): string {
  return `${projectId}::${kind}`;
}

/**
 * Best-effort emit. Always pushes an SSE event; emails the project
 * owner at most once per hour per (projectId, kind). Returns a small
 * audit object so callers can include the outcome in their own logs.
 */
export async function escalateLowConfidence(
  projectId: string,
  kind: AiLowConfidenceKind,
  payload: AiEscalationPayload,
): Promise<{ ssePublished: boolean; emailSent: boolean; rateLimited: boolean }> {
  const result = {
    ssePublished: false,
    emailSent: false,
    rateLimited: false,
  };

  // SSE: push to every owner of the project. We publish on the project
  // channel so any listening UI catches it; the payload includes `kind`
  // so the UI can choose how to render.
  try {
    eventBus.publish(projectId, 'ai_low_confidence', {
      kind,
      summary: payload.summary,
      taskId: payload.taskId,
      runId: payload.runId,
      driftAlertId: payload.driftAlertId,
      details: payload.details,
    });
    result.ssePublished = true;
  } catch (err) {
    logger.warn({ err, projectId, kind }, 'ai_escalation_sse_publish_failed');
  }

  // Email — gated by the in-memory rate limiter.
  const key = rateLimitKey(projectId, kind);
  const now = Date.now();
  const last = lastSentByKey.get(key) ?? 0;
  if (now - last < ESCALATION_WINDOW_MS) {
    result.rateLimited = true;
    logger.debug(
      { projectId, kind, secsSinceLast: Math.round((now - last) / 1000) },
      'ai_escalation_email_rate_limited',
    );
    return result;
  }

  try {
    // Resolve the project's friendly name + owners in one round-trip so
    // the email body shows e.g. "Project: Auth Revamp (proj-xyz)" rather
    // than the raw UUID an owner has no chance of recognising.
    const [project, owners] = await Promise.all([
      prisma.project.findUnique({ where: { id: projectId }, select: { name: true } }),
      prisma.projectMember.findMany({
        where: { projectId, role: 'owner', type: 'human' },
        select: { name: true },
      }),
    ]);
    if (owners.length === 0) {
      logger.debug({ projectId, kind }, 'ai_escalation_no_human_owner_skip_email');
      return result;
    }
    const projectLabel = project?.name ? `${project.name} (${projectId})` : projectId;
    const subject = `[PlanSync] AI low-confidence signal in "${project?.name ?? projectId}": ${kind}`;
    const detailLines = payload.details
      ? Object.entries(payload.details).map(
          ([k, v]) => `  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`,
        )
      : [];
    const body = [
      'The PlanSync AI subsystem flagged a low-confidence result that needs human review.',
      '',
      `Kind: ${kind}`,
      `Project: ${projectLabel}`,
      payload.taskId ? `Task: ${payload.taskId}` : null,
      payload.runId ? `Run: ${payload.runId}` : null,
      payload.driftAlertId ? `Drift alert: ${payload.driftAlertId}` : null,
      '',
      payload.summary,
      detailLines.length > 0 ? '\nDetails:' : null,
      ...detailLines,
      '',
      'Open PlanSync to confirm or override the AI suggestion.',
    ]
      .filter((s): s is string => s !== null)
      .join('\n');
    const ok = sendMail(
      owners.map((o) => userEmail(o.name)),
      subject,
      body,
    );
    if (!ok) {
      logger.warn({ projectId, kind }, 'ai_escalation_email_send_failed');
    } else {
      result.emailSent = true;
      lastSentByKey.set(key, now);
    }
  } catch (err) {
    logger.warn({ err, projectId, kind }, 'ai_escalation_email_query_failed');
  }

  return result;
}

/** Test helper: clear the in-memory rate limiter state. */
export function _resetAiEscalationRateLimit(): void {
  lastSentByKey.clear();
}
