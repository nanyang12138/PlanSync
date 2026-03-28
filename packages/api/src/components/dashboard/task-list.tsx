import Link from 'next/link';
import type { Task } from '@prisma/client';
import { AlertTriangle, CheckCircle2, Circle, CircleSlash, Loader2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

type TaskListProps = {
  tasks: Task[];
  activePlanVersion: number | undefined;
  projectId: string;
};

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'in_progress':
      return <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />;
    case 'done':
      return (
        <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
      );
    case 'cancelled':
      return <XCircle className="h-4 w-4 text-muted-foreground" aria-hidden />;
    case 'blocked':
      return <CircleSlash className="h-4 w-4 text-amber-600" aria-hidden />;
    case 'todo':
    default:
      return <Circle className="h-4 w-4 text-muted-foreground" aria-hidden />;
  }
}

function assigneeLabel(task: Task) {
  if (!task.assignee || task.assigneeType === 'unassigned') return '—';
  return task.assigneeType === 'agent' ? `${task.assignee} (agent)` : task.assignee;
}

export function TaskList({ tasks, activePlanVersion, projectId }: TaskListProps) {
  if (tasks.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
        No tasks yet.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border bg-muted/40">
          <tr>
            <th className="px-4 py-3 font-medium text-muted-foreground">Status</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Task</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Assignee</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Bound plan</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Drift</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {tasks.map((task) => {
            const drift =
              activePlanVersion !== undefined && task.boundPlanVersion !== activePlanVersion;

            return (
              <tr key={task.id} className="bg-card transition-colors hover:bg-muted/30">
                <td className="px-4 py-3 align-middle">
                  <span className="inline-flex items-center justify-center" title={task.status}>
                    <StatusIcon status={task.status} />
                  </span>
                </td>
                <td className="px-4 py-3 align-middle">
                  <Link
                    href={`/projects/${projectId}/tasks/${task.id}`}
                    className="font-medium text-foreground hover:underline"
                  >
                    {task.title}
                  </Link>
                </td>
                <td className="px-4 py-3 align-middle text-muted-foreground">
                  {assigneeLabel(task)}
                </td>
                <td className="px-4 py-3 align-middle">
                  <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs">
                    v{task.boundPlanVersion}
                  </span>
                </td>
                <td className="px-4 py-3 align-middle">
                  {drift ? (
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md border border-amber-500/40',
                        'bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-900 dark:text-amber-200',
                      )}
                    >
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Out of sync
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
