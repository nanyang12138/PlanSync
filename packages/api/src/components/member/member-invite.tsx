'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type MemberInviteProps = {
  projectId: string;
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

export function MemberInvite({ projectId, className }: MemberInviteProps) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [role, setRole] = useState<'owner' | 'developer'>('developer');
  const [type, setType] = useState<'human' | 'agent'>('human');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: name.trim(), role, type }),
      });
      if (!res.ok) throw new Error(await parseError(res));
      setName('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add member');
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className={cn(
        'rounded-xl border border-border bg-card p-6 text-card-foreground shadow-sm',
        className,
      )}
    >
      <div className="mb-4 flex items-center gap-2">
        <UserPlus className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">Add member</h2>
      </div>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label htmlFor="member-name" className="text-sm font-medium">
              Name
            </label>
            <input
              id="member-name"
              type="text"
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={pending}
              className={cn(
                'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm',
                'ring-offset-background placeholder:text-muted-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
              placeholder="Display name"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="member-role" className="text-sm font-medium">
              Role
            </label>
            <select
              id="member-role"
              value={role}
              onChange={(e) => setRole(e.target.value as 'owner' | 'developer')}
              disabled={pending}
              className={cn(
                'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm',
                'ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <option value="developer">Developer</option>
              <option value="owner">Owner</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="member-type" className="text-sm font-medium">
              Type
            </label>
            <select
              id="member-type"
              value={type}
              onChange={(e) => setType(e.target.value as 'human' | 'agent')}
              disabled={pending}
              className={cn(
                'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm',
                'ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <option value="human">Human</option>
              <option value="agent">Agent</option>
            </select>
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={pending || !name.trim()}>
          {pending ? 'Adding…' : 'Add member'}
        </Button>
      </form>
    </section>
  );
}
