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
    default:
      return null;
  }
}
