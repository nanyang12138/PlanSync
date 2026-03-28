import type { Plan, PlanReview } from '@prisma/client';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

type PlanWithReviews = Plan & { reviews: PlanReview[] };

type PlanDetailProps = {
  plan: PlanWithReviews;
  previousPlan: Plan | null;
};

function statusBadgeClass(status: string) {
  switch (status) {
    case 'active':
      return 'border-emerald-600/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400';
    case 'superseded':
      return 'border-border bg-muted text-muted-foreground';
    case 'draft':
      return 'border-blue-600/30 bg-blue-500/15 text-blue-700 dark:text-blue-400';
    case 'proposed':
      return 'border-amber-500/40 bg-amber-400/15 text-amber-900 dark:text-amber-300';
    default:
      return 'border-border bg-muted';
  }
}

function reviewBadgeClass(status: string) {
  switch (status) {
    case 'approved':
      return 'border-emerald-600/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300';
    case 'rejected':
      return 'border-destructive/30 bg-destructive/10 text-destructive';
    case 'pending':
    default:
      return 'border-border bg-muted text-muted-foreground';
  }
}

function ListSection({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-foreground">{title}</h3>
      <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
        {items.map((item) => (
          <li key={item}>{item}</li>
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
    <section
      className={cn('rounded-xl border border-border bg-card p-6 text-card-foreground shadow-sm')}
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold leading-tight">{plan.title}</h2>
              <span
                className={cn(
                  'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide',
                  statusBadgeClass(plan.status),
                )}
              >
                {plan.status}
              </span>
              <Badge variant="outline" className="font-mono text-xs">
                v{plan.version}
              </Badge>
            </div>
            {titleChanged && (
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Change from previous version:</span>{' '}
                title updated from &ldquo;{titleChanged.from}&rdquo; to &ldquo;{titleChanged.to}
                &rdquo;
              </p>
            )}
            {plan.changeSummary && (
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Summary:</span> {plan.changeSummary}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-4 border-t border-border pt-4">
          <div>
            <h3 className="mb-1 text-sm font-semibold">Goal</h3>
            <p className="text-sm text-muted-foreground">{plan.goal}</p>
          </div>
          <div>
            <h3 className="mb-1 text-sm font-semibold">Scope</h3>
            <p className="text-sm whitespace-pre-wrap text-muted-foreground">{plan.scope}</p>
          </div>
          <ListSection title="Constraints" items={plan.constraints} />
          <ListSection title="Standards" items={plan.standards} />
          <ListSection title="Deliverables" items={plan.deliverables} />
          <ListSection title="Open questions" items={plan.openQuestions} />
          {plan.why && (
            <div>
              <h3 className="mb-1 text-sm font-semibold">Why</h3>
              <p className="text-sm text-muted-foreground">{plan.why}</p>
            </div>
          )}
        </div>

        {plan.reviews.length > 0 && (
          <div className="border-t border-border pt-4">
            <h3 className="mb-3 text-sm font-semibold">Reviews</h3>
            <ul className="space-y-2">
              {plan.reviews.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <span className="font-medium">{r.reviewerName}</span>
                  <span
                    className={cn(
                      'inline-flex rounded-md border px-2 py-0.5 text-xs font-semibold capitalize',
                      reviewBadgeClass(r.status),
                    )}
                  >
                    {r.status}
                  </span>
                  {r.comment && <p className="w-full text-xs text-muted-foreground">{r.comment}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
