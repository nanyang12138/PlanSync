'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Action = 'rebind' | 'cancel' | 'no_impact';

type DriftAlertActionsProps = {
  projectId: string;
  driftId: string;
  className?: string;
};

export function DriftAlertActions({ projectId, driftId, className }: DriftAlertActionsProps) {
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
    <div className={cn('space-y-2', className)}>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="default"
          disabled={pending !== null}
          onClick={() => resolve('rebind')}
        >
          {pending === 'rebind' ? '…' : 'Rebind'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending !== null}
          onClick={() => resolve('no_impact')}
        >
          {pending === 'no_impact' ? '…' : 'No impact'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={pending !== null}
          onClick={() => resolve('cancel')}
        >
          {pending === 'cancel' ? '…' : 'Cancel task'}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
