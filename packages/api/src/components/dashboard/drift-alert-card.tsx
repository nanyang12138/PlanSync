import type { DriftAlert, Task } from '@prisma/client';
import { Bot, User, ChevronRight } from 'lucide-react';
import { DriftAlertActions } from '@/components/dashboard/drift-alert-actions';

type DriftAlertCardProps = {
  alert: DriftAlert;
  task: Task;
  projectId: string;
  isOwner: boolean;
};

export function DriftAlertCard({ alert, task, projectId, isOwner }: DriftAlertCardProps) {
  const isAgent = task.assigneeType === 'agent';
  const severityClass =
    alert.severity === 'high'
      ? 'badge-danger'
      : alert.severity === 'medium'
        ? 'badge-drift'
        : 'badge-brand';

  return (
    <div
      role="alert"
      aria-live="polite"
      aria-label={`Drift alert (${alert.severity} severity) on task ${task.title}: bound to v${alert.taskBoundVersion}, current plan v${alert.currentPlanVersion}`}
      className="rounded-lg p-3 border border-drift/25 bg-surface-1 shadow-sm"
    >
      <div className="flex items-center gap-2 mb-2">
        <div
          className="flex h-5 w-5 items-center justify-center rounded-md bg-surface-2 shrink-0"
          aria-hidden
        >
          {isAgent ? (
            <Bot className="h-3 w-3 text-agent" />
          ) : (
            <User className="h-3 w-3 text-fg-subtle" />
          )}
        </div>
        <span className="text-xs font-medium text-fg">{task.assignee || 'Unassigned'}</span>
        <span className="text-xs text-fg-subtle truncate">{task.title}</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <span
          className="badge badge-drift font-mono"
          aria-label={`Bound to plan version ${alert.taskBoundVersion}`}
        >
          v{alert.taskBoundVersion}
        </span>
        <ChevronRight className="h-3 w-3 text-fg-subtle" aria-hidden />
        <span
          className="badge badge-brand font-mono"
          aria-label={`Current plan version ${alert.currentPlanVersion}`}
        >
          v{alert.currentPlanVersion}
        </span>
        <span
          className={`ml-auto badge ${severityClass}`}
          aria-label={`Severity ${alert.severity}`}
        >
          {alert.severity}
        </span>
      </div>
      <DriftAlertActions projectId={projectId} driftId={alert.id} isOwner={isOwner} />
    </div>
  );
}
