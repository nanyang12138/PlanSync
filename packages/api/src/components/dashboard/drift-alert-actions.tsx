'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Action = 'rebind' | 'cancel' | 'no_impact';

type DriftAlertActionsProps = {
  projectId: string;
  driftId: string;
  isOwner: boolean;
};

export function DriftAlertActions({ projectId, driftId, isOwner }: DriftAlertActionsProps) {
  const router = useRouter();
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resolve(action: Action) {
    setError(null);
    setPending(action);
    try {
      const res = await fetch(`/api/projects/${projectId}/drifts/${driftId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
        credentials: 'include',
      });
      if (!res.ok) {
        if (res.status === 401) {
          router.push('/login');
          return;
        }
        const body = (await res.json().catch(() => ({}))) as {
          error?: string | { message?: string };
        };
        const err = body?.error;
        const msg =
          typeof err === 'string'
            ? err
            : typeof err === 'object' && err?.message
              ? err.message
              : `Request failed (${res.status})`;
        throw new Error(msg);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setPending(null);
    }
  }

  return (
    <div>
      {isOwner && (
        <div className="flex gap-2 mt-1.5">
          <button
            onClick={() => resolve('rebind')}
            disabled={pending !== null}
            className="btn-primary !py-1 !px-2.5 !text-[11px]"
          >
            {pending === 'rebind' ? '...' : 'Rebind'}
          </button>
          <button
            onClick={() => resolve('cancel')}
            disabled={pending !== null}
            className="btn-secondary !py-1 !px-2.5 !text-[11px]"
          >
            {pending === 'cancel' ? '...' : 'Cancel'}
          </button>
          <button
            onClick={() => resolve('no_impact')}
            disabled={pending !== null}
            className="btn-secondary !py-1 !px-2.5 !text-[11px]"
          >
            {pending === 'no_impact' ? '...' : 'No Impact'}
          </button>
        </div>
      )}
      {error && <p className="text-xs text-rose-600 mt-1.5">{error}</p>}
    </div>
  );
}
