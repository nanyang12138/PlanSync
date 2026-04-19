'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, CheckCheck, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

interface ActivityItem {
  id: string;
  projectId: string;
  projectName: string;
  type: string;
  actorName: string;
  actorType: string;
  summary: string;
  metadata: unknown;
  createdAt: string;
  unread: boolean;
}

interface FeedResponse {
  data: ActivityItem[];
  unreadCount: number;
  lastSeenActivityAt: string | null;
}

const POLL_FALLBACK_MS = 300_000;

const TYPE_ICON: Record<string, string> = {
  plan_created: '📝',
  plan_proposed: '📋',
  plan_activated: '✅',
  plan_draft_updated: '✏️',
  drift_detected: '⚠️',
  drift_resolved: '✓',
  task_created: '➕',
  task_assigned: '👤',
  task_unassigned: '↩️',
  task_started: '▶️',
  task_completed: '✓',
  execution_stale: '⏸',
  suggestion_created: '💡',
  suggestion_resolved: '✓',
  comment_added: '💬',
  member_added: '👥',
  member_removed: '👋',
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchFeed = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/user-activities?limit=50', { credentials: 'include' });
      if (!res.ok) return;
      const data = (await res.json()) as FeedResponse;
      setFeed(data);
    } catch {
      // network / auth failures are silent — bell just won't update
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + 5 min fallback poll in case SSE drops silently. SSE keeps
  // the badge live in steady state, so polling is just a safety net.
  useEffect(() => {
    fetchFeed();
    const id = setInterval(fetchFeed, POLL_FALLBACK_MS);
    return () => clearInterval(id);
  }, [fetchFeed]);

  // Live increments via SSE: bump unreadCount locally without re-fetching the
  // full list. The list is only re-fetched when the dropdown opens, so a busy
  // project can fire many events without hammering /api/user-activities.
  useEffect(() => {
    const es = new EventSource('/api/user-events');
    const bump = () => {
      setFeed((prev) => (prev ? { ...prev, unreadCount: prev.unreadCount + 1 } : prev));
    };
    const types = [
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
    for (const t of types) es.addEventListener(t, bump);
    es.onerror = () => {
      // EventSource auto-reconnects
    };
    return () => es.close();
  }, []);

  // close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  const markAllRead = useCallback(async () => {
    try {
      await fetch('/api/user-activities/mark-read', {
        method: 'POST',
        credentials: 'include',
      });
      await fetchFeed();
    } catch {
      // silent
    }
  }, [fetchFeed]);

  const unread = feed?.unreadCount ?? 0;
  const items = feed?.data ?? [];

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => {
            const next = !v;
            if (next) fetchFeed(); // refresh list only when opening
            return next;
          });
        }}
        aria-label="Notifications"
        className="relative flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span
            className={cn(
              'absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full',
              'bg-red-500 px-1 text-[10px] font-semibold leading-none text-white',
            )}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notification inbox"
          className="absolute right-0 top-10 z-50 w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
            <div className="text-sm font-semibold text-slate-700">
              Notifications
              {unread > 0 && (
                <span className="ml-2 text-xs font-normal text-slate-500">({unread} unread)</span>
              )}
            </div>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loading && items.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-slate-400">Loading…</div>
            ) : items.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-slate-400">
                No activity in the last 7 days
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className={cn(
                      'flex gap-3 px-4 py-3 text-sm',
                      item.unread ? 'bg-blue-50/40' : 'bg-white',
                    )}
                  >
                    <span className="shrink-0 text-base leading-tight">
                      {TYPE_ICON[item.type] ?? '•'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs text-slate-500">
                            <Link
                              href={`/projects/${item.projectId}`}
                              className="font-medium text-slate-700 hover:text-blue-600"
                              onClick={() => setOpen(false)}
                            >
                              {item.projectName}
                            </Link>
                            <span className="mx-1.5 text-slate-300">·</span>
                            {relativeTime(item.createdAt)}
                          </div>
                          <p className="mt-0.5 text-sm text-slate-700">{item.summary}</p>
                          <div className="mt-0.5 text-xs text-slate-400">
                            {item.actorName} · {item.type}
                          </div>
                        </div>
                        {item.unread && (
                          <span
                            aria-label="unread"
                            className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full bg-blue-500"
                          />
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex items-center justify-end border-t border-slate-100 px-4 py-2 text-xs">
            <Link
              href="/"
              onClick={() => setOpen(false)}
              className="flex items-center gap-1 text-slate-500 hover:text-slate-700"
            >
              All projects <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
