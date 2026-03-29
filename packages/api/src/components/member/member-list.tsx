'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { ProjectMember } from '@prisma/client';
import { cn } from '@/lib/utils';

export type MemberListProps = {
  members: ProjectMember[];
  projectId: string;
  className?: string;
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

export function MemberList({ members, projectId, className }: MemberListProps) {
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
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-100 bg-slate-50/80">
          <tr>
            <th className="px-5 py-3 font-medium text-xs text-slate-500 uppercase tracking-wider">
              Name
            </th>
            <th className="px-5 py-3 font-medium text-xs text-slate-500 uppercase tracking-wider">
              Role
            </th>
            <th className="px-5 py-3 font-medium text-xs text-slate-500 uppercase tracking-wider">
              Type
            </th>
            <th className="px-5 py-3 font-medium text-xs text-slate-500 uppercase tracking-wider">
              Joined
            </th>
            <th className="px-5 py-3 font-medium text-xs text-slate-500 uppercase tracking-wider w-24"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {members.map((m) => (
            <tr key={m.id} className="hover:bg-slate-50/80 transition-colors">
              <td className="px-5 py-3.5 align-middle font-medium text-slate-700">{m.name}</td>
              <td className="px-5 py-3.5 align-middle">
                <span className={cn('badge capitalize', roleBadgeClass(m.role))}>{m.role}</span>
              </td>
              <td className="px-5 py-3.5 align-middle">
                <span className={cn('badge capitalize', typeBadgeClass(m.type))}>{m.type}</span>
              </td>
              <td className="px-5 py-3.5 align-middle text-slate-500 text-xs">
                {formatJoined(m.createdAt)}
              </td>
              <td className="px-5 py-3.5 align-middle">
                <button
                  type="button"
                  className="btn-danger !py-1 !px-2.5"
                  disabled={pendingId !== null}
                  onClick={() => void removeMember(m.id)}
                  aria-label={`Remove ${m.name}`}
                >
                  {pendingId === m.id ? '...' : <Trash2 className="h-3.5 w-3.5" />}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p className="text-sm text-rose-600 px-5 py-2">{error}</p>}
    </div>
  );
}
