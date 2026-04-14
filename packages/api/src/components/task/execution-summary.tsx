import type { ExecutionRun } from '@prisma/client';
import { FileCode, CheckCircle2, AlertTriangle, GitBranch } from 'lucide-react';
import { CopyButton } from '@/components/shared/copy-button';

export type ExecutionSummaryProps = {
  run: ExecutionRun | null;
};

export function ExecutionSummary({ run }: ExecutionSummaryProps) {
  if (!run) return null;

  return (
    <section>
      <h2 className="section-label mb-3">Latest Execution Summary</h2>
      <div className="panel overflow-hidden">
        <div className="p-5 space-y-4">
          {/* Stats row */}
          <div className="flex flex-wrap gap-4">
            {run.filesChanged.length > 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/50 px-3 py-2">
                <FileCode className="h-3.5 w-3.5 text-blue-500" />
                <span className="text-xs font-medium text-slate-700">
                  {run.filesChanged.length} file{run.filesChanged.length !== 1 ? 's' : ''} changed
                </span>
              </div>
            )}

            {run.deliverablesMet.length > 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/50 px-3 py-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                <span className="text-xs font-medium text-emerald-700">
                  {run.deliverablesMet.length} deliverable
                  {run.deliverablesMet.length !== 1 ? 's' : ''} met
                </span>
              </div>
            )}

            {run.branchName && (
              <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/50 px-3 py-2">
                <GitBranch className="h-3.5 w-3.5 text-slate-400" />
                <code className="text-xs font-mono text-slate-700">{run.branchName}</code>
                <CopyButton text={run.branchName} />
              </div>
            )}
          </div>

          {/* Output summary */}
          {run.outputSummary && (
            <div className="rounded-lg bg-slate-50 border border-slate-100 p-4">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">
                Output
              </p>
              <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                {run.outputSummary}
              </p>
            </div>
          )}

          {/* Deliverables met */}
          {run.deliverablesMet.length > 0 && (
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">
                Deliverables Met
              </p>
              <ul className="space-y-1.5">
                {run.deliverablesMet.map((d, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-slate-700">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                    <span>{d}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Blockers */}
          {run.blockers.length > 0 && (
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">
                Blockers
              </p>
              <ul className="space-y-1.5">
                {run.blockers.map((b, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-red-700">
                    <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Files changed list */}
          {run.filesChanged.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer text-xs font-medium text-slate-500 uppercase tracking-wider hover:text-slate-700 transition-colors">
                Files Changed ({run.filesChanged.length})
              </summary>
              <ul className="mt-2 space-y-1 pl-1">
                {run.filesChanged.map((f, i) => (
                  <li key={i} className="text-xs font-mono text-slate-600">
                    {f}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </section>
  );
}
