'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';

export function DeleteProjectButton({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleDelete() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
      if (!res.ok) {
        if (res.status === 401) {
          router.push('/login');
          return;
        }
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || 'Failed to delete project');
      }
      router.push('/');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete project');
      setLoading(false);
      setConfirming(false);
    }
  }

  if (error) {
    return (
      <span className="text-xs text-red-500 max-w-[120px] truncate" title={error}>
        {error}
      </span>
    );
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-slate-500 hidden md:inline">Sure?</span>
        <button
          onClick={() => setConfirming(false)}
          disabled={loading}
          className="btn-secondary !px-2 !py-1 text-xs"
        >
          No
        </button>
        <button
          onClick={handleDelete}
          disabled={loading}
          className="btn-danger !px-2 !py-1 text-xs"
        >
          {loading ? '…' : 'Yes, delete'}
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="btn-ghost !text-slate-400 hover:!text-red-500 hover:!bg-red-50 !px-2 !py-1.5"
      title={`Delete "${projectName}"`}
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}
