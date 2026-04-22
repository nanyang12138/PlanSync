'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, X, Loader2 } from 'lucide-react';
import { TASK_TYPES, TASK_PRIORITIES } from '@plansync/shared';

type NewTaskButtonProps = {
  projectId: string;
  memberNames: string[];
  disabled?: boolean;
  disabledReason?: string;
};

export function NewTaskButton({
  projectId,
  memberNames,
  disabled = false,
  disabledReason,
}: NewTaskButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState('code');
  const [priority, setPriority] = useState('p1');
  const [assignee, setAssignee] = useState('');
  const [startDate, setStartDate] = useState('');
  const [dueDate, setDueDate] = useState('');

  function reset() {
    setTitle('');
    setDescription('');
    setType('code');
    setPriority('p1');
    setAssignee('');
    setStartDate('');
    setDueDate('');
    setError('');
  }

  function handleClose() {
    setOpen(false);
    reset();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (startDate && dueDate && new Date(startDate) > new Date(dueDate)) {
      setError('Start date must be on or before due date');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          type,
          priority,
          assignee: assignee || undefined,
          assigneeType: assignee ? 'human' : 'unassigned',
          startDate: startDate || undefined,
          dueDate: dueDate || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          handleClose();
          router.push('/login');
          return;
        }
        throw new Error(data?.error?.message || 'Failed to create task');
      }
      handleClose();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create task');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        onClick={() => {
          if (disabled) return;
          setOpen(true);
        }}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        className="btn-primary text-xs gap-1"
      >
        <Plus className="h-3.5 w-3.5" />
        New Task
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={(e) => e.target === e.currentTarget && handleClose()}
        >
          <div className="panel w-full max-w-lg p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold text-slate-900">New Task</h2>
              <button onClick={handleClose} className="btn-ghost !p-1.5">
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="text-xs font-medium text-slate-600 mb-1 block">Title *</label>
                <input
                  autoFocus
                  className="input-field w-full"
                  placeholder="e.g. Implement user auth endpoint"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  maxLength={200}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-slate-600 mb-1 block">Type *</label>
                  <select
                    className="select-field w-full"
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                  >
                    {TASK_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-600 mb-1 block">Priority</label>
                  <select
                    className="select-field w-full"
                    value={priority}
                    onChange={(e) => setPriority(e.target.value)}
                  >
                    {TASK_PRIORITIES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600 mb-1 block">Assignee</label>
                <select
                  className="select-field w-full"
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                >
                  <option value="">Unassigned</option>
                  {memberNames.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-slate-600 mb-1 block">
                    Start Date
                  </label>
                  <input
                    type="date"
                    className="input-field w-full"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-600 mb-1 block">Due Date</label>
                  <input
                    type="date"
                    className="input-field w-full"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600 mb-1 block">Description</label>
                <textarea
                  className="input-field w-full resize-none"
                  rows={3}
                  placeholder="Optional task description…"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={5000}
                />
              </div>
              {error && <p className="text-sm text-rose-600">{error}</p>}
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={handleClose} className="btn-secondary">
                  Cancel
                </button>
                <button type="submit" disabled={loading || !title.trim()} className="btn-primary">
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  {loading ? 'Creating…' : 'Create Task'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
