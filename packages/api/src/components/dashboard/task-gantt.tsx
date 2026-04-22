'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Task } from '@prisma/client';

type TaskGanttProps = {
  tasks: Task[];
  projectId: string;
};

const STATUS_COLOR: Record<string, string> = {
  done: 'bg-emerald-400',
  in_progress: 'bg-blue-400',
  blocked: 'bg-amber-400',
  todo: 'bg-slate-300',
  cancelled: 'bg-slate-200',
};

const STATUS_LABEL: Record<string, string> = {
  done: 'Done',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  todo: 'Todo',
  cancelled: 'Cancelled',
};

function toDay(date: Date): number {
  return Math.floor(
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 86_400_000,
  );
}

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatMonth(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
}

export function TaskGantt({ tasks, projectId }: TaskGanttProps) {
  const [tooltip, setTooltip] = useState<string | null>(null);

  const tasksWithDates = tasks.filter((t) => t.startDate && t.dueDate);
  const tasksWithout = tasks.filter((t) => !t.startDate || !t.dueDate);

  if (tasksWithDates.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-slate-400">
        <p>No tasks have start/due dates set.</p>
        <p className="mt-1 text-xs">Open a task to add timeline dates.</p>
      </div>
    );
  }

  const allDates = tasksWithDates.flatMap((t) => [t.startDate!, t.dueDate!]);
  const rangeStart = new Date(Math.min(...allDates.map((d) => d.getTime())));
  const rangeEnd = new Date(Math.max(...allDates.map((d) => d.getTime())));
  rangeStart.setDate(rangeStart.getDate() - 2);
  rangeEnd.setDate(rangeEnd.getDate() + 2);

  const totalDays = toDay(rangeEnd) - toDay(rangeStart) || 1;
  const today = new Date();
  const todayPct = Math.max(
    0,
    Math.min(100, ((toDay(today) - toDay(rangeStart)) / totalDays) * 100),
  );
  const showToday = toDay(today) >= toDay(rangeStart) && toDay(today) <= toDay(rangeEnd);

  const months: { label: string; pct: number }[] = [];
  const cur = new Date(rangeStart);
  cur.setDate(1);
  while (cur <= rangeEnd) {
    const pct = ((toDay(cur) - toDay(rangeStart)) / totalDays) * 100;
    if (pct >= 0 && pct <= 100) {
      months.push({ label: formatMonth(cur), pct });
    }
    cur.setMonth(cur.getMonth() + 1);
  }

  return (
    <div className="space-y-3">
      <div className="relative h-5 ml-40">
        {months.map((m) => (
          <span
            key={m.label}
            className="absolute text-[10px] text-slate-400 -translate-x-1/2"
            style={{ left: `${m.pct}%` }}
          >
            {m.label}
          </span>
        ))}
      </div>

      <div className="space-y-1.5">
        {tasksWithDates.map((task) => {
          const start = toDay(task.startDate!) - toDay(rangeStart);
          const duration = toDay(task.dueDate!) - toDay(task.startDate!) || 1;
          const leftPct = (start / totalDays) * 100;
          const widthPct = Math.max((duration / totalDays) * 100, 0.5);
          const color = STATUS_COLOR[task.status] ?? 'bg-slate-300';

          return (
            <div key={task.id} className="flex items-center gap-2">
              <Link
                href={`/projects/${projectId}/tasks/${task.id}`}
                className="w-40 shrink-0 text-xs text-slate-700 hover:text-blue-600 transition-colors truncate text-right pr-2"
                title={task.title}
              >
                {task.title}
              </Link>
              <div className="relative flex-1 h-6 rounded bg-slate-100 overflow-visible">
                {showToday && (
                  <div
                    className="absolute top-0 bottom-0 w-px bg-red-400 z-10"
                    style={{ left: `${todayPct}%` }}
                    title="Today"
                  />
                )}
                <div
                  className={`absolute top-1 h-4 rounded cursor-pointer ${color} hover:opacity-80 transition-opacity`}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                  onMouseEnter={() => setTooltip(task.id)}
                  onMouseLeave={() => setTooltip(null)}
                >
                  {tooltip === task.id && (
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-20 w-48 rounded-lg bg-slate-900 text-white text-[11px] p-2.5 shadow-xl pointer-events-none">
                      <p className="font-semibold mb-1 truncate">{task.title}</p>
                      <p className="text-slate-300">{STATUS_LABEL[task.status]}</p>
                      {task.assignee && <p className="text-slate-300">@{task.assignee}</p>}
                      <p className="text-slate-400 mt-1">
                        {formatDate(task.startDate!)} → {formatDate(task.dueDate!)}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-3 pt-2 border-t border-slate-100">
        {Object.entries(STATUS_LABEL).map(([status, label]) => (
          <span key={status} className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <span className={`inline-block h-2.5 w-2.5 rounded-sm ${STATUS_COLOR[status]}`} />
            {label}
          </span>
        ))}
        {showToday && (
          <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <span className="inline-block h-2.5 w-px bg-red-400" />
            Today
          </span>
        )}
      </div>

      {tasksWithout.length > 0 && (
        <div className="pt-2 border-t border-slate-100">
          <p className="text-[11px] text-slate-400 mb-1.5">
            {tasksWithout.length} task{tasksWithout.length > 1 ? 's' : ''} without dates:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {tasksWithout.map((t) => (
              <Link
                key={t.id}
                href={`/projects/${projectId}/tasks/${t.id}`}
                className="text-[11px] text-slate-500 hover:text-blue-600 underline decoration-dotted transition-colors"
              >
                {t.title}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
