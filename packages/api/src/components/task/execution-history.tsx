import type { ExecutionRun } from '@prisma/client';
import { cn } from '@/lib/utils';

export type ExecutionHistoryProps = {
  runs: ExecutionRun[];
};

function formatDateTime(d: Date | null) {
  if (!d) return '—';
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function formatDuration(start: Date, end: Date | null, status: string) {
  const endMs = end ? end.getTime() : status === 'running' ? Date.now() : start.getTime();
  const ms = Math.max(0, endMs - start.getTime());
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  let label: string;
  if (h > 0) {
    label = `${h}h ${m % 60}m`;
  } else if (m > 0) {
    label = `${m}m ${s % 60}s`;
  } else {
    label = `${s}s`;
  }
  if (status === 'running') {
    return `${label} (running)`;
  }
  return label;
}

function statusBadgeClass(status: string) {
  switch (status) {
    case 'completed':
      return 'border-emerald-600/30 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300';
    case 'failed':
      return 'border-destructive/40 bg-destructive/10 text-destructive';
    case 'cancelled':
      return 'border-border bg-muted text-muted-foreground';
    case 'stale':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200';
    case 'running':
    default:
      return 'border-primary/30 bg-primary/10 text-primary';
  }
}

export function ExecutionHistory({ runs }: ExecutionHistoryProps) {
  if (runs.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
        No execution runs yet.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border bg-muted/40">
          <tr>
            <th className="px-4 py-3 font-medium text-muted-foreground">Executor</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Type</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Status</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Started</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Last heartbeat</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Duration</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {runs.map((run) => (
            <tr key={run.id} className="bg-card transition-colors hover:bg-muted/30">
              <td className="px-4 py-3 align-middle font-medium">{run.executorName}</td>
              <td className="px-4 py-3 align-middle capitalize text-muted-foreground">
                {run.executorType}
              </td>
              <td className="px-4 py-3 align-middle">
                <span
                  className={cn(
                    'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold uppercase',
                    statusBadgeClass(run.status),
                  )}
                >
                  {run.status}
                </span>
              </td>
              <td className="px-4 py-3 align-middle text-muted-foreground">
                {formatDateTime(run.startedAt)}
              </td>
              <td className="px-4 py-3 align-middle text-muted-foreground">
                {formatDateTime(run.lastHeartbeatAt)}
              </td>
              <td className="px-4 py-3 align-middle text-muted-foreground">
                {formatDuration(run.startedAt, run.endedAt, run.status)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
