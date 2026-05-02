'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { Alert } from '@/components/ui/alert';

type TaskActionsProps = {
  projectId: string;
  taskId: string;
  canRebind: boolean;
  canClaim: boolean;
  canDecline?: boolean;
  className?: string;
};

type Action = 'rebind' | 'claim' | 'decline';

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
  const [pending, setPending] = useState<Action | null>(null);
  const [claimAssigneeType, setClaimAssigneeType] = useState<'human' | 'agent'>('human');
  const [error, setError] = useState<{ action: Action; message: string } | null>(null);

  async function run(action: Action) {
    setError(null);
    setPending(action);
    try {
      const url =
        action === 'rebind'
          ? `/api/projects/${projectId}/tasks/${taskId}/rebind`
          : action === 'claim'
            ? `/api/projects/${projectId}/tasks/${taskId}/claim`
            : `/api/projects/${projectId}/tasks/${taskId}/decline`;
      const init: RequestInit = {
        method: 'POST',
        credentials: 'include',
        ...(action === 'claim'
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ assigneeType: claimAssigneeType }),
            }
          : {}),
      };
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(await parseError(res));
      router.refresh();
    } catch (e) {
      setError({ action, message: e instanceof Error ? e.message : `${action} failed` });
    } finally {
      setPending(null);
    }
  }

  if (!canRebind && !canClaim && !canDecline) {
    return null;
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        {canRebind && (
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => void run('rebind')}
            className="btn-secondary text-xs"
            aria-label="Rebind task to active plan"
          >
            {pending === 'rebind' ? <Spinner size="xs" /> : null}
            {pending === 'rebind' ? 'Rebinding…' : 'Rebind to active plan'}
          </button>
        )}
        {canClaim && (
          <>
            <select
              className="select-field !py-1 !text-xs w-auto"
              value={claimAssigneeType}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'human' || v === 'agent') setClaimAssigneeType(v);
              }}
              disabled={pending !== null}
              aria-label="Claim as human or agent"
            >
              <option value="human">Claim as Human</option>
              <option value="agent">Claim as Agent</option>
            </select>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void run('claim')}
              className="btn-primary text-xs"
            >
              {pending === 'claim' ? (
                <Spinner size="xs" className="text-primary-foreground" />
              ) : null}
              {pending === 'claim' ? 'Claiming…' : 'Claim task'}
            </button>
          </>
        )}
        {canDecline && (
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => void run('decline')}
            className="btn-ghost text-xs hover:!text-danger"
          >
            {pending === 'decline' ? <Spinner size="xs" /> : null}
            {pending === 'decline' ? 'Declining…' : 'Decline'}
          </button>
        )}
      </div>
      {error && (
        <Alert intent="danger" live>
          <div className="flex items-center justify-between gap-2">
            <span>{error.message}</span>
            <button
              type="button"
              onClick={() => void run(error.action)}
              className="shrink-0 underline underline-offset-2 hover:no-underline"
            >
              Retry
            </button>
          </div>
        </Alert>
      )}
    </div>
  );
}
