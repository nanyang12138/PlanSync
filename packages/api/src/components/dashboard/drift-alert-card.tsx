import type { DriftAlert, Task } from '@prisma/client';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DriftAlertActions } from '@/components/dashboard/drift-alert-actions';

type DriftAlertCardProps = {
  alert: DriftAlert;
  task: Task;
  projectId: string;
};

function severityStyles(severity: string) {
  const s = severity.toLowerCase();
  if (s === 'high') {
    return 'border-destructive/40 bg-destructive/10 text-destructive dark:text-destructive-foreground';
  }
  if (s === 'medium') {
    return 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200';
  }
  return 'border-blue-500/40 bg-blue-500/10 text-blue-900 dark:text-blue-200';
}

export function DriftAlertCard({ alert, task, projectId }: DriftAlertCardProps) {
  const assignee =
    task.assignee && task.assigneeType !== 'unassigned'
      ? `${task.assignee}${task.assigneeType === 'agent' ? ' (agent)' : ''}`
      : 'Unassigned';

  return (
    <div
      className={cn(
        'rounded-xl border p-4 shadow-sm',
        'border-border bg-card text-card-foreground',
      )}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" />
            <span
              className={cn(
                'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-bold uppercase tracking-wide',
                severityStyles(alert.severity),
              )}
            >
              {alert.severity.toUpperCase()}
            </span>
            <span className="text-xs text-muted-foreground">
              Plan v{alert.currentPlanVersion} vs task v{alert.taskBoundVersion}
            </span>
          </div>
          <div>
            <p className="font-medium leading-snug">{task.title}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Assignee: <span className="text-foreground">{assignee}</span>
            </p>
          </div>
          <p className="text-sm text-muted-foreground">{alert.reason}</p>
        </div>
        <DriftAlertActions projectId={projectId} driftId={alert.id} className="lg:min-w-[220px]" />
      </div>
    </div>
  );
}
