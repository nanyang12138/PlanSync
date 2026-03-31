import { McpConfig } from './config';
import { logger } from './logger';

export interface NotificationConfig {
  pushOnHigh: boolean;
  pushOnMedium: boolean;
  silentMode: boolean;
}

const DEFAULT_CONFIG: NotificationConfig = {
  pushOnHigh: true,
  pushOnMedium: false,
  silentMode: false,
};

type EventHandler = (event: string, data: Record<string, unknown>) => void;

export class EventListener {
  private abortController: AbortController | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private running = false;
  private notifyConfig: NotificationConfig;
  private handler: EventHandler;

  constructor(
    private config: McpConfig,
    private projectId: string,
    handler: EventHandler,
    notifyConfig?: Partial<NotificationConfig>,
  ) {
    this.handler = handler;
    this.notifyConfig = { ...DEFAULT_CONFIG, ...notifyConfig };
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
  }

  private async connect(): Promise<void> {
    if (!this.running) return;

    const url = `${this.config.apiBaseUrl}/api/projects/${this.projectId}/events`;
    this.abortController = new AbortController();

    try {
      logger.info({ url, projectId: this.projectId }, 'Connecting to SSE');
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          'X-User-Name': this.config.userName,
        },
        signal: this.abortController.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`SSE connection failed: ${res.status}`);
      }

      this.reconnectDelay = 1000;
      logger.info({ projectId: this.projectId }, 'SSE connected');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEvent = '';
        let currentData = '';

        for (const rawLine of lines) {
          const line = rawLine.replace(/\r$/, '');
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7);
          } else if (line.startsWith('data: ')) {
            // SSE spec: multiple data lines are concatenated with newline
            currentData = currentData ? currentData + '\n' + line.slice(6) : line.slice(6);
          } else if (line === '' && currentEvent && currentData) {
            this.handleEvent(currentEvent, currentData);
            currentEvent = '';
            currentData = '';
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      logger.warn({ err, projectId: this.projectId }, 'SSE connection error');
    }

    // Re-check this.running after async operations to avoid scheduling a reconnect
    // after stop() has already been called (race condition between catch block and stop())
    if (this.running) {
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      logger.info({ delay }, 'SSE reconnecting');
      this.reconnectTimeout = setTimeout(() => {
        if (this.running) this.connect();
      }, delay);
    }
  }

  private handleEvent(eventType: string, rawData: string): void {
    if (this.notifyConfig.silentMode) return;

    try {
      const data = JSON.parse(rawData) as Record<string, unknown>;

      if (eventType === 'drift_detected') {
        const alerts = data.alerts as Array<{ severity: string }>;
        const hasHigh = alerts?.some((a) => a.severity === 'high');
        const hasMedium = alerts?.some((a) => a.severity === 'medium');

        if (hasHigh && this.notifyConfig.pushOnHigh) {
          this.handler(eventType, data);
        } else if (hasMedium && this.notifyConfig.pushOnMedium) {
          this.handler(eventType, data);
        }
        return;
      }

      this.handler(eventType, data);
    } catch (err) {
      logger.error({ err, eventType }, 'Failed to handle SSE event');
    }
  }
}
