'use client';

import { useState } from 'react';
import { List, GanttChart } from 'lucide-react';
import type { Task } from '@prisma/client';
import { TaskList } from './task-list';
import { TaskGantt } from './task-gantt';

type TaskViewToggleProps = {
  tasks: Task[];
  projectId: string;
  activePlanVersion?: number;
};

export function TaskViewToggle({ tasks, projectId, activePlanVersion }: TaskViewToggleProps) {
  const [view, setView] = useState<'list' | 'timeline'>('list');

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <div className="flex rounded-lg border border-slate-200 overflow-hidden">
          <button
            onClick={() => setView('list')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${view === 'list' ? 'bg-blue-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
            title="List view"
          >
            <List className="h-3.5 w-3.5" />
            List
          </button>
          <button
            onClick={() => setView('timeline')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-l border-slate-200 ${view === 'timeline' ? 'bg-blue-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
            title="Timeline / Gantt view"
          >
            <GanttChart className="h-3.5 w-3.5" />
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
