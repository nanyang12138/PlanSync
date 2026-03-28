'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Trash2, Users } from 'lucide-react';
import type { ProjectMember } from '@prisma/client';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type MemberListProps = {
  members: ProjectMember[];
  projectId: string;
  className?: string;
};

function roleBadgeClass(role: string) {
  return role === 'owner'
    ? 'border-violet-500/40 bg-violet-500/10 text-violet-900 dark:text-violet-200'
    : 'border-border bg-muted text-foreground';
}

function typeBadgeClass(type: string) {
  return type === 'agent'
    ? 'border-sky-500/40 bg-sky-500/10 text-sky-900 dark:text-sky-200'
    : 'border-border bg-muted/80 text-muted-foreground';
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
      <p className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
        No members yet.
      </p>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-muted/40">
            <tr>
              <th className="px-4 py-3 font-medium text-muted-foreground">Name</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Role</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Type</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Joined</th>
              <th className="px-4 py-3 font-medium text-muted-foreground w-28">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {members.map((m) => (
              <tr key={m.id} className="bg-card transition-colors hover:bg-muted/30">
                <td className="px-4 py-3 align-middle font-medium">{m.name}</td>
                <td className="px-4 py-3 align-middle">
                  <span
                    className={cn(
                      'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold capitalize',
                      roleBadgeClass(m.role),
                    )}
                  >
                    {m.role}
                  </span>
                </td>
                <td className="px-4 py-3 align-middle">
                  <span
                    className={cn(
                      'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold capitalize',
                      typeBadgeClass(m.type),
                    )}
                  >
                    {m.type}
                  </span>
                </td>
                <td className="px-4 py-3 align-middle text-muted-foreground">
                  {formatJoined(m.createdAt)}
                </td>
                <td className="px-4 py-3 align-middle">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="text-destructive hover:bg-destructive/10"
                    disabled={pendingId !== null}
                    onClick={() => void removeMember(m.id)}
                    aria-label={`Remove ${m.name}`}
                  >
                    {pendingId === m.id ? (
                      '…'
                    ) : (
                      <>
                        <Trash2 className="h-4 w-4" />
                        <span className="sr-only sm:not-sr-only sm:ml-1">Remove</span>
                      </>
                    )}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

export function MemberListHeader({ className }: { className?: string }) {
  return (
    <div className={cn('mb-3 flex items-center gap-2', className)}>
      <Users className="h-5 w-5 text-primary" />
      <h2 className="text-lg font-semibold">Members</h2>
    </div>
  );
}
