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
      return 'badge-success';
    case 'failed':
      return 'badge-danger';
    case 'cancelled':
      return 'badge-neutral';
    case 'stale':
      return 'badge-warning';
    case 'running':
    default:
      return 'badge-brand';
  }
}

export function ExecutionHistory({ runs }: ExecutionHistoryProps) {
  if (runs.length === 0) {
    return (
      <div className="panel p-10 text-center">
        <p className="text-sm text-slate-400">No execution runs yet.</p>
      </div>
    );
  }

  return (
    <div className="panel overflow-hidden">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-100 bg-slate-50/80">
          <tr>
            <th className="px-5 py-3 font-medium text-xs text-slate-500 uppercase tracking-wider">
              Executor
            </th>
            <th className="px-5 py-3 font-medium text-xs text-slate-500 uppercase tracking-wider">
              Type
            </th>
            <th className="px-5 py-3 font-medium text-xs text-slate-500 uppercase tracking-wider">
              Status
            </th>
            <th className="px-5 py-3 font-medium text-xs text-slate-500 uppercase tracking-wider">
              Started
            </th>
            <th className="px-5 py-3 font-medium text-xs text-slate-500 uppercase tracking-wider">
              Heartbeat
            </th>
            <th className="px-5 py-3 font-medium text-xs text-slate-500 uppercase tracking-wider">
              Duration
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {runs.map((run) => (
            <tr key={run.id} className="hover:bg-slate-50/80 transition-colors">
              <td className="px-5 py-3 align-middle font-medium text-slate-700">
                {run.executorName}
              </td>
              <td className="px-5 py-3 align-middle capitalize text-slate-500">
                {run.executorType}
              </td>
              <td className="px-5 py-3 align-middle">
                <span className={cn('badge uppercase', statusBadgeClass(run.status))}>
                  {run.status}
                </span>
              </td>
              <td className="px-5 py-3 align-middle text-slate-500 text-xs">
                {formatDateTime(run.startedAt)}
              </td>
              <td className="px-5 py-3 align-middle text-slate-500 text-xs">
                {formatDateTime(run.lastHeartbeatAt)}
              </td>
              <td className="px-5 py-3 align-middle text-slate-500 text-xs tabular-nums">
                {formatDuration(run.startedAt, run.endedAt, run.status)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
