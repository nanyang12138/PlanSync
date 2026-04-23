'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2, AlertTriangle, X, Loader2 } from 'lucide-react';

export function DeleteProjectButton({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

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
      setOpen(false);
      router.push('/');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete project');
      setLoading(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="btn-ghost !text-slate-400 hover:!text-red-500 hover:!bg-red-50 !px-2 !py-1.5"
        title={`Delete "${projectName}"`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 backdrop-blur-sm"
          onClick={() => {
            if (!loading) setOpen(false);
          }}
        >
          <div
            className="panel w-full max-w-sm p-6 shadow-2xl mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-50">
                  <AlertTriangle className="h-5 w-5 text-red-500" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-900">Delete project?</p>
                  <p className="text-xs text-slate-400 mt-0.5">This action cannot be undone.</p>
                </div>
              </div>
              <button
                onClick={() => setOpen(false)}
                disabled={loading}
                className="btn-ghost !p-1 shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Project name */}
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 mb-4">
              <p className="text-xs text-slate-400 mb-0.5">Project</p>
              <p className="text-sm font-medium text-slate-800 truncate">{projectName}</p>
            </div>

            {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

            {/* Actions */}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setOpen(false)}
                disabled={loading}
                className="btn-secondary text-xs"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={loading}
                className="btn-danger text-xs gap-1.5"
              >
                {loading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                {loading ? 'Deleting…' : 'Delete project'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
