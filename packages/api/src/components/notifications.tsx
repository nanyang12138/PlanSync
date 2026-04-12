'use client';

/**
 * Cross-project real-time notifications for the PlanSync web UI.
 *
 * NotificationProvider:
 *   - Subscribes to /api/user-events (all projects the user is a member of)
 *   - Shows toast notifications for key events (plan changes, drift, task assignments)
 *   - Existing per-project useRealtime() still handles silent UI refresh
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
}

interface NotifyFn {
  (message: string, level?: Level): void;
}

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

// ── Events that warrant a toast (others are too noisy or already visible) ────

const EVENT_HANDLERS: Partial<
  Record<string, (data: Record<string, unknown>) => { level: Level; msg: string } | null>
> = {
  plan_activated: (d) => ({
    level: 'warning',
    msg: `Plan v${d.version} activated by ${d.activatedBy} — check tasks for drift`,
  }),
  plan_proposed: (d) => ({
    level: 'info',
    msg: `Plan "${d.title}" submitted for review by ${d.proposedBy}`,
  }),
  drift_detected: (d) => {
    const alerts = d.alerts as Array<{ severity: string }> | undefined;
    const high = alerts?.filter((a) => a.severity === 'high').length ?? 0;
    if (high === 0) return null; // only notify for high-severity drift
    return {
      level: 'warning',
      msg: `⚠ ${alerts?.length ?? 0} drift alert(s) (${high} high) — pause and check`,
    };
  },
  task_assigned: (d) => ({
    level: 'info',
    msg: `Task "${d.title}" assigned to ${d.assignee}`,
  }),
  execution_stale: (d) => ({
    level: 'warning',
    msg: `Execution by "${d.executorName}" went stale — may have crashed`,
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

  const notify: NotifyFn = useCallback((message, level = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev.slice(-4), { id, message, level }]); // cap at 5
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 6000);
  }, []);

  notifyRef.current = notify;

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Subscribe to user-level SSE — receives events from all user's projects
  useEffect(() => {
    const es = new EventSource('/api/user-events');

    for (const type of ALL_EVENT_TYPES) {
      es.addEventListener(type, (e: Event) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as Record<string, unknown>;
          const handler = EVENT_HANDLERS[type];
          if (!handler) return;
          const result = handler(data);
          if (!result) return;
          const pfx = data.projectName ? `[${data.projectName as string}] ` : '';
          notifyRef.current?.(pfx + result.msg, result.level);
        } catch {
          // ignore malformed payloads
        }
      });
    }

    es.onerror = () => {
      // EventSource auto-reconnects; ignore transient errors (e.g. not logged in)
    };

    return () => es.close();
  }, []); // run once on mount — user identity doesn't change mid-session

  return (
    <NotifyContext.Provider value={notify}>
      {children}
      {/* Toast container — top-right, stacked, max 5 */}
      <div aria-live="polite" className="fixed right-4 top-4 z-50 flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </NotifyContext.Provider>
  );
}
