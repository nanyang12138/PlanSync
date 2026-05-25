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
      // Closes #817: the R-205 withdraw route publishes 'plan_withdrawn'
      // so other connected users see the proposal disappear in real time.
      // Browsers listening only for the previous events used to keep
      // showing the proposed plan until manual refresh.
      'plan_withdrawn',
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
      // #323 / #310: synthetic resync event the EventBusPG dispatches to
      // every local subscriber after a Postgres reconnect. NOTIFY messages
      // emitted while the listenClient was offline are dropped by Postgres,
      // so the bus tells consumers to refetch canonical state. Without
      // this listener, named-event browsers never see it (it does NOT
      // fall back to onmessage) and the UI keeps showing stale data after
      // every database reconnect.
      'bus_resync_required',
    ];

    for (const type of eventTypes) {
      es.addEventListener(type, (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          onEventRef.current?.(type, data);
        } catch {
          // Ignore malformed SSE payloads
        }
        // bus_resync_required deliberately falls through to router.refresh()
        // — that's literally the point of the event. Other event types
        // already trigger a refresh below.
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
