'use client';

import Link from 'next/link';
import { Fragment } from 'react';
import type { Plan } from '@prisma/client';
import { cn } from '@/lib/utils';

type PlanTimelineProps = {
  projectId: string;
  plans: Plan[];
  selectedPlanId: string;
};

function statusStyles(status: string) {
  switch (status) {
    case 'active':
      return {
        dot: 'border-emerald-600 bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.2)]',
        label: 'text-emerald-700',
      };
    case 'superseded':
      return {
        dot: 'border-slate-300 bg-slate-300',
        label: 'text-slate-400',
      };
    case 'draft':
      return {
        dot: 'border-blue-500 bg-blue-500 shadow-[0_0_0_3px_rgba(59,130,246,0.15)]',
        label: 'text-blue-600',
      };
    case 'proposed':
      return {
        dot: 'border-amber-500 bg-amber-400 shadow-[0_0_0_3px_rgba(251,191,36,0.2)]',
        label: 'text-amber-700',
      };
    default:
      return {
        dot: 'border-slate-300 bg-slate-200',
        label: 'text-slate-400',
      };
  }
}

export function PlanTimeline({ projectId, plans, selectedPlanId }: PlanTimelineProps) {
  const base = `/projects/${projectId}/plans`;

  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex min-w-max items-center justify-center px-1">
        {plans.map((plan, index) => {
          const styles = statusStyles(plan.status);
          const isSelected = plan.id === selectedPlanId;

          return (
            <Fragment key={plan.id}>
              {index > 0 && (
                <div className="h-0.5 w-10 shrink-0 bg-slate-200 sm:w-14" aria-hidden />
              )}
              <Link
                href={`${base}?plan=${plan.id}`}
                scroll={false}
                className={cn(
                  'group flex flex-col items-center gap-2 rounded-lg px-3 py-2 transition-all',
                  'outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2',
                  isSelected && 'bg-blue-50/60',
                )}
              >
                <span
                  className={cn(
                    'relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-transform',
                    styles.dot,
                    isSelected && 'scale-125 ring-2 ring-blue-500 ring-offset-2 ring-offset-white',
                  )}
                  title={`v${plan.version} · ${plan.status}`}
                >
                  <span className="sr-only">
                    Version {plan.version}, {plan.status}
                    {isSelected ? ', selected' : ''}
                  </span>
                </span>
                <span className={cn('text-xs font-semibold tabular-nums', styles.label)}>
                  v{plan.version}
                </span>
              </Link>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
