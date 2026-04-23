'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { cn } from '@/lib/utils';

type TaskActionsProps = {
  projectId: string;
  taskId: string;
  canRebind: boolean;
  canClaim: boolean;
  canDecline?: boolean;
  className?: string;
};

async function parseError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: string | { message?: string; code?: string };
  };
  const err = body?.error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && err.message) return err.message;
  return `Request failed (${res.status})`;
}

export function TaskActions({
  projectId,
  taskId,
  canRebind,
  canClaim,
  canDecline,
  className,
}: TaskActionsProps) {
  const router = useRouter();
  const [pending, setPending] = useState<'rebind' | 'claim' | 'decline' | null>(null);
  const [claimAssigneeType, setClaimAssigneeType] = useState<'human' | 'agent'>('human');
  const [error, setError] = useState<string | null>(null);

  async function rebind() {
    setError(null);
    setPending('rebind');
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${taskId}/rebind`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await parseError(res));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rebind failed');
    } finally {
      setPending(null);
    }
  }

  async function claim() {
    setError(null);
    setPending('claim');
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${taskId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ assigneeType: claimAssigneeType }),
      });
      if (!res.ok) throw new Error(await parseError(res));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Claim failed');
    } finally {
      setPending(null);
    }
  }

  async function decline() {
    setError(null);
    setPending('decline');
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${taskId}/decline`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await parseError(res));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Decline failed');
    } finally {
      setPending(null);
    }
  }

  if (!canRebind && !canClaim && !canDecline) {
    return null;
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {canRebind && (
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void rebind()}
          className="btn-secondary text-xs"
        >
          {pending === 'rebind' ? '…' : 'Rebind to active plan'}
        </button>
      )}
      {canClaim && (
        <>
          <select
            className="select-field !py-1 !text-xs w-auto"
            value={claimAssigneeType}
            onChange={(e) => setClaimAssigneeType(e.target.value as 'human' | 'agent')}
            disabled={pending !== null}
            title="Claim as"
          >
            <option value="human">Claim as Human</option>
            <option value="agent">Claim as Agent</option>
          </select>
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => void claim()}
            className="btn-primary text-xs"
          >
            {pending === 'claim' ? '…' : 'Claim task'}
          </button>
        </>
      )}
      {canDecline && (
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void decline()}
          className="btn-ghost text-xs !text-slate-400 hover:!text-red-500 hover:!bg-red-50"
        >
          {pending === 'decline' ? '…' : 'Decline'}
        </button>
      )}
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </div>
  );
}
