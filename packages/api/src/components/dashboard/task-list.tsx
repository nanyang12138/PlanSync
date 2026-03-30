import Link from 'next/link';
import type { Task } from '@prisma/client';
import { AlertTriangle, Bot, User, ArrowUpRight } from 'lucide-react';

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
    <div className="divide-y divide-slate-100">
      {tasks.map((t) => {
        const drift = activePlanVersion !== undefined && t.boundPlanVersion !== activePlanVersion;
        const label = statusLabel(t, drift);
        const isAgent = t.assigneeType === 'agent';

        return (
          <Link
            key={t.id}
            href={`/projects/${projectId}/tasks/${t.id}`}
            className="group flex items-center px-5 py-3 gap-4 text-sm hover:bg-slate-50/80 transition-colors"
          >
            <span className="font-mono text-slate-400 w-12 flex-shrink-0 text-xs">
              {t.id.slice(-6)}
            </span>
            <span
              className={`font-medium flex-1 min-w-0 truncate ${t.status === 'cancelled' ? 'text-slate-400 line-through' : 'text-slate-700'}`}
            >
              {t.title}
            </span>
            <div className="hidden sm:flex items-center gap-1.5 w-28 flex-shrink-0">
              {isAgent ? (
                <Bot className="h-3.5 w-3.5 text-violet-400" />
              ) : t.assignee ? (
                <User className="h-3.5 w-3.5 text-slate-400" />
              ) : null}
              <span className="text-slate-500 truncate text-xs">{t.assignee || '—'}</span>
            </div>
            <span className="badge badge-brand font-mono text-[10px] hidden sm:inline-flex">
              v{t.boundPlanVersion}
            </span>
            {drift && <AlertTriangle className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" />}
            <span className={`badge text-[10px] whitespace-nowrap ${label.cls}`}>{label.text}</span>
            <ArrowUpRight className="h-3.5 w-3.5 text-slate-300 group-hover:text-blue-500 transition-colors shrink-0 hidden sm:block" />
          </Link>
        );
      })}
    </div>
  );
}
