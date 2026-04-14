import { Fragment } from 'react';
import type { ExecutionRun } from '@prisma/client';
import { cn } from '@/lib/utils';
import { GitBranch, CheckCircle2, AlertTriangle, FileCode } from 'lucide-react';

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

function hasDetails(run: ExecutionRun) {
  return !!(
    run.outputSummary ||
    run.filesChanged.length > 0 ||
    run.deliverablesMet.length > 0 ||
    run.blockers.length > 0
  );
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
              Branch
            </th>
            <th className="px-5 py-3 font-medium text-xs text-slate-500 uppercase tracking-wider">
              Started
            </th>
            <th className="px-5 py-3 font-medium text-xs text-slate-500 uppercase tracking-wider">
              Duration
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {runs.map((run) => (
            <Fragment key={run.id}>
              <tr className="hover:bg-slate-50/80 transition-colors">
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
                <td className="px-5 py-3 align-middle text-xs">
                  {run.branchName ? (
                    <span className="flex items-center gap-1 font-mono text-slate-600">
                      <GitBranch className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                      <span className="truncate max-w-[180px]" title={run.branchName}>
                        {run.branchName}
                      </span>
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="px-5 py-3 align-middle text-slate-500 text-xs">
                  {formatDateTime(run.startedAt)}
                </td>
                <td className="px-5 py-3 align-middle text-slate-500 text-xs tabular-nums">
                  {formatDuration(run.startedAt, run.endedAt, run.status)}
                </td>
              </tr>

              {/* Expandable details row */}
              {hasDetails(run) && (
                <tr>
                  <td colSpan={6} className="px-5 py-0">
                    <details className="group">
                      <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-600 py-2 transition-colors">
                        View details
                      </summary>
                      <div className="pb-3 space-y-3">
                        {run.outputSummary && (
                          <div className="rounded-lg bg-slate-50 border border-slate-100 p-3">
                            <p className="text-xs font-medium text-slate-500 mb-1">Output</p>
                            <p className="text-sm text-slate-700 whitespace-pre-wrap">
                              {run.outputSummary}
                            </p>
                          </div>
                        )}

                        <div className="flex flex-wrap gap-4">
                          {run.filesChanged.length > 0 && (
                            <div className="flex items-center gap-1.5 text-xs text-slate-600">
                              <FileCode className="h-3.5 w-3.5 text-blue-500" />
                              {run.filesChanged.length} file
                              {run.filesChanged.length !== 1 ? 's' : ''} changed
                            </div>
                          )}

                          {run.deliverablesMet.length > 0 && (
                            <div className="flex items-center gap-1.5 text-xs text-emerald-700">
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                              {run.deliverablesMet.length} deliverable
                              {run.deliverablesMet.length !== 1 ? 's' : ''} met
                            </div>
                          )}

                          {run.blockers.length > 0 && (
                            <div className="flex items-center gap-1.5 text-xs text-red-700">
                              <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
                              {run.blockers.length} blocker{run.blockers.length !== 1 ? 's' : ''}
                            </div>
                          )}
                        </div>

                        {run.deliverablesMet.length > 0 && (
                          <ul className="space-y-1 pl-1">
                            {run.deliverablesMet.map((d, i) => (
                              <li
                                key={i}
                                className="flex items-start gap-1.5 text-xs text-slate-600"
                              >
                                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 mt-0.5 shrink-0" />
                                {d}
                              </li>
                            ))}
                          </ul>
                        )}

                        {run.filesChanged.length > 0 && (
                          <details className="group/files">
                            <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-600 transition-colors">
                              Files ({run.filesChanged.length})
                            </summary>
                            <ul className="mt-1 space-y-0.5 pl-1">
                              {run.filesChanged.map((f, i) => (
                                <li key={i} className="text-xs font-mono text-slate-500">
                                  {f}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}

                        {run.blockers.length > 0 && (
                          <ul className="space-y-1 pl-1">
                            {run.blockers.map((b, i) => (
                              <li key={i} className="flex items-start gap-1.5 text-xs text-red-600">
                                <AlertTriangle className="h-3.5 w-3.5 text-red-500 mt-0.5 shrink-0" />
                                {b}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </details>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
