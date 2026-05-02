'use client';

/**
 * Cross-project real-time notifications for the PlanSync web UI.
 *
 * NotificationProvider:
 *   - Subscribes to /api/user-events (all projects the user is a member of)
 *   - Shows toast notifications for key events
 *   - Warning-level toasts are sticky (no auto-dismiss); info toasts dismiss after 6 s
 *   - Optional browser notifications when the tab is hidden (opt-in via Notification API permission)
 *   - Circuit breaker: 5 failed reconnects → switch to a 30 s probe loop and surface a
 *     visible "Reconnecting…" pill so the user knows live updates are paused
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Types ─────────────────────────────────────────────────────────────────────

type Level = 'info' | 'warning';
type ConnState = 'connected' | 'reconnecting' | 'down';

interface Toast {
  id: string;
  message: string;
  level: Level;
  sticky: boolean;
}

interface NotifyFn {
  (message: string, level?: Level, opts?: { sticky?: boolean }): void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_TOASTS = 8;
const AUTO_DISMISS_MS = 6000;
const MAX_RECONNECT_ATTEMPTS = 5;
const PROBE_INTERVAL_MS = 30_000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

// ── Context ───────────────────────────────────────────────────────────────────

const NotifyContext = createContext<NotifyFn>(() => {});
export const useNotify = () => useContext(NotifyContext);

// ── Cookie helper ─────────────────────────────────────────────────────────────

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

// ── Toast item ────────────────────────────────────────────────────────────────

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-3 rounded-lg border bg-surface-1 px-4 py-3 shadow-lg',
        toast.level === 'warning'
          ? 'border-l-4 border-l-warning border-subtle'
          : 'border-l-4 border-l-primary border-subtle',
      )}
    >
      <span className="mt-0.5 shrink-0 text-base" aria-hidden>
        {toast.level === 'warning' ? '⚠' : 'ℹ'}
      </span>
      <p className="flex-1 text-sm text-fg">{toast.message}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 text-fg-subtle hover:text-fg"
        aria-label="Dismiss notification"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ── Connection-status pill ────────────────────────────────────────────────────

function ConnectionPill({
  state,
  onRetry,
}: {
  state: Exclude<ConnState, 'connected'>;
  onRetry: () => void;
}) {
  const label = state === 'down' ? 'Live updates paused' : 'Reconnecting…';
  return (
    <div className="pill-reconnecting" role="status" aria-live="polite">
      <RefreshCw
        className={cn('h-3 w-3', state === 'reconnecting' && 'animate-spin')}
        aria-hidden
      />
      <span>{label}</span>
      {state === 'down' ? (
        <button
          type="button"
          onClick={onRetry}
          className="ml-1 underline underline-offset-2 hover:no-underline"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

// ── Event → toast mapping ─────────────────────────────────────────────────────

type ToastSpec = { level: Level; msg: string; sticky?: boolean };

const EVENT_HANDLERS: Partial<Record<string, (data: Record<string, unknown>) => ToastSpec | null>> =
  {
    plan_created: (d) => ({
      level: 'info',
      msg: `Plan v${d.version} "${d.title}" drafted by ${d.createdBy}`,
    }),
    plan_proposed: (d) => ({
      level: 'info',
      msg: `Plan "${d.title}" submitted for review by ${d.proposedBy}`,
    }),
    plan_activated: (d) => ({
      level: 'warning',
      msg: `Plan v${d.version} activated by ${d.activatedBy} — check tasks for drift`,
      sticky: true,
    }),
    plan_draft_updated: (d) => ({
      level: 'info',
      msg: `Plan v${d.version} draft updated by ${d.updatedBy ?? 'someone'}`,
    }),
    drift_detected: (d) => {
      const alerts = d.alerts as Array<{ severity: string }> | undefined;
      const high = alerts?.filter((a) => a.severity === 'high').length ?? 0;
      const medium = alerts?.filter((a) => a.severity === 'medium').length ?? 0;
      if (high === 0 && medium === 0) return null;
      const total = alerts?.length ?? 0;
      return {
        level: 'warning',
        msg: `⚠ ${total} drift alert(s) (${high} high, ${medium} medium) — pause and check`,
        sticky: true,
      };
    },
    drift_resolved: (d) => ({
      level: 'info',
      msg: `Drift on "${d.taskTitle ?? 'task'}" resolved (${d.action ?? 'resolved'})`,
    }),
    task_assigned: (d) => ({
      level: 'info',
      msg: `Task "${d.title}" assigned to ${d.assignee}`,
    }),
    task_completed: (d) => ({
      level: 'info',
      msg: `Task "${d.title}" marked done by ${d.completedBy ?? 'someone'}`,
    }),
    execution_stale: (d) => ({
      level: 'warning',
      msg: `Execution by "${d.executorName}" went stale — may have crashed`,
      sticky: true,
    }),
    suggestion_created: (d) => ({
      level: 'info',
      msg: `Plan suggestion from ${d.suggestedBy ?? 'someone'}: ${d.field ?? ''} ${d.action ?? ''}`,
    }),
    suggestion_resolved: (d) => ({
      level: 'info',
      msg: `Plan suggestion ${d.status ?? 'resolved'} by ${d.resolvedBy ?? 'someone'}`,
    }),
    comment_added: (d) => ({
      level: 'info',
      msg: `${d.authorName ?? 'Someone'} commented on plan "${d.planTitle ?? ''}"`,
    }),
  };

const ALL_EVENT_TYPES = [
  'plan_created',
  'plan_proposed',
  'plan_activated',
  'plan_draft_updated',
  'drift_detected',
  'drift_resolved',
  'task_created',
  'task_assigned',
  'task_unassigned',
  'task_started',
  'task_completed',
  'execution_stale',
  'suggestion_created',
  'suggestion_resolved',
  'comment_added',
  'member_added',
  'member_removed',
];

// ── Provider ──────────────────────────────────────────────────────────────────

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [connState, setConnState] = useState<ConnState>('connected');
  const notifyRef = useRef<NotifyFn | null>(null);
  const retryRef = useRef<() => void>(() => {});

  const notify: NotifyFn = useCallback((message, level = 'info', opts) => {
    const sticky = opts?.sticky ?? false;
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev.slice(-(MAX_TOASTS - 1)), { id, message, level, sticky }]);
    if (!sticky) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, AUTO_DISMISS_MS);
    }

    if (
      typeof window !== 'undefined' &&
      typeof Notification !== 'undefined' &&
      document.visibilityState === 'hidden' &&
      Notification.permission === 'granted' &&
      level === 'warning'
    ) {
      try {
        new Notification('PlanSync', { body: message, silent: false });
      } catch {
        // some browsers throw on Notification() — silent
      }
    }
  }, []);

  notifyRef.current = notify;

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // ── SSE subscription with circuit breaker ─────────────────────────────────
  useEffect(() => {
    const currentUser = readCookie('plansync-user');

    let es: EventSource | null = null;
    let backoffTimer: ReturnType<typeof setTimeout> | null = null;
    let probeTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let cancelled = false;

    const clearTimers = () => {
      if (backoffTimer) clearTimeout(backoffTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (probeTimer) clearInterval(probeTimer);
      backoffTimer = reconnectTimer = null;
      probeTimer = null;
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (cancelled) return;
        es?.close();
        connect();
      }, 200);
    };

    const probe = async () => {
      try {
        const r = await fetch('/api/health', { method: 'HEAD', cache: 'no-store' });
        if (r.ok && !cancelled) {
          attempts = 0;
          if (probeTimer) clearInterval(probeTimer);
          probeTimer = null;
          connect();
        }
      } catch {
        // still down — wait for next probe tick
      }
    };

    const openCircuit = () => {
      if (cancelled) return;
      setConnState('down');
      if (probeTimer) clearInterval(probeTimer);
      probeTimer = setInterval(probe, PROBE_INTERVAL_MS);
    };

    const handleError = () => {
      if (cancelled) return;
      attempts += 1;
      es?.close();
      es = null;
      if (attempts >= MAX_RECONNECT_ATTEMPTS) {
        openCircuit();
        return;
      }
      setConnState('reconnecting');
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
      backoffTimer = setTimeout(() => {
        backoffTimer = null;
        if (cancelled) return;
        connect();
      }, delay);
    };

    const connect = () => {
      if (cancelled) return;
      try {
        es = new EventSource('/api/user-events');
      } catch {
        handleError();
        return;
      }

      es.onopen = () => {
        attempts = 0;
        setConnState('connected');
      };

      const listeners: Array<{ type: string; fn: EventListener }> = [];
      for (const type of ALL_EVENT_TYPES) {
        const fn: EventListener = (e: Event) => {
          try {
            const data = JSON.parse((e as MessageEvent).data) as Record<string, unknown>;

            // Membership change targeting current user → reconnect so the
            // subscription set is refreshed (gain a new project, drop a removed one).
            if (
              currentUser &&
              (type === 'member_added' || type === 'member_removed') &&
              (data.name === currentUser || data.memberName === currentUser)
            ) {
              scheduleReconnect();
            }

            const handler = EVENT_HANDLERS[type];
            if (!handler) return;
            const result = handler(data);
            if (!result) return;
            const pfx = data.projectName ? `[${data.projectName as string}] ` : '';
            notifyRef.current?.(pfx + result.msg, result.level, { sticky: result.sticky });
          } catch {
            // ignore malformed payloads
          }
        };
        listeners.push({ type, fn });
        es.addEventListener(type, fn);
      }

      const removeListeners = () => {
        for (const { type, fn } of listeners) es?.removeEventListener(type, fn);
      };

      es.onerror = () => {
        removeListeners();
        handleError();
      };
    };

    retryRef.current = () => {
      if (cancelled) return;
      attempts = 0;
      clearTimers();
      es?.close();
      setConnState('reconnecting');
      connect();
    };

    connect();

    return () => {
      cancelled = true;
      clearTimers();
      es?.close();
    };
  }, []);

  // Request browser notification permission lazily on first user gesture
  useEffect(() => {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'default') return;
    const handler = () => {
      Notification.requestPermission().catch(() => {});
      window.removeEventListener('click', handler);
    };
    window.addEventListener('click', handler, { once: true });
    return () => window.removeEventListener('click', handler);
  }, []);

  return (
    <NotifyContext.Provider value={notify}>
      {children}
      <div aria-live="polite" className="fixed right-4 top-4 z-50 flex w-80 flex-col gap-2">
        {connState !== 'connected' ? (
          <ConnectionPill state={connState} onRetry={() => retryRef.current()} />
        ) : null}
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </NotifyContext.Provider>
  );
}
