import type { Plan, PlanReview } from '@prisma/client';
import { CheckCircle2, X } from 'lucide-react';

type PlanWithReviews = Plan & { reviews: PlanReview[] };

type PlanDetailProps = {
  plan: PlanWithReviews;
  previousPlan: Plan | null;
};

function statusStyle(status: string) {
  switch (status) {
    case 'active':
      return 'badge-brand';
    case 'superseded':
      return 'badge-neutral';
    case 'draft':
      return 'badge-violet';
    case 'proposed':
      return 'badge-warning';
    default:
      return 'badge-neutral';
  }
}

function ListSection({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="section-label mb-2">{title}</h3>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li
            key={item}
            className="flex items-start gap-2.5 text-sm text-slate-600 leading-relaxed"
          >
            <span className="mt-2 h-1.5 w-1.5 rounded-full bg-slate-300 shrink-0" />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PlanDetail({ plan, previousPlan }: PlanDetailProps) {
  const titleChanged =
    previousPlan && previousPlan.title !== plan.title
      ? { from: previousPlan.title, to: plan.title }
      : null;

  return (
    <div className="panel p-6">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-lg font-semibold text-slate-900">{plan.title}</h2>
          <span className={`badge ${statusStyle(plan.status)} uppercase`}>{plan.status}</span>
          <span className="badge badge-neutral font-mono">v{plan.version}</span>
        </div>

        {titleChanged && (
          <p className="text-sm text-slate-500">
            Title changed from &ldquo;{titleChanged.from}&rdquo;
          </p>
        )}
        {plan.changeSummary && (
          <p className="text-sm text-slate-500">
            <span className="font-medium text-slate-700">Summary:</span> {plan.changeSummary}
          </p>
        )}

        <div className="space-y-4 border-t border-slate-100 pt-4">
          <div>
            <h3 className="section-label mb-1.5">Goal</h3>
            <p className="text-sm text-slate-700 leading-relaxed">{plan.goal}</p>
          </div>
          <div>
            <h3 className="section-label mb-1.5">Scope</h3>
            <p className="text-sm whitespace-pre-wrap text-slate-600 leading-relaxed">
              {plan.scope}
            </p>
          </div>
          <ListSection title="Constraints" items={plan.constraints} />
          <ListSection title="Standards" items={plan.standards} />
          <ListSection title="Deliverables" items={plan.deliverables} />
          <ListSection title="Open questions" items={plan.openQuestions} />
          {plan.why && (
            <div>
              <h3 className="section-label mb-1.5">Why</h3>
              <p className="text-sm text-slate-600 leading-relaxed">{plan.why}</p>
            </div>
          )}
        </div>

        {plan.reviews.length > 0 && (
          <div className="border-t border-slate-100 pt-4">
            <h3 className="section-label mb-3">Reviews</h3>
            <div className="space-y-2">
              {plan.reviews.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-2.5 rounded-lg border border-slate-200 bg-slate-50/50 px-4 py-2.5 text-sm"
                >
                  <span className="font-medium text-slate-700">{r.reviewerName}</span>
                  {r.status === 'approved' ? (
                    <span className="flex items-center gap-1 text-emerald-600 font-medium text-xs">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Approved
                    </span>
                  ) : r.status === 'rejected' ? (
                    <span className="flex items-center gap-1 text-rose-600 font-medium text-xs">
                      <X className="h-3.5 w-3.5" /> Rejected
                    </span>
                  ) : (
                    <span className="text-slate-400 text-xs">Pending</span>
                  )}
                  {r.comment && (
                    <span className="text-slate-500 ml-auto truncate max-w-[200px] text-xs">
                      {r.comment}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
