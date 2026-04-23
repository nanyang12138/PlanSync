import Link from 'next/link';
import type { Task } from '@prisma/client';
import { AlertTriangle, Bot, User, ArrowUpRight } from 'lucide-react';
import { TaskCompleteQuick } from '@/components/task/task-complete-quick';

type TaskListProps = {
  tasks: Task[];
  activePlanVersion: number | undefined;
  projectId: string;
};

function statusLabel(task: Task, drift: boolean) {
  if (drift) return { text: 'Drifted', cls: 'badge-warning' };
  switch (task.status) {
    case 'in_progress':
      return { text: 'In Progress', cls: 'badge-brand' };
    case 'done':
      return { text: 'Complete', cls: 'badge-success' };
    case 'cancelled':
      return { text: 'Cancelled', cls: 'badge-danger' };
    case 'blocked':
      return { text: 'Blocked', cls: 'badge-warning' };
    default:
      return { text: 'Todo', cls: 'badge-neutral' };
  }
}

export function TaskList({ tasks, activePlanVersion, projectId }: TaskListProps) {
  if (tasks.length === 0) {
    return <p className="px-5 py-10 text-sm text-slate-400 italic text-center">No tasks yet.</p>;
  }

  return (
    <div className="divide-y divide-slate-100 text-sm">
      {tasks.map((t, index) => {
        const drift = activePlanVersion !== undefined && t.boundPlanVersion !== activePlanVersion;
        const label = statusLabel(t, drift);
        const isAgent = t.assigneeType === 'agent';

        return (
          <Link
            key={t.id}
            href={`/projects/${projectId}/tasks/${t.id}`}
            className="group grid grid-cols-[2rem_1fr_auto_auto_1.25rem_auto_2rem_1.5rem] sm:grid-cols-[2rem_1fr_7rem_3rem_1.25rem_6rem_2rem_1.5rem] items-center gap-2 px-5 py-3 hover:bg-slate-50/80 transition-colors"
          >
            {/* # */}
            <span className="text-right text-xs text-slate-400 tabular-nums">#{index + 1}</span>

            {/* Title */}
            <span
              className={`font-medium truncate ${t.status === 'cancelled' ? 'text-slate-400 line-through' : 'text-slate-700'}`}
            >
              {t.title}
            </span>

            {/* Assignee */}
            <span className="hidden sm:flex items-center gap-1.5 min-w-0">
              {isAgent ? (
                <Bot className="h-3.5 w-3.5 text-violet-400 shrink-0" />
              ) : t.assignee ? (
                <User className="h-3.5 w-3.5 text-slate-400 shrink-0" />
              ) : null}
              <span className="text-xs text-slate-500 truncate">{t.assignee || '—'}</span>
            </span>

            {/* Plan version */}
            <span className="hidden sm:inline-flex justify-center">
              <span className="badge badge-brand font-mono text-[10px]">v{t.boundPlanVersion}</span>
            </span>

            {/* Drift */}
            <span className="hidden sm:flex justify-center">
              {drift && <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
            </span>

            {/* Status */}
            <span className="flex justify-center">
              <span className={`badge text-[10px] whitespace-nowrap ${label.cls}`}>
                {label.text}
              </span>
            </span>

            {/* Quick complete */}
            <span className="hidden sm:flex justify-center">
              {(t.status === 'in_progress' || t.status === 'todo') &&
                !!t.assignee &&
                t.assigneeType !== 'agent' && (
                  <TaskCompleteQuick projectId={projectId} taskId={t.id} />
                )}
            </span>

            {/* Arrow */}
            <span className="hidden sm:inline-flex justify-end">
              <ArrowUpRight className="h-3.5 w-3.5 text-slate-300 group-hover:text-blue-500 transition-colors" />
            </span>
          </Link>
        );
      })}
    </div>
  );
}
