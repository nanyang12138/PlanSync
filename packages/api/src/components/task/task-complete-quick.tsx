'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Loader2, X } from 'lucide-react';

type TaskCompleteQuickProps = {
  projectId: string;
  taskId: string;
};

export function TaskCompleteQuick({ projectId, taskId }: TaskCompleteQuickProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${taskId}/complete-human`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ completionNote: note.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || 'Failed');
      setOpen(false);
      setNote('');
      router.refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed');
      setSaving(false);
    }
  }

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        title="Mark as done"
        onClick={() => setOpen(true)}
        className="flex items-center justify-center h-6 w-6 rounded-full text-slate-300 hover:text-emerald-500 hover:bg-emerald-50 transition-colors"
      >
        <CheckCircle2 className="h-4 w-4" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm">
          <div className="panel w-full max-w-sm p-5 shadow-2xl mx-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <span className="text-sm font-semibold text-slate-900">Complete Task</span>
              </div>
              <button
                onClick={() => {
                  setOpen(false);
                  setNote('');
                  setError('');
                }}
                className="btn-ghost !p-1"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="text-xs font-medium text-slate-600 mb-1.5 block">
                  Completion Note <span className="text-rose-500">*</span>
                </label>
                <textarea
                  autoFocus
                  rows={3}
                  className="input-field w-full resize-none"
                  placeholder="What did you accomplish?"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  required
                  maxLength={5000}
                />
              </div>
              {error && <p className="text-xs text-rose-600">{error}</p>}
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setNote('');
                    setError('');
                  }}
                  className="btn-secondary text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !note.trim()}
                  className="btn-primary text-xs gap-1.5 !bg-emerald-600 hover:!bg-emerald-700"
                >
                  {saving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  )}
                  {saving ? 'Saving…' : 'Mark Done'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
