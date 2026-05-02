'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Task } from '@prisma/client';
import { CalendarRange } from 'lucide-react';
import { EmptyState } from '@/components/shared/empty-state';

type TaskGanttProps = {
  tasks: Task[];
  projectId: string;
};

const STATUS_COLOR: Record<string, string> = {
  done: 'bg-success',
  in_progress: 'bg-primary',
  blocked: 'bg-warning',
  todo: 'bg-surface-3',
  cancelled: 'bg-surface-2',
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
      <EmptyState
        variant="compact"
        icon={<CalendarRange className="h-6 w-6" />}
        title="No tasks have start/due dates set"
        description="Open a task to add timeline dates."
      />
    );
  }

  const allDates = tasksWithDates.flatMap((t) => [t.startDate!, t.dueDate!]);
  const rangeStart = new Date(Math.min(...allDates.map((d) => d.getTime())));
  const rangeEnd = new Date(Math.max(...allDates.map((d) => d.getTime())));
  rangeStart.setDate(rangeStart.getDate() - 2);
  rangeEnd.setDate(rangeEnd.getDate() + 2);

  const rawDays = toDay(rangeEnd) - toDay(rangeStart);
  const totalDays = Number.isFinite(rawDays) && rawDays > 0 ? rawDays : 1;
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
      <div className="relative h-5 ml-40" aria-hidden>
        {months.map((m) => (
          <span
            key={m.label}
            className="absolute text-[10px] text-fg-subtle -translate-x-1/2"
            style={{ left: `${m.pct}%` }}
          >
            {m.label}
          </span>
        ))}
      </div>

      <div className="space-y-1.5" role="list" aria-label="Task timeline">
        {tasksWithDates.map((task) => {
          const start = toDay(task.startDate!) - toDay(rangeStart);
          const duration = Math.max(toDay(task.dueDate!) - toDay(task.startDate!), 1);
          const leftPct = (start / totalDays) * 100;
          const widthPct = Math.max((duration / totalDays) * 100, 0.5);
          const color = STATUS_COLOR[task.status] ?? 'bg-surface-3';
          const ariaLabel = `${task.title}: ${STATUS_LABEL[task.status] ?? task.status}, ${formatDate(task.startDate!)} to ${formatDate(task.dueDate!)}`;

          return (
            <div key={task.id} className="flex items-center gap-2" role="listitem">
              <Link
                href={`/projects/${projectId}/tasks/${task.id}`}
                className="w-40 shrink-0 text-xs text-fg hover:text-primary transition-colors truncate text-right pr-2"
                title={task.title}
              >
                {task.title}
              </Link>
              <div className="relative flex-1 h-6 rounded bg-surface-2 overflow-visible">
                {showToday && (
                  <div
                    className="absolute top-0 bottom-0 w-px bg-danger z-10"
                    style={{ left: `${todayPct}%` }}
                    title="Today"
                    aria-hidden
                  />
                )}
                <div
                  className={`absolute top-1 h-4 rounded cursor-pointer ${color} hover:opacity-80 transition-opacity`}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                  role="img"
                  aria-label={ariaLabel}
                  onMouseEnter={() => setTooltip(task.id)}
                  onMouseLeave={() => setTooltip(null)}
                  onFocus={() => setTooltip(task.id)}
                  onBlur={() => setTooltip(null)}
                  tabIndex={0}
                >
                  {tooltip === task.id && (
                    <div
                      className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-20 w-48 rounded-lg bg-fg text-surface-1 text-[11px] p-2.5 shadow-xl pointer-events-none"
                      role="tooltip"
                    >
                      <p className="font-semibold mb-1 truncate">{task.title}</p>
                      <p className="opacity-80">{STATUS_LABEL[task.status]}</p>
                      {task.assignee && <p className="opacity-80">@{task.assignee}</p>}
                      <p className="opacity-60 mt-1">
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

      <div className="flex flex-wrap gap-3 pt-2 border-t border-subtle">
        {Object.entries(STATUS_LABEL).map(([status, label]) => (
          <span key={status} className="flex items-center gap-1.5 text-[11px] text-fg-muted">
            <span
              className={`inline-block h-2.5 w-2.5 rounded-sm ${STATUS_COLOR[status]}`}
              aria-hidden
            />
            {label}
          </span>
        ))}
        {showToday && (
          <span className="flex items-center gap-1.5 text-[11px] text-fg-muted">
            <span className="inline-block h-2.5 w-px bg-danger" aria-hidden />
            Today
          </span>
        )}
      </div>

      {tasksWithout.length > 0 && (
        <div className="pt-2 border-t border-subtle">
          <p className="text-[11px] text-fg-subtle mb-1.5">
            {tasksWithout.length} task{tasksWithout.length > 1 ? 's' : ''} without dates:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {tasksWithout.map((t) => (
              <Link
                key={t.id}
                href={`/projects/${projectId}/tasks/${t.id}`}
                className="text-[11px] text-fg-muted hover:text-primary underline decoration-dotted transition-colors"
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
