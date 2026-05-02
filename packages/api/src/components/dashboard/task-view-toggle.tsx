'use client';

import { useEffect, useState } from 'react';
import { List, GanttChart } from 'lucide-react';
import type { Task } from '@prisma/client';
import { TaskList } from './task-list';
import { TaskGantt } from './task-gantt';
import { cn } from '@/lib/utils';

type TaskViewToggleProps = {
  tasks: Task[];
  projectId: string;
  activePlanVersion?: number;
};

// Tailwind `md` breakpoint = 768px. Below this, the Gantt's fixed 40-char
// title column + h-6 bars become unusable. Force list view.
const GANTT_MIN_WIDTH = 768;

export function TaskViewToggle({ tasks, projectId, activePlanVersion }: TaskViewToggleProps) {
  const [view, setView] = useState<'list' | 'timeline'>('list');
  const [canUseGantt, setCanUseGantt] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${GANTT_MIN_WIDTH}px)`);
    const apply = () => setCanUseGantt(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // If the user is on the Gantt and the viewport shrinks, fall back automatically.
  useEffect(() => {
    if (!canUseGantt && view === 'timeline') setView('list');
  }, [canUseGantt, view]);

  const ganttDisabled = !canUseGantt;

  return (
    <div className="space-y-3">
      <div className="flex justify-end" role="tablist" aria-label="Task view">
        <div className="flex rounded-lg border border-subtle overflow-hidden">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'list'}
            onClick={() => setView('list')}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors',
              view === 'list'
                ? 'bg-primary text-primary-foreground'
                : 'bg-surface-1 text-fg-muted hover:bg-surface-2',
            )}
            title="List view"
          >
            <List className="h-3.5 w-3.5" aria-hidden />
            List
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'timeline'}
            aria-disabled={ganttDisabled}
            onClick={() => !ganttDisabled && setView('timeline')}
            disabled={ganttDisabled}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-l border-subtle',
              view === 'timeline'
                ? 'bg-primary text-primary-foreground'
                : 'bg-surface-1 text-fg-muted hover:bg-surface-2',
              ganttDisabled && 'opacity-50 cursor-not-allowed hover:bg-surface-1',
            )}
            title={
              ganttDisabled
                ? 'Timeline / Gantt requires a wider viewport (≥ 768px)'
                : 'Timeline / Gantt view'
            }
          >
            <GanttChart className="h-3.5 w-3.5" aria-hidden />
            Timeline
          </button>
        </div>
      </div>
      {view === 'list' ? (
        <TaskList tasks={tasks} activePlanVersion={activePlanVersion} projectId={projectId} />
      ) : (
        <TaskGantt tasks={tasks} projectId={projectId} />
      )}
    </div>
  );
}
