'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Trash2,
  Bot,
  User,
  Shield,
  AlertTriangle,
  CheckCircle2,
  Circle,
  UsersRound,
} from 'lucide-react';
import type { ProjectMember, Task } from '@prisma/client';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { Alert } from '@/components/ui/alert';
import { EmptyState } from '@/components/shared/empty-state';

export type MemberListProps = {
  members: (ProjectMember & {
    status?: 'drift' | 'active' | 'idle';
    currentTask?: Pick<Task, 'title'> | null;
  })[];
  projectId: string;
  className?: string;
  showStatus?: boolean;
};

function roleBadgeClass(role: string) {
  return role === 'owner' ? 'badge-agent' : 'badge-neutral';
}

function typeBadgeClass(type: string) {
  return type === 'agent' ? 'badge-brand' : 'badge-neutral';
}

function formatJoined(d: Date) {
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

async function parseError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: string | { message?: string; code?: string };
  };
  const err = body?.error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && err.message) return err.message;
  return `Request failed (${res.status})`;
}

export function MemberList({ members, projectId, className, showStatus = false }: MemberListProps) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<{ memberId: string; message: string } | null>(null);

  async function removeMember(memberId: string) {
    setError(null);
    setPendingId(memberId);
    try {
      const res = await fetch(`/api/projects/${projectId}/members/${memberId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await parseError(res));
      router.refresh();
    } catch (e) {
      setError({ memberId, message: e instanceof Error ? e.message : 'Remove failed' });
    } finally {
      setPendingId(null);
    }
  }

  if (members.length === 0) {
    return (
      <EmptyState
        variant="compact"
        icon={<UsersRound className="h-6 w-6" />}
        title="No members yet"
      />
    );
  }

  return (
    <div className={cn('', className)}>
      <div className="divide-y divide-subtle">
        {members.map((m) => {
          const isAgent = m.type === 'agent';
          const isPending = pendingId === m.id;
          const memberError = error?.memberId === m.id ? error.message : null;

          return (
            <div
              key={m.id}
              className="flex flex-col gap-2 p-4 hover:bg-surface-2/60 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4 min-w-0">
                  <div
                    className={cn(
                      'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
                      showStatus && m.status === 'drift'
                        ? 'bg-drift-soft text-drift-soft-fg'
                        : showStatus && m.status === 'active'
                          ? 'bg-success-soft text-success-soft-fg'
                          : 'bg-surface-2 text-fg-muted',
                    )}
                    aria-hidden
                  >
                    {isAgent ? <Bot className="h-5 w-5" /> : <User className="h-5 w-5" />}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold text-fg">{m.name}</p>
                      {m.role === 'owner' && (
                        <Shield className="h-3.5 w-3.5 text-primary" aria-label="Owner" />
                      )}
                      <span className={cn('badge capitalize', typeBadgeClass(m.type))}>
                        {m.type}
                      </span>
                      <span className={cn('badge capitalize', roleBadgeClass(m.role))}>
                        {m.role}
                      </span>
                    </div>

                    {showStatus && m.status && (
                      <div className="flex items-center gap-1.5 mt-1">
                        {m.status === 'drift' && (
                          <AlertTriangle className="h-3.5 w-3.5 text-drift" aria-hidden />
                        )}
                        {m.status === 'active' && (
                          <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden />
                        )}
                        {m.status === 'idle' && (
                          <Circle className="h-3.5 w-3.5 text-fg-subtle" aria-hidden />
                        )}
                        <span
                          className={cn(
                            'text-xs truncate',
                            m.status === 'drift'
                              ? 'text-drift-soft-fg font-medium'
                              : 'text-fg-muted',
                          )}
                        >
                          {m.status === 'drift'
                            ? 'Blocked by Plan Drift'
                            : m.status === 'active' && m.currentTask
                              ? `Working on: ${m.currentTask.title}`
                              : m.status === 'active'
                                ? 'Working'
                                : 'Idle'}
                        </span>
                      </div>
                    )}
                    {!showStatus && (
                      <div className="text-xs text-fg-muted mt-1">
                        Joined {formatJoined(m.createdAt)}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3 ml-4 shrink-0">
                  {m.role !== 'owner' && (
                    <button
                      type="button"
                      className="btn-ghost hover:!text-danger hover:!bg-danger-soft !px-2"
                      disabled={isPending}
                      onClick={() => void removeMember(m.id)}
                      aria-label={`Remove ${m.name}`}
                      title="Remove member"
                    >
                      {isPending ? (
                        <Spinner size="xs" label={`Removing ${m.name}`} />
                      ) : (
                        <Trash2 className="h-4 w-4" aria-hidden />
                      )}
                    </button>
                  )}
                </div>
              </div>
              {memberError && (
                <Alert intent="danger" live className="ml-14">
                  <div className="flex items-center justify-between gap-2">
                    <span>{memberError}</span>
                    <button
                      type="button"
                      onClick={() => void removeMember(m.id)}
                      className="shrink-0 underline underline-offset-2 hover:no-underline"
                    >
                      Retry
                    </button>
                  </div>
                </Alert>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
