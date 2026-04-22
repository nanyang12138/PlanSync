'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Calendar, Save } from 'lucide-react';

type TaskDatesEditorProps = {
  projectId: string;
  taskId: string;
  startDate: Date | null;
  dueDate: Date | null;
};

function toInputValue(date: Date | null): string {
  if (!date) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function TaskDatesEditor({ projectId, taskId, startDate, dueDate }: TaskDatesEditorProps) {
  const router = useRouter();
  const [start, setStart] = useState(toInputValue(startDate));
  const [due, setDue] = useState(toInputValue(dueDate));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const isDirty = start !== toInputValue(startDate) || due !== toInputValue(dueDate);

  async function handleSave() {
    if (start && due && start > due) {
      setError('Start date must be on or before due date');
      return;
    }
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ startDate: start || null, dueDate: due || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || 'Failed to save dates');
      }
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save dates');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <Calendar className="h-4 w-4 text-slate-400" />
        <p className="section-label">Timeline Dates</p>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-slate-500 mb-1 block">Start Date</label>
          <input
            type="date"
            value={start}
            onChange={(e) => {
              setStart(e.target.value);
              setSaved(false);
            }}
            className="input-field w-full"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-500 mb-1 block">Due Date</label>
          <input
            type="date"
            value={due}
            onChange={(e) => {
              setDue(e.target.value);
              setSaved(false);
            }}
            className="input-field w-full"
          />
        </div>
      </div>
      {error && <p className="text-xs text-rose-600">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving || !isDirty}
          className="btn-secondary text-xs gap-1.5"
        >
          <Save className="h-3.5 w-3.5" />
          {saving ? 'Saving…' : 'Save Dates'}
        </button>
        {saved && <span className="text-xs text-emerald-600">✓ Saved</span>}
      </div>
    </div>
  );
}
