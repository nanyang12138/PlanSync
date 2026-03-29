'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { cn } from '@/lib/utils';

type TaskActionsProps = {
  projectId: string;
  taskId: string;
  canRebind: boolean;
  canClaim: boolean;
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
  className,
}: TaskActionsProps) {
  const router = useRouter();
  const [pending, setPending] = useState<'rebind' | 'claim' | null>(null);
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

  if (!canRebind && !canClaim) {
    return null;
  }

  return (
    <div
      className={cn('space-y-3 rounded-xl border border-slate-200 bg-slate-50/50 p-4', className)}
    >
      <div className="flex flex-wrap items-end gap-4">
        {canRebind && (
          <div className="space-y-1.5">
            <p className="section-label">Plan alignment</p>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void rebind()}
              className="btn-primary"
            >
              {pending === 'rebind' ? '...' : 'Rebind to active plan'}
            </button>
          </div>
        )}
        {canClaim && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <label htmlFor="claim-assignee-type" className="section-label">
                Claim as
              </label>
              <select
                id="claim-assignee-type"
                className="select-field w-auto"
                value={claimAssigneeType}
                onChange={(e) => setClaimAssigneeType(e.target.value as 'human' | 'agent')}
                disabled={pending !== null}
              >
                <option value="human">Human</option>
                <option value="agent">Agent</option>
              </select>
            </div>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void claim()}
              className="btn-secondary"
            >
              {pending === 'claim' ? '...' : 'Claim task'}
            </button>
          </div>
        )}
      </div>
      {error && <p className="text-sm text-rose-600">{error}</p>}
    </div>
  );
}
