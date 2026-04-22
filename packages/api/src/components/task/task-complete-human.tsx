'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';

type TaskCompleteHumanProps = {
  projectId: string;
  taskId: string;
};

export function TaskCompleteHuman({ projectId, taskId }: TaskCompleteHumanProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [prUrl, setPrUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${taskId}/complete-human`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          completionNote: note.trim(),
          prUrl: prUrl.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || 'Failed to complete task');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to complete task');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 overflow-hidden">
      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-emerald-50/60 transition-colors"
      >
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          <span className="text-sm font-medium text-emerald-800">Complete Task</span>
          <span className="text-xs text-emerald-600">— add a completion note and mark done</span>
        </div>
        {open ? (
          <ChevronUp className="h-4 w-4 text-emerald-400" />
        ) : (
          <ChevronDown className="h-4 w-4 text-emerald-400" />
        )}
      </button>

      {/* Expandable form */}
      {open && (
        <form
          onSubmit={handleSubmit}
          className="px-4 pb-4 space-y-3 border-t border-emerald-200/60"
        >
          <div className="pt-3">
            <label className="text-xs font-medium text-slate-600 mb-1.5 block">
              Completion Note <span className="text-rose-500">*</span>
            </label>
            <textarea
              autoFocus
              rows={4}
              className="input-field w-full resize-none"
              placeholder="What did you accomplish? What changed? Any notes for the team…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              required
              maxLength={5000}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-slate-600 mb-1.5 block">
              PR / Branch URL <span className="text-slate-400">(optional)</span>
            </label>
            <input
              type="url"
              className="input-field w-full"
              placeholder="https://github.com/org/repo/pull/123"
              value={prUrl}
              onChange={(e) => setPrUrl(e.target.value)}
            />
          </div>

          {error && <p className="text-sm text-rose-600">{error}</p>}

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
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
              {saving ? 'Completing…' : 'Mark as Done'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
