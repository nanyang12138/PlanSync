import Link from 'next/link';
import type { Plan } from '@prisma/client';
import { Calendar, ArrowUpRight } from 'lucide-react';

type PlanCardProps = {
  plan: Plan;
  projectId: string;
};

function formatRelative(d: Date | null) {
  if (!d) return '—';
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60000);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day > 7) return d.toLocaleDateString(undefined, { dateStyle: 'medium' });
  if (day > 0) return `${day}d ago`;
  if (hr > 0) return `${hr}h ago`;
  if (min > 0) return `${min}m ago`;
  return 'just now';
}

export function PlanCard({ plan, projectId }: PlanCardProps) {
  return (
    <Link
      href={`/projects/${projectId}/plans?plan=${plan.id}`}
      className="group/plan block rounded-xl border border-slate-200/80 bg-slate-50/50 p-4 hover:border-blue-300 hover:bg-blue-50/40 hover:shadow-sm transition-all"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-semibold text-slate-900 group-hover/plan:text-blue-600 transition-colors line-clamp-1">
          {plan.title}
        </span>
        <ArrowUpRight className="h-3.5 w-3.5 text-slate-300 group-hover/plan:text-blue-500 transition-colors shrink-0 ml-2" />
      </div>
      <div className="flex items-center gap-2 mb-3">
        <span className="badge badge-brand font-mono">v{plan.version}</span>
        <span className="flex items-center gap-1 text-xs text-slate-400">
          <Calendar className="h-3 w-3" />
          {formatRelative(plan.activatedAt)}
        </span>
      </div>
      <p className="text-xs text-slate-500 leading-relaxed line-clamp-3">{plan.goal}</p>
      <p className="text-[11px] text-blue-400 mt-3 group-hover/plan:text-blue-600 transition-colors">
        Click to view full plan →
      </p>
    </Link>
  );
}
