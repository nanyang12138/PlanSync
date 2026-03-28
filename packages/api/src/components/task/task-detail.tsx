import type { Plan, Task } from '@prisma/client';
import { AlertTriangle, User } from 'lucide-react';
import { cn } from '@/lib/utils';

export type TaskDetailProps = {
  task: Task;
  activePlan: Plan | null;
};

function statusBadgeClass(status: string) {
  switch (status) {
    case 'done':
      return 'border-emerald-600/30 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300';
    case 'in_progress':
      return 'border-primary/30 bg-primary/10 text-primary';
    case 'blocked':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200';
    case 'cancelled':
      return 'border-border bg-muted text-muted-foreground';
    case 'todo':
    default:
      return 'border-border bg-muted/80 text-foreground';
  }
}

function priorityBadgeClass(priority: string) {
  switch (priority) {
    case 'p0':
      return 'border-destructive/40 bg-destructive/10 text-destructive';
    case 'p2':
      return 'border-border bg-muted text-muted-foreground';
    case 'p1':
    default:
      return 'border-border bg-muted/80 text-foreground';
  }
}

function assigneeLabel(task: Task) {
  if (!task.assignee || task.assigneeType === 'unassigned') {
    return { text: 'Unassigned', sub: null as string | null };
  }
  return {
    text: task.assignee,
    sub: task.assigneeType === 'agent' ? 'Agent' : 'Human',
  };
}

export function TaskDetail({ task, activePlan }: TaskDetailProps) {
  const assignee = assigneeLabel(task);
  const activeVersion = activePlan?.version;
  const hasDrift = activeVersion !== undefined && task.boundPlanVersion !== activeVersion;

  return (
    <section
      className={cn('rounded-xl border border-border bg-card p-6 text-card-foreground shadow-sm')}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <h1 className="text-2xl font-bold leading-tight">{task.title}</h1>
            {task.description && (
              <p className="text-sm text-muted-foreground">{task.description}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide',
                statusBadgeClass(task.status),
              )}
            >
              {task.status.replace('_', ' ')}
            </span>
            <span
              className={cn(
                'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold uppercase',
                priorityBadgeClass(task.priority),
              )}
            >
              {task.priority.toUpperCase()}
            </span>
            <span className="rounded-md border border-border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground">
              {task.type}
            </span>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/20 p-3">
            <User className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <p className="text-xs font-medium uppercase text-muted-foreground">Assignee</p>
              <p className="font-medium">{assignee.text}</p>
              {assignee.sub && <p className="text-xs text-muted-foreground">{assignee.sub}</p>}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <p className="text-xs font-medium uppercase text-muted-foreground">Assignee type</p>
            <p className="font-medium capitalize">{task.assigneeType}</p>
          </div>

          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <p className="text-xs font-medium uppercase text-muted-foreground">Bound plan</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-sm">
                v{task.boundPlanVersion}
              </span>
              {activePlan && (
                <span className="text-xs text-muted-foreground">Active: v{activePlan.version}</span>
              )}
            </div>
            {hasDrift && (
              <p
                className={cn(
                  'mt-2 flex items-center gap-1.5 text-xs font-medium',
                  'text-amber-900 dark:text-amber-200',
                )}
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                Task is bound to a different version than the active plan.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
