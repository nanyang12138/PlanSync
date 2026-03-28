'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { Plan, PlanSuggestion } from '@prisma/client';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const FIELD_LABELS: Record<string, string> = {
  goal: 'Goal',
  scope: 'Scope',
  constraints: 'Constraints',
  standards: 'Standards',
  deliverables: 'Deliverables',
  openQuestions: 'Open questions',
};

type SuggestionPanelProps = {
  projectId: string;
  plan: Plan;
  suggestions: PlanSuggestion[];
};

function statusBadgeClass(status: string) {
  switch (status) {
    case 'pending':
      return 'border-amber-500/40 bg-amber-400/10 text-amber-900 dark:text-amber-200';
    case 'accepted':
      return 'border-emerald-600/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300';
    case 'rejected':
      return 'border-destructive/30 bg-destructive/10 text-destructive';
    case 'conflict':
      return 'border-orange-500/40 bg-orange-400/10 text-orange-900 dark:text-orange-200';
    default:
      return 'border-border bg-muted text-muted-foreground';
  }
}

function SuggestionResolveButtons({
  projectId,
  planId,
  suggestionId,
}: {
  projectId: string;
  planId: string;
  suggestionId: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<'accept' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resolve(action: 'accept' | 'reject') {
    setError(null);
    setPending(action);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/plans/${planId}/suggestions/${suggestionId}?action=${action}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ comment: '' }),
          credentials: 'include',
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string | { message?: string };
        };
        const err = body?.error;
        const msg =
          typeof err === 'string'
            ? err
            : typeof err === 'object' && err?.message
              ? err.message
              : `Request failed (${res.status})`;
        throw new Error(msg);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="default"
          disabled={pending !== null}
          onClick={() => resolve('accept')}
        >
          {pending === 'accept' ? '…' : 'Accept'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending !== null}
          onClick={() => resolve('reject')}
        >
          {pending === 'reject' ? '…' : 'Reject'}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export function SuggestionPanel({ projectId, plan, suggestions }: SuggestionPanelProps) {
  const isDraftLike = plan.status === 'draft' || plan.status === 'proposed';

  const counts = useMemo(() => {
    let pending = 0;
    let accepted = 0;
    let rejected = 0;
    for (const s of suggestions) {
      if (s.status === 'pending') pending += 1;
      else if (s.status === 'accepted') accepted += 1;
      else if (s.status === 'rejected') rejected += 1;
    }
    return { pending, accepted, rejected };
  }, [suggestions]);

  if (!isDraftLike) {
    return null;
  }

  return (
    <section className="rounded-xl border border-border bg-card p-6 shadow-sm">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Suggestions</h2>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{counts.pending}</span> pending ·{' '}
          <span className="font-medium text-foreground">{counts.accepted}</span> accepted ·{' '}
          <span className="font-medium text-foreground">{counts.rejected}</span> rejected
        </p>
      </div>

      {suggestions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No suggestions yet.</p>
      ) : (
        <ul className="space-y-4">
          {suggestions.map((s) => {
            const fieldLabel = FIELD_LABELS[s.field] ?? s.field;
            const resolved = s.status !== 'pending';

            return (
              <li
                key={s.id}
                className={cn(
                  'rounded-lg border border-border bg-background p-4 text-sm',
                  resolved && 'opacity-90',
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{s.suggestedBy}</span>
                      <span className="text-xs text-muted-foreground">({s.suggestedByType})</span>
                      <span
                        className={cn(
                          'inline-flex rounded-md border px-2 py-0.5 text-xs font-semibold capitalize',
                          statusBadgeClass(s.status),
                        )}
                      >
                        {s.status}
                      </span>
                    </div>
                    <p className="text-muted-foreground">
                      <span className="font-medium text-foreground">{fieldLabel}</span> ·{' '}
                      <span className="capitalize">{s.action}</span>
                      {s.value && (
                        <>
                          {' '}
                          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                            {s.value}
                          </span>
                        </>
                      )}
                    </p>
                    <p className="text-muted-foreground">
                      <span className="font-medium text-foreground">Reason:</span> {s.reason}
                    </p>
                    {resolved && (s.resolvedBy || s.resolvedComment) && (
                      <p className="text-xs text-muted-foreground">
                        {s.resolvedBy && (
                          <>
                            Resolved by <span className="font-medium">{s.resolvedBy}</span>
                            {s.resolvedAt && (
                              <>
                                {' '}
                                ·{' '}
                                {new Date(s.resolvedAt).toLocaleString(undefined, {
                                  dateStyle: 'medium',
                                  timeStyle: 'short',
                                })}
                              </>
                            )}
                          </>
                        )}
                        {s.resolvedComment && (
                          <>
                            <br />
                            {s.resolvedComment}
                          </>
                        )}
                      </p>
                    )}
                  </div>
                  {s.status === 'pending' && (
                    <SuggestionResolveButtons
                      projectId={projectId}
                      planId={plan.id}
                      suggestionId={s.id}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
