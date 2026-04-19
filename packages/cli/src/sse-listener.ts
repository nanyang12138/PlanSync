/**
 * Minimal SSE subscriber for the PlanSync CLI.
 *
 * Subscribes directly to /api/user-events and invokes a handler for each event.
 * Bypasses the MCP server so notifications work even when the MCP layer is
 * paused, restarting, or unavailable. Reconnects on failure with exponential
 * backoff (1s → 30s).
 */

import { cfg } from './config.js';

type EventHandler = (eventType: string, data: Record<string, unknown>) => void;

export class CliSseListener {
  private abortController: AbortController | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30000;
  private running = false;

  private restartTimeout: ReturnType<typeof setTimeout> | null = null;
  private restarting = false;

  constructor(private handler: EventHandler) {}

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
}

/**
 * Render a one-line human-readable description of an event for display in the
 * CLI status bar / printAbove. Returns null for events the user doesn't care
 * about in the terminal (e.g. low-signal task_started).
 */
export function describeEvent(eventType: string, data: Record<string, unknown>): string | null {
  const projectPrefix = data.projectName ? `[${data.projectName as string}] ` : '';
  const wrap = (msg: string) => projectPrefix + msg;

  switch (eventType) {
    case 'plan_activated':
      return wrap(
        `⚠ Plan v${data.version} activated by ${data.activatedBy} — check tasks for drift`,
      );
    case 'plan_proposed':
      return wrap(`Plan "${data.title}" submitted for review by ${data.proposedBy}`);
    case 'plan_draft_updated':
      return wrap(`Plan v${data.version} draft updated`);
    case 'drift_detected': {
      const alerts = data.alerts as Array<{ severity: string }> | undefined;
      const total = alerts?.length ?? 0;
      const high = alerts?.filter((a) => a.severity === 'high').length ?? 0;
      const med = alerts?.filter((a) => a.severity === 'medium').length ?? 0;
      if (total === 0) return null;
      return wrap(`⚠ ${total} drift alert(s) (${high} high, ${med} medium)`);
    }
    case 'drift_resolved':
      return wrap(`Drift resolved (${data.resolvedAction ?? data.action ?? 'resolved'})`);
    case 'task_assigned':
      return wrap(`Task "${data.title}" assigned to ${data.assignee}`);
    case 'task_completed':
      return wrap(`Task "${data.title ?? data.taskId}" marked done`);
    case 'task_unassigned':
      return wrap(`Task unassigned (was: ${data.previousAssignee ?? '?'})`);
    case 'execution_stale':
      return wrap(`⚠ Execution by "${data.executorName}" went stale`);
    case 'suggestion_created':
      return wrap(`New plan suggestion by ${data.suggestedBy}`);
    case 'suggestion_resolved':
      return wrap(`Plan suggestion ${data.status ?? 'resolved'}`);
    case 'comment_added':
      return wrap(`${data.authorName ?? 'Someone'} commented on plan`);
    case 'member_added':
      return wrap(`Member "${data.name}" added`);
    case 'member_removed':
      return wrap(`Member "${data.memberName}" removed`);
    default:
      return null;
  }
}
