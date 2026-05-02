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
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Delete project ${projectName}`}
        className="btn-ghost hover:!text-danger hover:!bg-danger-soft !px-2 !py-1.5"
        title={`Delete "${projectName}"`}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
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
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-project-title"
            aria-describedby="delete-project-desc"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-danger-soft text-danger-soft-fg"
                  aria-hidden
                >
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div>
                  <p id="delete-project-title" className="text-sm font-semibold text-fg">
                    Delete project?
                  </p>
                  <p id="delete-project-desc" className="text-xs text-fg-subtle mt-0.5">
                    This action cannot be undone.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={loading}
                aria-label="Close dialog"
                className="btn-ghost !p-1 shrink-0"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>

            {/* Project name */}
            <div className="rounded-lg border border-subtle bg-surface-2 px-3 py-2 mb-4">
              <p className="text-xs text-fg-subtle mb-0.5">Project</p>
              <p className="text-sm font-medium text-fg truncate">{projectName}</p>
            </div>

            {error && (
              <div className="mb-3 text-xs text-danger-soft-fg" role="alert">
                {error}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={loading}
                className="btn-secondary text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={loading}
                className="btn-danger text-xs gap-1.5"
              >
                {loading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
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
