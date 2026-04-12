'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Plus, X } from 'lucide-react';

export function NewProjectButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Track client mount to safely use createPortal (document.body unavailable during SSR)
  useEffect(() => setMounted(true), []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error?.message || 'Failed to create project');
        return;
      }
      router.push(`/projects/${data.data.id}/plans`);
      router.refresh();
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  function handleClose() {
    setOpen(false);
    setName('');
    setDescription('');
    setError('');
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn-primary">
        <Plus className="h-4 w-4" />
        New Project
      </button>

      {open &&
        mounted &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
            onClick={(e) => e.target === e.currentTarget && handleClose()}
          >
            <div className="panel w-full max-w-md p-6 shadow-2xl">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-base font-semibold text-slate-900">New Project</h2>
                <button
                  type="button"
                  onClick={handleClose}
                  className="rounded-lg p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="section-label mb-1.5 block">Project Name *</label>
                  <input
                    autoFocus
                    className="input-field w-full"
                    placeholder="e.g. GPU Verification Q3"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={100}
                    required
                  />
                </div>

                <div>
                  <label className="section-label mb-1.5 block">Description</label>
                  <textarea
                    className="input-field w-full resize-none"
                    rows={3}
                    placeholder="What is this project about?"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={2000}
                  />
                </div>

                {error && <p className="text-sm text-rose-600">{error}</p>}

                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={handleClose} className="btn-secondary">
                    Cancel
                  </button>
                  <button type="submit" disabled={loading || !name.trim()} className="btn-primary">
                    {loading ? 'Creating…' : 'Create Project'}
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
