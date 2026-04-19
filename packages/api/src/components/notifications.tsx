'use client';

/**
 * Cross-project real-time notifications for the PlanSync web UI.
 *
 * NotificationProvider:
 *   - Subscribes to /api/user-events (all projects the user is a member of)
 *   - Shows toast notifications for key events
 *   - Warning-level toasts are sticky (no auto-dismiss); info toasts dismiss after 6 s
 *   - Optional browser notifications when the tab is hidden (opt-in via Notification API permission)
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Types ─────────────────────────────────────────────────────────────────────

type Level = 'info' | 'warning';

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

// ── Context ───────────────────────────────────────────────────────────────────

const NotifyContext = createContext<NotifyFn>(() => {});
export const useNotify = () => useContext(NotifyContext);

// ── Toast item ────────────────────────────────────────────────────────────────

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-3 rounded-md border border-border bg-card px-4 py-3 shadow-lg',
        toast.level === 'warning'
          ? 'border-l-4 border-l-amber-500'
          : 'border-l-4 border-l-blue-500',
      )}
    >
      <span className="mt-0.5 shrink-0 text-base">{toast.level === 'warning' ? '⚠' : 'ℹ'}</span>
      <p className="flex-1 text-sm text-foreground">{toast.message}</p>
      <button
        onClick={onDismiss}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
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
  const notifyRef = useRef<NotifyFn | null>(null);

  const notify: NotifyFn = useCallback((message, level = 'info', opts) => {
    const sticky = opts?.sticky ?? false;
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev.slice(-(MAX_TOASTS - 1)), { id, message, level, sticky }]);
    if (!sticky) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, AUTO_DISMISS_MS);
    }

    // Browser notification fallback when tab is hidden and user has granted permission.
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

  // Subscribe to user-level SSE — receives events from all user's projects.
  // Reconnects on its own membership change so a brand-new project the user
  // was just added to is picked up without a page reload.
  useEffect(() => {
    const currentUser = (() => {
      const m = document.cookie.match(/(?:^|; )plansync-user=([^;]*)/);
      return m ? decodeURIComponent(m[1]) : null;
    })();

    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const scheduleReconnect = () => {
      if (cancelled) return;
      if (reconnectTimer) return; // debounce: coalesce a burst of memberships
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (cancelled) return;
        es?.close();
        connect();
      }, 200);
    };

    const connect = () => {
      es = new EventSource('/api/user-events');
      for (const type of ALL_EVENT_TYPES) {
        es.addEventListener(type, (e: Event) => {
          try {
            const data = JSON.parse((e as MessageEvent).data) as Record<string, unknown>;

            // Membership change targeting the current user → reconnect so the
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
        });
      }
      es.onerror = () => {
        // EventSource auto-reconnects on transport errors
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
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
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </NotifyContext.Provider>
  );
}
