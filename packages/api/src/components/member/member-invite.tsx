'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { UserPlus } from 'lucide-react';
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
    <div className={cn('panel p-6', className)}>
      <div className="mb-5 flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50">
          <UserPlus className="h-4 w-4 text-blue-500" />
        </div>
        <h2 className="text-base font-semibold text-slate-900">Add member</h2>
      </div>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label htmlFor="member-name" className="text-sm font-medium text-slate-700">
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
              className="input-field"
              placeholder="Display name"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="member-role" className="text-sm font-medium text-slate-700">
              Role
            </label>
            <select
              id="member-role"
              value={role}
              onChange={(e) => setRole(e.target.value as 'owner' | 'developer')}
              disabled={pending}
              className="select-field"
            >
              <option value="developer">Developer</option>
              <option value="owner">Owner</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="member-type" className="text-sm font-medium text-slate-700">
              Type
            </label>
            <select
              id="member-type"
              value={type}
              onChange={(e) => setType(e.target.value as 'human' | 'agent')}
              disabled={pending}
              className="select-field"
            >
              <option value="human">Human</option>
              <option value="agent">Agent</option>
            </select>
          </div>
        </div>
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <button type="submit" disabled={pending || !name.trim()} className="btn-primary">
          {pending ? 'Adding...' : 'Add member'}
        </button>
      </form>
    </div>
  );
}
