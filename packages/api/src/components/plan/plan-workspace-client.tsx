'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Plan, PlanReview } from '@prisma/client';
import type { CreatePlan, UpdatePlan } from '@plansync/shared';
import {
  FilePlus2,
  Save,
  Send,
  Rocket,
  RotateCcw,
  Trash2,
  ShieldCheck,
  AlertTriangle,
  Sparkles,
  Loader2,
  Mail,
} from 'lucide-react';
import { PlanDetail } from './plan-detail';

type EditablePlan = Plan & { reviews: PlanReview[] };

type PlanWorkspaceClientProps = {
  projectId: string;
  selectedPlan: EditablePlan | null;
  previousPlan: Plan | null;
  memberNames: string[];
  isOwner: boolean;
  currentUser: string;
  nextVersion: number;
};

type EditorMode = 'view' | 'create' | 'edit';

type PlanFormState = {
  title: string;
  goal: string;
  scope: string;
  constraints: string;
  standards: string;
  deliverables: string;
  openQuestions: string;
  changeSummary: string;
  why: string;
  requiredReviewers: string;
};

const EMPTY_FORM: PlanFormState = {
  title: '',
  goal: '',
  scope: '',
  constraints: '',
  standards: '',
  deliverables: '',
  openQuestions: '',
  changeSummary: '',
  why: '',
  requiredReviewers: '',
};

function toMultiline(items: string[]) {
  return items.join('\n');
}

function fromMultiline(value: string) {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildFormState(plan: EditablePlan | Plan | null): PlanFormState {
  if (!plan) return EMPTY_FORM;

  return {
    title: plan.title,
    goal: plan.goal,
    scope: plan.scope,
    constraints: toMultiline(plan.constraints),
    standards: toMultiline(plan.standards),
    deliverables: toMultiline(plan.deliverables),
    openQuestions: toMultiline(plan.openQuestions),
    changeSummary: plan.changeSummary ?? '',
    why: plan.why ?? '',
    requiredReviewers: toMultiline(plan.requiredReviewers),
  };
}

function buildCreatePayload(form: PlanFormState): CreatePlan {
  return {
    title: form.title.trim(),
    goal: form.goal.trim(),
    scope: form.scope.trim(),
    constraints: fromMultiline(form.constraints),
    standards: fromMultiline(form.standards),
    deliverables: fromMultiline(form.deliverables),
    openQuestions: fromMultiline(form.openQuestions),
    requiredReviewers: fromMultiline(form.requiredReviewers),
    ...(form.changeSummary.trim() ? { changeSummary: form.changeSummary.trim() } : {}),
    ...(form.why.trim() ? { why: form.why.trim() } : {}),
  };
}

function buildUpdatePayload(form: PlanFormState): UpdatePlan {
  return buildCreatePayload(form);
}

function requestErrorMessage(body: unknown, status: number) {
  if (body && typeof body === 'object' && 'error' in body) {
    const error = (body as { error?: string | { message?: string } }).error;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object' && error.message) return error.message;
  }
  return `Request failed (${status})`;
}

export function PlanWorkspaceClient({
  projectId,
  selectedPlan,
  previousPlan,
  memberNames,
  isOwner,
  currentUser,
  nextVersion,
}: PlanWorkspaceClientProps) {
  const router = useRouter();
  const [mode, setMode] = useState<EditorMode>(
    isOwner && selectedPlan?.status === 'draft' ? 'edit' : 'view',
  );
  const [form, setForm] = useState<PlanFormState>(buildFormState(selectedPlan));
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notifyLoading, setNotifyLoading] = useState<string | null>(null);
  const [notifySent, setNotifySent] = useState<string[]>([]);
  const [aiDraftDesc, setAiDraftDesc] = useState('');
  const [aiDraftLoading, setAiDraftLoading] = useState(false);
  const [aiDraftError, setAiDraftError] = useState('');
  const [aiFieldLoading, setAiFieldLoading] = useState<keyof PlanFormState | null>(null);

  useEffect(() => {
    setMode(isOwner && selectedPlan?.status === 'draft' ? 'edit' : 'view');
    setForm(buildFormState(selectedPlan));
    setError(null);
  }, [isOwner, selectedPlan?.id, selectedPlan?.status]);

  const canEditSelectedDraft = isOwner && selectedPlan?.status === 'draft';
  const canProposeSelectedDraft = canEditSelectedDraft;
  const canActivateSelectedPlan =
    isOwner &&
    selectedPlan?.status === 'proposed' &&
    (selectedPlan.reviews.length === 0 ||
      selectedPlan.reviews.every((review) => review.status === 'approved'));
  const canReactivateSelectedPlan = isOwner && selectedPlan?.status === 'superseded';

  const reviewSummary = useMemo(() => {
    if (!selectedPlan || selectedPlan.reviews.length === 0) return null;
    const approved = selectedPlan.reviews.filter((review) => review.status === 'approved').length;
    const pending = selectedPlan.reviews.filter((review) => review.status === 'pending').length;
    const rejected = selectedPlan.reviews.filter((review) => review.status === 'rejected').length;
    return { approved, pending, rejected };
  }, [selectedPlan]);

  const requiredFieldsReady =
    form.title.trim().length > 0 && form.goal.trim().length > 0 && form.scope.trim().length > 0;

  async function parseResponse(res: Response) {
    const body = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok) throw new Error(requestErrorMessage(body, res.status));
    return body as { data?: EditablePlan };
  }

  async function persistDraft(targetMode: 'create' | 'edit') {
    const payload = targetMode === 'create' ? buildCreatePayload(form) : buildUpdatePayload(form);

    if (targetMode === 'create') {
      const res = await fetch(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include',
      });
      const body = await parseResponse(res);
      return body.data;
    }

    if (!selectedPlan) throw new Error('No plan selected');

    const res = await fetch(`/api/projects/${projectId}/plans/${selectedPlan.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'include',
    });
    const body = await parseResponse(res);
    return body.data;
  }

  async function handleSaveDraft() {
    const targetMode = mode === 'create' ? 'create' : 'edit';
    setPendingAction('save');
    setError(null);
    try {
      const saved = await persistDraft(targetMode);
      if (saved?.id) {
        router.push(`/projects/${projectId}/plans?plan=${saved.id}`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save draft');
    } finally {
      setPendingAction(null);
    }
  }

  async function handlePropose() {
    const targetMode = mode === 'create' ? 'create' : 'edit';
    setPendingAction('propose');
    setError(null);
    try {
      const saved = await persistDraft(targetMode);
      const planId = saved?.id ?? selectedPlan?.id;
      if (!planId) throw new Error('Plan ID is missing');

      const reviewers = fromMultiline(form.requiredReviewers);
      const res = await fetch(`/api/projects/${projectId}/plans/${planId}/propose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewers }),
        credentials: 'include',
      });
      await parseResponse(res);
      router.push(`/projects/${projectId}/plans?plan=${planId}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to propose draft');
    } finally {
      setPendingAction(null);
    }
  }

  async function handleActivate() {
    if (!selectedPlan) return;
    setPendingAction('activate');
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/plans/${selectedPlan.id}/activate`, {
        method: 'POST',
        credentials: 'include',
      });
      await parseResponse(res);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to activate plan');
    } finally {
      setPendingAction(null);
    }
  }

  async function handleReactivate() {
    if (!selectedPlan) return;
    setPendingAction('reactivate');
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/plans/${selectedPlan.id}/reactivate`, {
        method: 'POST',
        credentials: 'include',
      });
      await parseResponse(res);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reactivate plan');
    } finally {
      setPendingAction(null);
    }
  }

  async function handleDeleteDraft() {
    if (!selectedPlan) return;
    const confirmed = window.confirm(`Delete draft plan v${selectedPlan.version}?`);
    if (!confirmed) return;

    setPendingAction('delete');
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/plans/${selectedPlan.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      await parseResponse(res);
      router.push(`/projects/${projectId}/plans`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete draft');
    } finally {
      setPendingAction(null);
    }
  }

  async function handleReviewAction(
    reviewId: string,
    action: 'approve' | 'reject',
    comment?: string,
  ) {
    if (!selectedPlan) return;
    try {
      const res = await fetch(
        `/api/projects/${projectId}/plans/${selectedPlan.id}/reviews/${reviewId}?action=${action}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ comment }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as unknown;
        throw new Error(requestErrorMessage(body, res.status));
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit review');
    }
  }

  async function handleNotify(type: 'plan_reviewers' | 'plan_owner') {
    if (!selectedPlan) return;
    setNotifyLoading(type);
    setNotifySent([]);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, planId: selectedPlan.id }),
        credentials: 'include',
      });
      const data = (await res.json()) as { sent?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      setNotifySent(data.sent ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send notification');
    } finally {
      setNotifyLoading(null);
    }
  }

  function startNewDraft() {
    setMode('create');
    setForm(buildFormState(selectedPlan));
    setError(null);
  }

  async function handleAiDraft() {
    if (!form.title.trim()) return;
    setAiDraftLoading(true);
    setAiDraftError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/plans/ai-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title.trim(),
          description: aiDraftDesc.trim() || undefined,
        }),
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        setAiDraftError(data?.error || 'AI generation failed');
        return;
      }
      const d = data.draft as Partial<Record<keyof PlanFormState, unknown>>;
      setForm((prev) => ({
        ...prev,
        ...(typeof d.goal === 'string' ? { goal: d.goal } : {}),
        ...(typeof d.scope === 'string' ? { scope: d.scope } : {}),
        ...(Array.isArray(d.constraints)
          ? { constraints: (d.constraints as string[]).join('\n') }
          : {}),
        ...(Array.isArray(d.standards) ? { standards: (d.standards as string[]).join('\n') } : {}),
        ...(Array.isArray(d.deliverables)
          ? { deliverables: (d.deliverables as string[]).join('\n') }
          : {}),
        ...(Array.isArray(d.openQuestions)
          ? { openQuestions: (d.openQuestions as string[]).join('\n') }
          : {}),
      }));
    } catch {
      setAiDraftError('Network error');
    } finally {
      setAiDraftLoading(false);
    }
  }

  async function handleAiField(field: keyof PlanFormState) {
    setAiFieldLoading(field);
    try {
      const res = await fetch(`/api/projects/${projectId}/plans/ai-field`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          field,
          currentValue: form[field],
          title: form.title,
          goal: form.goal,
        }),
        credentials: 'include',
      });
      const data = await res.json();
      if (res.ok && data.suggestion) {
        setForm((prev) => ({ ...prev, [field]: data.suggestion }));
      }
    } catch {
      // silently ignore field-level errors
    } finally {
      setAiFieldLoading(null);
    }
  }

  function renderField(
    label: string,
    key: keyof PlanFormState,
    {
      placeholder,
      multiline = false,
      rows = 4,
      helper,
      aiAssist = false,
    }: {
      placeholder?: string;
      multiline?: boolean;
      rows?: number;
      helper?: string;
      aiAssist?: boolean;
    } = {},
  ) {
    const sharedClassName =
      'w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 shadow-sm transition-colors placeholder:text-slate-400 focus:outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100';
    const isLoadingThis = aiFieldLoading === key;

    return (
      <div className="block">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-sm font-medium text-slate-700">{label}</span>
          {aiAssist && (
            <button
              type="button"
              onClick={() => handleAiField(key)}
              disabled={isLoadingThis || !form.title.trim()}
              className="flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium text-violet-600 hover:bg-violet-50 disabled:opacity-40 transition-colors"
              title="AI rewrite this field"
            >
              {isLoadingThis ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Sparkles className="h-3 w-3" />
              )}
              AI
            </button>
          )}
        </div>
        {multiline ? (
          <textarea
            rows={rows}
            value={form[key]}
            onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
            placeholder={placeholder}
            className={`${sharedClassName} resize-y`}
          />
        ) : (
          <input
            type="text"
            value={form[key]}
            onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
            placeholder={placeholder}
            className={sharedClassName}
          />
        )}
        {helper && <span className="mt-1.5 block text-xs text-slate-500">{helper}</span>}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {isOwner && (
        <div className="panel p-5 border-slate-200/80 bg-slate-50/60">
          <div className="flex flex-wrap items-start gap-3 justify-between">
            <div>
              <p className="section-label mb-1">Owner Workflow</p>
              <h2 className="text-base font-semibold text-slate-900">
                Manage the full plan lifecycle from the browser
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Create drafts, edit plan content, submit for review, then activate or reactivate
                versions without leaving the Plans page.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={startNewDraft} className="btn-primary">
                <FilePlus2 className="h-4 w-4" />
                New Draft Plan
              </button>
              {canActivateSelectedPlan && (
                <button
                  type="button"
                  onClick={handleActivate}
                  disabled={pendingAction !== null}
                  className="btn-primary"
                >
                  <Rocket className="h-4 w-4" />
                  {pendingAction === 'activate' ? 'Activating...' : 'Activate Plan'}
                </button>
              )}
              {canReactivateSelectedPlan && (
                <button
                  type="button"
                  onClick={handleReactivate}
                  disabled={pendingAction !== null}
                  className="btn-secondary"
                >
                  <RotateCcw className="h-4 w-4" />
                  {pendingAction === 'reactivate' ? 'Reactivating...' : 'Reactivate'}
                </button>
              )}
            </div>
          </div>

          {selectedPlan?.status === 'proposed' && reviewSummary && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3">
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 text-amber-600" />
                <div className="flex-1 text-sm text-amber-800">
                  <p className="font-medium">
                    Review status: {reviewSummary.approved} approved, {reviewSummary.pending}{' '}
                    pending, {reviewSummary.rejected} rejected
                  </p>
                  {!canActivateSelectedPlan && (
                    <p className="mt-1 text-amber-700">
                      This plan cannot be activated until every reviewer approves.
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {reviewSummary.pending > 0 && (
                      <button
                        type="button"
                        onClick={() => handleNotify('plan_reviewers')}
                        disabled={notifyLoading !== null}
                        className="flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50 transition-colors"
                      >
                        {notifyLoading === 'plan_reviewers' ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Mail className="h-3 w-3" />
                        )}
                        通知 Reviewers
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleNotify('plan_owner')}
                      disabled={notifyLoading !== null}
                      className="flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50 transition-colors"
                    >
                      {notifyLoading === 'plan_owner' ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Mail className="h-3 w-3" />
                      )}
                      通知 Owner
                    </button>
                  </div>
                  {notifySent.length > 0 && (
                    <p className="mt-2 text-xs text-emerald-700">
                      ✓ 已发送至：{notifySent.join(', ')}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          )}
        </div>
      )}

      {(mode === 'create' || canEditSelectedDraft) && isOwner ? (
        <div className="panel p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div>
              <p className="section-label mb-1">
                {mode === 'create' ? `Draft v${nextVersion}` : `Editing v${selectedPlan?.version}`}
              </p>
              <h2 className="text-lg font-semibold text-slate-900">
                {mode === 'create' ? 'Create a new draft plan' : 'Edit draft plan'}
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Fill in the complete plan content here, then save it as a draft or submit it for
                review.
              </p>
            </div>
            {mode === 'edit' && selectedPlan && (
              <button
                type="button"
                onClick={handleDeleteDraft}
                disabled={pendingAction !== null}
                className="btn-danger"
              >
                <Trash2 className="h-4 w-4" />
                {pendingAction === 'delete' ? 'Deleting...' : 'Delete Draft'}
              </button>
            )}
          </div>

          {/* AI Draft Section */}
          <div className="mt-5 rounded-xl border border-violet-200 bg-violet-50/40 p-4">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="h-4 w-4 text-violet-500" />
              <span className="text-sm font-medium text-violet-800">PlanSync AI Assistant</span>
            </div>
            <p className="text-xs text-violet-600 mb-3">
              Fill in the title, then use AI to generate a full draft in one click; or click the{' '}
              <strong>AI</strong> button next to each field to rewrite individually.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                className="flex-1 rounded-lg border border-violet-200 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                placeholder="One-line description of the plan's purpose (optional)"
                value={aiDraftDesc}
                onChange={(e) => setAiDraftDesc(e.target.value)}
                disabled={aiDraftLoading}
              />
              <button
                type="button"
                onClick={handleAiDraft}
                disabled={aiDraftLoading || !form.title.trim()}
                className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                {aiDraftLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {aiDraftLoading ? 'Generating...' : 'Generate Full Draft'}
              </button>
            </div>
            {aiDraftError && <p className="mt-2 text-xs text-rose-600">{aiDraftError}</p>}
          </div>

          <div className="mt-6 grid gap-5">
            {renderField('Title', 'title', {
              placeholder: 'Example: MVP Backend + MCP Integration (v3)',
            })}
            {renderField('Goal', 'goal', {
              placeholder: 'What is this version trying to achieve?',
              multiline: true,
              rows: 3,
              aiAssist: true,
            })}
            {renderField('Scope', 'scope', {
              placeholder: 'Describe the scope and boundaries for this plan version.',
              multiline: true,
              rows: 4,
              aiAssist: true,
            })}
            {renderField('Constraints', 'constraints', {
              multiline: true,
              rows: 5,
              helper: 'One item per line.',
              aiAssist: true,
            })}
            {renderField('Standards', 'standards', {
              multiline: true,
              rows: 5,
              helper: 'One item per line.',
              aiAssist: true,
            })}
            {renderField('Deliverables', 'deliverables', {
              multiline: true,
              rows: 5,
              helper: 'One item per line.',
              aiAssist: true,
            })}
            {renderField('Open Questions', 'openQuestions', {
              multiline: true,
              rows: 4,
              helper: 'One item per line.',
              aiAssist: true,
            })}
            {renderField('Change Summary', 'changeSummary', {
              multiline: true,
              rows: 3,
              placeholder: 'Summarize how this version differs from the previous one.',
            })}
            {renderField('Why', 'why', {
              multiline: true,
              rows: 3,
              placeholder: 'Explain why this change is necessary.',
            })}
            {renderField('Required Reviewers', 'requiredReviewers', {
              multiline: true,
              rows: 4,
              helper:
                memberNames.length > 0
                  ? `Available members: ${memberNames.join(', ')}. One reviewer per line.`
                  : 'One reviewer per line.',
            })}
          </div>

          {!requiredFieldsReady && (
            <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-800">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Title, Goal, and Scope are required before saving or proposing this draft.
              </div>
            </div>
          )}

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={handleSaveDraft}
              disabled={pendingAction !== null || !requiredFieldsReady}
              className="btn-secondary"
            >
              <Save className="h-4 w-4" />
              {pendingAction === 'save' ? 'Saving...' : 'Save Draft'}
            </button>
            <button
              type="button"
              onClick={handlePropose}
              disabled={pendingAction !== null || !requiredFieldsReady}
              className="btn-primary"
            >
              <Send className="h-4 w-4" />
              {pendingAction === 'propose' ? 'Submitting...' : 'Propose for Review'}
            </button>
          </div>
        </div>
      ) : selectedPlan ? (
        <PlanDetail
          plan={selectedPlan}
          previousPlan={previousPlan}
          currentUser={currentUser}
          onReviewAction={handleReviewAction}
        />
      ) : (
        <div className="panel p-16 text-center">
          <p className="text-base font-semibold text-slate-700">No plan selected</p>
          <p className="mt-1 text-sm text-slate-500">
            Pick a version from the timeline or create a new draft plan.
          </p>
        </div>
      )}
    </div>
  );
}
