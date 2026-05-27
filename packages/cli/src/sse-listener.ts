/**
 * Minimal SSE subscriber for the PlanSync CLI.
 *
 * Subscribes directly to /api/user-events and invokes a handler for each event.
 * Bypasses the MCP server so notifications work even when the MCP layer is
 * paused, restarting, or unavailable. Reconnects on failure with exponential
 * backoff (1s → 30s).
 *
 * Authentication failures (401/403) are surfaced separately:
 *   - the listener stops permanently (no retry storm against an invalid key)
 *   - an `authFailure` event is emitted so callers can prompt the user to
 *     re-login
 *   - a red banner is written to stderr so the failure is visible even if no
 *     listener is wired up.
 *
 * R-023 — see docs/REMEDIATION_PLAN.md.
 */

import { EventEmitter } from 'events';
import { cfg } from './config.js';

type EventHandler = (eventType: string, data: Record<string, unknown>) => void;

export interface AuthFailurePayload {
  status: number;
  statusText: string;
  url: string;
}

/**
 * Event names emitted by CliSseListener.
 *
 * - `authFailure` (payload: {@link AuthFailurePayload}) — server returned 401
 *   or 403 on the SSE handshake. The listener has stopped permanently;
 *   the consumer should prompt the user to re-authenticate.
 */
export type CliSseListenerEvent = 'authFailure';

export class CliSseListener extends EventEmitter {
  private abortController: AbortController | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30000;
  private running = false;

  private restartTimeout: ReturnType<typeof setTimeout> | null = null;
  private restarting = false;

  private authFailed = false;

  constructor(private handler: EventHandler) {
    super();
  }

  /** Whether the listener stopped because of a 401/403 from the server. */
  hasAuthFailed(): boolean {
    return this.authFailed;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.abortController) this.abortController.abort();
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    if (this.restartTimeout) clearTimeout(this.restartTimeout);
  }

  /**
   * Tear down the current connection and reconnect after a short debounce.
   * Used when membership changes for the current user — the new connection
   * re-runs `projectMember.findMany` server-side and picks up new projects.
   * Multiple calls within the debounce window coalesce into one reconnect.
   */
  scheduleRestart(): void {
    if (!this.running) return;
    if (this.restartTimeout) return;
    this.restartTimeout = setTimeout(() => {
      this.restartTimeout = null;
      if (!this.running) return;
      this.restarting = true;
      this.reconnectDelay = 1000;
      if (this.abortController) this.abortController.abort();
    }, 200);
  }

  private async connect(): Promise<void> {
    if (!this.running) return;

    const url = `${cfg.apiUrl}/api/user-events`;
    this.abortController = new AbortController();

    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'X-User-Name': cfg.user,
          Accept: 'text/event-stream',
        },
        signal: this.abortController.signal,
      });

      if (res.status === 401 || res.status === 403) {
        this.handleAuthFailure(res.status, res.statusText, url);
        return;
      }

      if (!res.ok || !res.body) {
        throw new Error(`SSE ${res.status} ${res.statusText}`);
      }

      this.reconnectDelay = 1000;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';
      let currentData = '';

      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.replace(/\r$/, '');
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7);
          } else if (line.startsWith('data: ')) {
            currentData = currentData ? currentData + '\n' + line.slice(6) : line.slice(6);
          } else if (line === '' && currentEvent && currentData) {
            try {
              const data = JSON.parse(currentData) as Record<string, unknown>;
              this.handler(currentEvent, data);
            } catch {
              // ignore malformed payloads
            }
            currentEvent = '';
            currentData = '';
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Aborts come from stop() (running=false → no reconnect below) or
        // scheduleRestart() (restarting=true → reconnect immediately below).
        if (!this.restarting) return;
      }
      // swallow; reconnect logic below
    }

    const wasRestarting = this.restarting;
    this.restarting = false;

    if (this.running) {
      const delay = wasRestarting ? 0 : this.reconnectDelay;
      if (!wasRestarting) {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      }
      this.reconnectTimeout = setTimeout(() => {
        if (this.running) this.connect();
      }, delay);
    }
  }

  /**
   * Permanently stop the listener and notify the caller that the server
   * rejected our credentials. Also writes a red banner to stderr so the
   * failure is never silent — consistent with how MCP heartbeat surfaces
   * STATE_CONFLICTs.
   */
  private handleAuthFailure(status: number, statusText: string, url: string): void {
    this.authFailed = true;
    this.running = false;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    const reset = '\x1b[0m';
    const red = '\x1b[31m';
    const dim = '\x1b[2m';
    process.stderr.write(
      `\n${red}⚠ PlanSync: SSE connection rejected (${status} ${statusText}).${reset}\n` +
        `${dim}  Your API credentials may have expired.${reset}\n` +
        `${dim}  Run \`./bin/plansync\` to re-authenticate, then restart the CLI.${reset}\n\n`,
    );

    this.emit('authFailure', { status, statusText, url });
  }
}

/**
 * Event types that warrant the 30s red flash in the Ink prompt area above
 * the input line (vs. only being appended to `/notifs`).
 *
 * Must stay in sync with the browser-side "sticky warning" set in
 * `packages/api/src/components/notifications.tsx` so the CLI and Web UI
 * give the same urgency signal for the same event. In particular:
 *
 * - Fixes #1348 — `task_awaiting_evidence` (introduced by PR #1223 for the
 *   R-192 gate) is a sticky `warning` toast in the browser: the run
 *   reported `complete` but the task is parked until evidence (PR merge,
 *   deliverable commit, etc.) arrives. The CLI must flash red too,
 *   otherwise the owner has no signal that work is *not* actually closed.
 */
export const URGENT_EVENTS: ReadonlySet<string> = new Set([
  'drift_detected',
  'execution_stale',
  'plan_activated',
  'review_requested',
  'review_approved',
  'review_rejected',
  'task_assigned',
  'task_awaiting_evidence',
  'suggestion_created',
]);

/**
 * Render a one-line human-readable description of an event for the CLI
 * notification bar. Returns null for low-signal events (e.g. task_started).
 *
 * No ⚠/◆ icons — the display layer adds them based on the urgent flag.
 * Project prefix is shown only for events from a different project (multi-project users).
 */
export function describeEvent(eventType: string, data: Record<string, unknown>): string | null {
  // Only prefix with project name when the event comes from a different project
  const isDifferentProject = data.projectId && data.projectId !== cfg.project;
  const prefix = isDifferentProject ? `[${data.projectName as string}] ` : '';
  const w = (msg: string) => prefix + msg;

  switch (eventType) {
    case 'plan_activated':
      return w(`Plan v${data.version} activated by ${data.activatedBy}`);
    case 'plan_proposed':
      return w(`Plan "${data.title}" proposed by ${data.proposedBy}`);
    case 'plan_draft_updated':
      return w(`Plan v${data.version} draft updated`);
    case 'drift_detected': {
      const alerts = data.alerts as Array<{ severity: string }> | undefined;
      const total = alerts?.length ?? 0;
      const high = alerts?.filter((a) => a.severity === 'high').length ?? 0;
      if (total === 0) return null;
      return w(`${total} drift alert(s)${high > 0 ? ` — ${high} high` : ''}`);
    }
    case 'drift_resolved':
      return w(`Drift resolved`);
    case 'task_assigned':
      return w(`"${data.title}" assigned to ${data.assignee}`);
    case 'task_completed':
      return w(`"${data.title ?? data.taskId}" done`);
    case 'task_awaiting_evidence': {
      // Closes #1231 — PR #1223 introduced this named SSE event when
      // the R-192 gate parks a task in `awaiting_evidence`. The CLI
      // listener parses every named event off the stream so the
      // `handler` already gets it; without a describe case the
      // notification bar would silently render nothing.
      const missing = Array.isArray(data.missing)
        ? (data.missing as Array<{ code?: string } | string>)
        : [];
      const codes = missing
        .map((m) => (typeof m === 'string' ? m : m?.code))
        .filter((c): c is string => typeof c === 'string' && c.length > 0);
      const detail = codes.length > 0 ? ` — missing ${codes.join(', ')}` : '';
      return w(`"${data.title ?? data.taskId}" awaiting evidence${detail}`);
    }
    case 'task_unassigned':
      return w(`Task unassigned (was: ${data.previousAssignee ?? '?'})`);
    case 'execution_stale':
      return w(`Execution by "${data.executorName}" went stale`);
    case 'suggestion_created':
      return w(`Plan suggestion by ${data.suggestedBy}`);
    case 'suggestion_resolved':
      return w(`Plan suggestion ${data.status ?? 'resolved'}`);
    case 'comment_added':
      return w(`${data.authorName ?? 'Someone'} commented on plan`);
    case 'member_added':
      return w(`"${data.name}" added to project`);
    case 'member_removed':
      return w(`"${data.memberName}" removed from project`);
    case 'review_requested':
      return w(`You have been added as a reviewer for plan v${data.version}`);
    case 'review_approved':
      return w(`Plan review approved by ${data.reviewer}`);
    case 'review_rejected':
      return w(`Plan review rejected by ${data.reviewer}`);
    case 'member_updated':
      return w(`"${data.name}" role updated to ${data.role}`);
    case 'comment_updated':
      return w(`${data.authorName ?? 'Someone'} edited a comment on plan`);
    case 'comment_deleted':
      return w(`${data.authorName ?? 'Someone'} deleted a comment on plan`);
    default:
      return null;
  }
}
