import type { DriftAlert, Task } from '@prisma/client';
import { Bot, User, ChevronRight } from 'lucide-react';
import { DriftAlertActions } from '@/components/dashboard/drift-alert-actions';

type DriftAlertCardProps = {
  alert: DriftAlert;
  task: Task;
  projectId: string;
};

export function DriftAlertCard({ alert, task, projectId }: DriftAlertCardProps) {
  const isAgent = task.assigneeType === 'agent';

  return (
    <div className="rounded-lg p-3 border border-amber-200/60 bg-white shadow-sm">
      <div className="flex items-center gap-2 mb-2">
        <div className="flex h-5 w-5 items-center justify-center rounded-md bg-slate-100 shrink-0">
          {isAgent ? (
            <Bot className="h-3 w-3 text-violet-400" />
          ) : (
            <User className="h-3 w-3 text-slate-400" />
          )}
        </div>
        <span className="text-xs font-medium text-slate-700">{task.assignee || 'Unassigned'}</span>
        <span className="text-xs text-slate-400 truncate">{task.title}</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <span className="badge badge-warning font-mono text-[10px]">v{alert.taskBoundVersion}</span>
        <ChevronRight className="h-3 w-3 text-slate-300" />
        <span className="badge badge-brand font-mono text-[10px]">v{alert.currentPlanVersion}</span>
        <span
          className={`ml-auto badge text-[10px] ${
            alert.severity === 'high'
              ? 'badge-danger'
              : alert.severity === 'medium'
                ? 'badge-warning'
                : 'badge-brand'
          }`}
        >
          {alert.severity}
        </span>
      </div>
      <DriftAlertActions projectId={projectId} driftId={alert.id} />
    </div>
  );
}
