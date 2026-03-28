'use client';

import type { ReactNode } from 'react';
import { useRealtime, type UseRealtimeOptions } from '@/lib/hooks/use-realtime';

export function RealtimeWrapper({
  projectId,
  children,
  sseAuth,
}: {
  projectId: string;
  children: ReactNode;
  /** Optional ?token=&user= for EventSource when PLANSYNC auth is enabled */
  sseAuth?: UseRealtimeOptions;
}) {
  useRealtime(projectId, undefined, sseAuth);
  return <>{children}</>;
}
