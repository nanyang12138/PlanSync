'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Trash2, Bot, User, Shield, AlertTriangle, CheckCircle2, Circle } from 'lucide-react';
import type { ProjectMember, Task } from '@prisma/client';
import { cn } from '@/lib/utils';

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
  return role === 'owner' ? 'badge-violet' : 'badge-neutral';
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
  const [error, setError] = useState<string | null>(null);

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
      setError(e instanceof Error ? e.message : 'Remove failed');
    } finally {
      setPendingId(null);
    }
  }

  if (members.length === 0) {
    return (
      <div className="p-10 text-center">
        <p className="text-sm text-slate-400">No members yet.</p>
      </div>
    );
  }

  return (
    <div className={cn('', className)}>
      <div className="divide-y divide-slate-100">
        {members.map((m) => {
          const isAgent = m.type === 'agent';

          return (
            <div
              key={m.id}
              className="flex items-center justify-between p-4 hover:bg-slate-50/80 transition-colors"
            >
              <div className="flex items-center gap-4 min-w-0">
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                    showStatus && m.status === 'drift'
                      ? 'bg-amber-100 text-amber-600'
                      : showStatus && m.status === 'active'
                        ? 'bg-emerald-100 text-emerald-600'
                        : 'bg-slate-100 text-slate-500'
                  }`}
                >
                  {isAgent ? <Bot className="h-5 w-5" /> : <User className="h-5 w-5" />}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold text-slate-900">{m.name}</p>
                    {m.role === 'owner' && <Shield className="h-3.5 w-3.5 text-blue-500" />}
                    <span className={cn('badge capitalize text-[10px]', typeBadgeClass(m.type))}>
                      {m.type}
                    </span>
                    <span className={cn('badge capitalize text-[10px]', roleBadgeClass(m.role))}>
                      {m.role}
                    </span>
                  </div>

                  {showStatus && m.status && (
                    <div className="flex items-center gap-1.5 mt-1">
                      {m.status === 'drift' && (
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                      )}
                      {m.status === 'active' && (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                      )}
                      {m.status === 'idle' && <Circle className="h-3.5 w-3.5 text-slate-400" />}
                      <span
                        className={`text-xs truncate ${
                          m.status === 'drift' ? 'text-amber-600 font-medium' : 'text-slate-500'
                        }`}
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
                    <div className="text-xs text-slate-500 mt-1">
                      Joined {formatJoined(m.createdAt)}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3 ml-4 shrink-0">
                {m.role !== 'owner' && (
                  <button
                    type="button"
                    className="btn-ghost !text-rose-500 hover:!bg-rose-50 !px-2"
                    disabled={pendingId !== null}
                    onClick={() => void removeMember(m.id)}
                    aria-label={`Remove ${m.name}`}
                    title="Remove member"
                  >
                    {pendingId === m.id ? '...' : <Trash2 className="h-4 w-4" />}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {error && <p className="text-sm text-rose-600 px-5 py-2">{error}</p>}
    </div>
  );
}
