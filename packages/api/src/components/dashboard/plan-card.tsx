import Link from 'next/link';
import type { Plan } from '@prisma/client';
import { GitBranch, Calendar, ArrowUpRight } from 'lucide-react';

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
    <div className="panel p-5 group/plan">
      <div className="flex items-center gap-2 mb-3">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-50">
          <GitBranch className="h-3 w-3 text-blue-500" />
        </div>
        <span className="section-label">Active Plan</span>
      </div>
      <Link href={`/projects/${projectId}/plans?plan=${plan.id}`} className="block">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-900 group-hover/plan:text-blue-600 transition-colors">
            {plan.title}
          </span>
          <ArrowUpRight className="h-3.5 w-3.5 text-slate-300 group-hover/plan:text-blue-500 transition-colors" />
        </div>
        <div className="flex items-center gap-2 mt-2">
          <span className="badge badge-brand font-mono">v{plan.version}</span>
          <span className="flex items-center gap-1 text-xs text-slate-400">
            <Calendar className="h-3 w-3" />
            {formatRelative(plan.activatedAt)}
          </span>
        </div>
      </Link>
      <p className="mt-3 text-xs text-slate-500 leading-relaxed line-clamp-2">{plan.goal}</p>
    </div>
  );
}
