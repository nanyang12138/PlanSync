import type { Plan, Task } from '@prisma/client';
import { AlertTriangle, Bot, User, Calendar } from 'lucide-react';

export type TaskDetailProps = {
  task: Task;
  activePlan: Plan | null;
};

function statusStyle(status: string) {
  switch (status) {
    case 'done':
      return 'badge-success';
    case 'in_progress':
      return 'badge-brand';
    case 'blocked':
      return 'badge-warning';
    case 'cancelled':
      return 'badge-neutral';
    default:
      return 'badge-neutral';
  }
}

export function TaskDetail({ task, activePlan }: TaskDetailProps) {
  const isAgent = task.assigneeType === 'agent';
  const activeVersion = activePlan?.version;
  const hasDrift = activeVersion !== undefined && task.boundPlanVersion !== activeVersion;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-slate-900">{task.title}</h1>
          {task.description && (
            <p className="mt-1.5 text-sm text-slate-500 leading-relaxed">{task.description}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`badge uppercase ${statusStyle(task.status)}`}>
            {task.status.replace('_', ' ')}
          </span>
          <span className="badge badge-neutral uppercase">{task.priority}</span>
          <span className="badge badge-neutral">{task.type}</span>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50/50 p-4">
          <div className="w-9 h-9 rounded-lg bg-white border border-slate-200 flex items-center justify-center shrink-0 shadow-sm">
            {isAgent ? (
              <Bot className="h-4 w-4 text-violet-400" />
            ) : (
              <User className="h-4 w-4 text-slate-400" />
            )}
          </div>
          <div className="min-w-0">
            <p className="section-label">Assignee</p>
            <p className="text-sm font-medium text-slate-700 truncate mt-0.5">
              {task.assignee || 'Unassigned'}
            </p>
            {task.assigneeType !== 'unassigned' && (
              <span
                className={`badge text-[10px] mt-1 ${isAgent ? 'badge-violet' : 'badge-neutral'}`}
              >
                {isAgent ? 'Agent' : 'Human'}
              </span>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
          <p className="section-label">Bound Plan</p>
          <div className="flex items-center gap-2 mt-1.5">
            <span className="badge badge-brand font-mono">v{task.boundPlanVersion}</span>
            {activePlan && (
              <span className="text-xs text-slate-400">Active: v{activePlan.version}</span>
            )}
          </div>
          {hasDrift && (
            <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-amber-600">
              <AlertTriangle className="h-3.5 w-3.5" />
              Version mismatch with active plan
            </p>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
          <p className="section-label">Created</p>
          <div className="flex items-center gap-1.5 mt-1.5">
            <Calendar className="h-3.5 w-3.5 text-slate-400" />
            <p className="text-sm text-slate-700">
              {task.createdAt.toLocaleDateString(undefined, { dateStyle: 'medium' })}
            </p>
          </div>
          {task.createdBy && <p className="text-xs text-slate-400 mt-1">by {task.createdBy}</p>}
        </div>
      </div>
    </div>
  );
}
