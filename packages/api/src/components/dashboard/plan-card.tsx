import Link from 'next/link';
import type { Plan } from '@prisma/client';
import { Calendar, ExternalLink, GitBranch, PlusCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

type PlanCardProps = {
  plan: Plan;
  projectId: string;
};

function formatDateTime(d: Date | null) {
  if (!d) return '—';
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function PlanCard({ plan, projectId }: PlanCardProps) {
  return (
    <section
      className={cn('rounded-xl border border-border bg-card p-6 text-card-foreground shadow-sm')}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold leading-tight">{plan.title}</h2>
            <span className="inline-flex items-center rounded-md border border-emerald-600/30 bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
              ACTIVE
            </span>
            <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              v{plan.version}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{plan.goal}</p>
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <Calendar className="h-3.5 w-3.5 shrink-0" />
            <span>
              Activated {formatDateTime(plan.activatedAt)}
              {plan.activatedBy && (
                <>
                  {' '}
                  by <span className="font-medium text-foreground">{plan.activatedBy}</span>
                </>
              )}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Link
            href={`/projects/${projectId}/plans?plan=${plan.id}`}
            className={cn(
              'inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium',
              'text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground',
            )}
          >
            <GitBranch className="h-4 w-4" />
            Plan details
            <ExternalLink className="h-3.5 w-3.5 opacity-60" />
          </Link>
          <Link
            href={`/projects/${projectId}/plans`}
            className={cn(
              'inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium',
              'text-primary-foreground shadow transition-colors hover:bg-primary/90',
            )}
          >
            <PlusCircle className="h-4 w-4" />
            Plan history
          </Link>
        </div>
      </div>
    </section>
  );
}
