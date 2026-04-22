'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { Plan, PlanSuggestion } from '@prisma/client';
import { Bot, User, Lightbulb, Check, X, Plus, Loader2 } from 'lucide-react';

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
    <div>
      <div className="flex gap-2">
        <button
          onClick={() => resolve('accept')}
          disabled={pending !== null}
          className="btn-primary !py-1 !px-3 !text-[11px]"
        >
          <Check className="h-3 w-3" /> Accept
        </button>
        <button
          onClick={() => resolve('reject')}
          disabled={pending !== null}
          className="btn-secondary !py-1 !px-3 !text-[11px]"
        >
          <X className="h-3 w-3" /> Reject
        </button>
      </div>
      {error && <p className="text-xs text-rose-600 mt-1.5">{error}</p>}
    </div>
  );
}

const ARRAY_FIELDS = ['constraints', 'standards', 'deliverables', 'openQuestions'] as const;

function AddSuggestionForm({ projectId, planId }: { projectId: string; planId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<string>('goal');
  const [action, setAction] = useState<string>('set');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const isArrayField = ARRAY_FIELDS.includes(field as (typeof ARRAY_FIELDS)[number]);
  const availableActions = isArrayField ? ['append', 'remove'] : ['set'];

  function handleFieldChange(f: string) {
    setField(f);
    const isArr = ARRAY_FIELDS.includes(f as (typeof ARRAY_FIELDS)[number]);
    setAction(isArr ? 'append' : 'set');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/plans/${planId}/suggestions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, action, value: value.trim(), reason: reason.trim() }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || 'Failed to submit suggestion');
      setValue('');
      setReason('');
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to submit suggestion');
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="btn-ghost w-full justify-center border border-dashed border-violet-200 text-violet-500 hover:bg-violet-50 hover:border-violet-300 mt-2"
      >
        <Plus className="h-3.5 w-3.5" />
        Add Suggestion
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-2 rounded-lg border border-violet-200 bg-white p-4 space-y-3"
    >
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="text-[11px] font-medium text-slate-500 mb-1 block">Field</label>
          <select
            value={field}
            onChange={(e) => handleFieldChange(e.target.value)}
            className="select-field text-xs"
          >
            {Object.entries(FIELD_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="w-28">
          <label className="text-[11px] font-medium text-slate-500 mb-1 block">Action</label>
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="select-field text-xs"
          >
            {availableActions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="text-[11px] font-medium text-slate-500 mb-1 block">
          {action === 'remove' ? 'Value to remove' : 'Suggested value'}
        </label>
        <textarea
          rows={2}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={action === 'set' ? 'New content for this field…' : 'Item to add or remove…'}
          className="input-field w-full resize-none text-xs"
          required
        />
      </div>

      <div>
        <label className="text-[11px] font-medium text-slate-500 mb-1 block">Reason</label>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why is this change needed?"
          className="input-field w-full text-xs"
          required
        />
      </div>

      {error && <p className="text-xs text-rose-600">{error}</p>}

      <div className="flex gap-2 pt-1">
        <button type="button" onClick={() => setOpen(false)} className="btn-ghost text-xs">
          Cancel
        </button>
        <button type="submit" disabled={loading} className="btn-primary text-xs">
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          Submit
        </button>
      </div>
    </form>
  );
}

export function SuggestionPanel({ projectId, plan, suggestions }: SuggestionPanelProps) {
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

  return (
    <div className="panel border-violet-200/80 bg-violet-50/20 p-5">
      <div className="flex items-center gap-2 mb-4">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-100">
          <Lightbulb className="h-3.5 w-3.5 text-violet-500" />
        </div>
        <span className="section-label !text-violet-600">Suggestions</span>
        <span className="ml-auto text-xs text-violet-500">
          {counts.pending} pending · {counts.accepted} accepted · {counts.rejected} rejected
        </span>
      </div>

      {suggestions.length === 0 && (
        <p className="text-sm text-slate-400 italic mb-3">No suggestions yet.</p>
      )}
      {!['draft', 'proposed', 'active'].includes(plan.status) && (
        <p className="text-xs text-slate-400 italic mb-3">
          This plan is {plan.status}; new suggestions are disabled.
        </p>
      )}
      {suggestions.length > 0 && (
        <div className="space-y-3 mb-3">
          {suggestions.map((s) => {
            const fieldLabel = FIELD_LABELS[s.field] ?? s.field;
            const isAgent = s.suggestedByType === 'agent';

            return (
              <div
                key={s.id}
                className="bg-white rounded-lg p-4 border border-violet-200/60 shadow-sm"
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className="flex h-5 w-5 items-center justify-center rounded-md bg-slate-100 shrink-0">
                    {isAgent ? (
                      <Bot className="h-3 w-3 text-violet-400" />
                    ) : (
                      <User className="h-3 w-3 text-slate-400" />
                    )}
                  </div>
                  <span className="text-sm font-medium text-slate-700">{s.suggestedBy}</span>
                  {s.status === 'pending' && (
                    <span className="badge badge-violet text-[10px]">Open</span>
                  )}
                  {s.status === 'accepted' && (
                    <span className="badge badge-success text-[10px]">
                      <Check className="h-2.5 w-2.5" /> Accepted
                    </span>
                  )}
                  {s.status === 'rejected' && (
                    <span className="badge badge-danger text-[10px]">
                      <X className="h-2.5 w-2.5" /> Rejected
                    </span>
                  )}
                </div>
                <p className="text-sm text-slate-600 leading-relaxed mb-1.5">
                  <span className="font-medium text-slate-700">{fieldLabel}</span> ·{' '}
                  <span className="capitalize">{s.action}</span>
                  {s.value && (
                    <span className="ml-1.5 rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-xs">
                      {s.value}
                    </span>
                  )}
                </p>
                <p className="text-xs text-slate-500 mb-3">{s.reason}</p>
                {s.status === 'pending' && (
                  <SuggestionResolveButtons
                    projectId={projectId}
                    planId={plan.id}
                    suggestionId={s.id}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {['draft', 'proposed', 'active'].includes(plan.status) && (
        <AddSuggestionForm projectId={projectId} planId={plan.id} />
      )}
    </div>
  );
}
