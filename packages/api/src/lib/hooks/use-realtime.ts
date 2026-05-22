'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

type EventHandler = (eventType: string, data: unknown) => void;

export type UseRealtimeOptions = {
  /**
   * @deprecated R-089: SSE no longer accepts `?token=`. Browser callers must
   * rely on the `plansync-apikey` cookie (set by the login flow). This field
   * is retained only to avoid breaking existing typed call sites and is
   * ignored at runtime.
   */
  token?: string;
  /** User name for SSE when auth is enabled (sent as ?user=) */
  userName?: string;
};

export function useRealtime(
  projectId: string,
  onEvent?: EventHandler,
  options?: UseRealtimeOptions,
) {
  const router = useRouter();
  const eventSourceRef = useRef<EventSource | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const search = new URLSearchParams();
    if (options?.userName) search.set('user', options.userName);
    const qs = search.toString();
    const url = qs
      ? `/api/projects/${projectId}/events?${qs}`
      : `/api/projects/${projectId}/events`;

    const es = new EventSource(url, { withCredentials: true });
    eventSourceRef.current = es;

    const eventTypes = [
      'plan_created',
      'plan_proposed',
      'plan_activated',
      'plan_draft_updated',
      'drift_detected',
      'drift_resolved',
      'task_created',
      'task_assigned',
      'task_started',
      'task_completed',
      'execution_stale',
      'suggestion_created',
      'suggestion_resolved',
      'comment_added',
      'member_added',
      'member_removed',
    ];

    for (const type of eventTypes) {
      es.addEventListener(type, (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          onEventRef.current?.(type, data);
        } catch {
          // Ignore malformed SSE payloads
        }
        router.refresh();
      });
    }

    es.onerror = () => {
      // EventSource auto-reconnects
    };

    return () => {
      es.close();
    };
  }, [projectId, router, options?.userName]);

  return eventSourceRef;
}
