'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, X, Save, Loader2 } from 'lucide-react';
import type { Task } from '@prisma/client';
import { TASK_TYPES, TASK_PRIORITIES } from '@plansync/shared';

type TaskEditorProps = {
  task: Task;
  projectId: string;
  memberNames: string[];
};

export function TaskEditor({ task, projectId, memberNames }: TaskEditorProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [type, setType] = useState(task.type);
  const [priority, setPriority] = useState(task.priority);
  const [assignee, setAssignee] = useState(task.assignee ?? '');

  function handleCancel() {
    setTitle(task.title);
    setDescription(task.description ?? '');
    setType(task.type);
    setPriority(task.priority);
    setAssignee(task.assignee ?? '');
    setError('');
    setEditing(false);
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || null,
          type,
          priority,
          assignee: assignee || null,
          assigneeType: assignee ? 'human' : 'unassigned',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || 'Failed to save');
      setEditing(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="btn-ghost text-xs gap-1.5"
        title="Edit task"
      >
        <Pencil className="h-3.5 w-3.5" />
        Edit
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/30 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-blue-700 uppercase tracking-wide">
          Editing Task
        </span>
        <button onClick={handleCancel} className="btn-ghost !p-1">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div>
        <label className="text-xs font-medium text-slate-600 mb-1 block">Title *</label>
        <input
          className="input-field w-full"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={200}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-slate-600 mb-1 block">Type</label>
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

      <div>
        <label className="text-xs font-medium text-slate-600 mb-1 block">Description</label>
        <textarea
          className="input-field w-full resize-none"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={5000}
          placeholder="Optional description…"
        />
      </div>

      {error && <p className="text-sm text-rose-600">{error}</p>}

      <div className="flex gap-2">
        <button onClick={handleCancel} className="btn-secondary text-xs">
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving || !title.trim()}
          className="btn-primary text-xs gap-1.5"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}
