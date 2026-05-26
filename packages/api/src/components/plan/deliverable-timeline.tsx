// R-156: Per-plan Deliverable status timeline.
//
// Renders one card per `PlanDeliverable` on the active/selected plan with:
//   - status badge (active / draft / done / deprecated)
//   - the historical "supersededBy" chain (rendered as ← → arrows so the
//     reader can follow when a deliverable was replaced by a newer row)
//   - the tasks that reference the deliverable via the R-153
//     `TaskDeliverableLink` join (so owners can see "what is being worked
//     on against this deliverable" at a glance)
//   - per-deliverable comment thread (R-156 backend adds
//     `PlanComment.deliverableId`); the existing `CommentThread` server
//     component is reused but scoped to comments where
//     `deliverableId === d.id`.
//
// This is a server component — Next.js renders it inside a server-rendered
// page so the plan + deliverable + task + comment queries all share the
// page-level Prisma round trip. The composer underneath is a thin client
// wrapper that posts `{content, deliverableId}` to the comments endpoint.
import type { PlanDeliverable, Task, PlanComment } from '@prisma/client';
import { FileText, Layers, ListChecks, Archive } from 'lucide-react';
import { DeliverableCommentComposer } from './deliverable-comment-composer';

export type DeliverableWithLinks = PlanDeliverable & {
  taskLinks: Array<{ task: Pick<Task, 'id' | 'title' | 'status'> }>;
  // The R-156 backend exposes `comments` filtered by deliverableId; the
  // page route is the one that does the actual `findMany` so we accept
  // them as a prop instead of querying again here.
  comments: PlanComment[];
  // R-150: a deliverable can be superseded by a newer row in the SAME
  // plan (e.g. "merge two milestones into one"). We render the chain so
  // owners can see history.
  supersededBy: Pick<PlanDeliverable, 'id' | 'slug' | 'title'> | null;
  // The reverse chain — newer rows that point at this one.
  supersedes: Array<Pick<PlanDeliverable, 'id' | 'slug' | 'title'>>;
};

function statusBadge(status: string) {
  switch (status) {
    case 'active':
      return 'badge-brand';
    case 'done':
      return 'badge-success';
    case 'deprecated':
      return 'badge-neutral';
    case 'draft':
      return 'badge-violet';
    default:
      return 'badge-neutral';
  }
}

function taskStatusBadge(status: string) {
  switch (status) {
    case 'done':
      return 'badge-success';
    case 'in_progress':
      return 'badge-brand';
    case 'blocked':
      return 'badge-warning';
    case 'cancelled':
      return 'badge-neutral';
    default:
      return 'badge-neutral';
  }
}

function DeliverableCard({
  projectId,
  planId,
  deliverable,
}: {
  projectId: string;
  planId: string;
  deliverable: DeliverableWithLinks;
}) {
  const visibleComments = deliverable.comments.filter((c) => !c.isDeleted);

  return (
    <article className="panel p-5 space-y-4" data-testid={`deliverable-card-${deliverable.slug}`}>
      <header className="flex flex-wrap items-start gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-slate-100 shrink-0">
          <FileText className="h-4 w-4 text-slate-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-slate-900 break-words">
              {deliverable.title}
            </h3>
            <span className={`badge ${statusBadge(deliverable.status)} uppercase`}>
              {deliverable.status}
            </span>
            <code className="text-xs font-mono text-slate-400">{deliverable.slug}</code>
          </div>
          {deliverable.body && (
            <p className="mt-1 text-sm text-slate-600 leading-relaxed whitespace-pre-wrap break-words">
              {deliverable.body}
            </p>
          )}
          {deliverable.refUri && (
            <p className="mt-1 text-xs text-slate-400 font-mono break-all">
              {deliverable.refType ?? 'ref'} → {deliverable.refUri}
            </p>
          )}
        </div>
      </header>

      {(deliverable.supersededBy || deliverable.supersedes.length > 0) && (
        <section>
          <div className="flex items-center gap-2 mb-2">
            <Archive className="h-3.5 w-3.5 text-slate-400" />
            <span className="section-label">Supersession chain</span>
          </div>
          <ul className="space-y-1 text-xs text-slate-500">
            {deliverable.supersedes.length > 0 && (
              <li>
                Replaces:{' '}
                {deliverable.supersedes.map((s, i) => (
                  <span key={s.id}>
                    <code className="font-mono text-slate-600">{s.slug}</code>
                    {i < deliverable.supersedes.length - 1 ? ', ' : ''}
                  </span>
                ))}
              </li>
            )}
            {deliverable.supersededBy && (
              <li>
                Superseded by:{' '}
                <code className="font-mono text-slate-600">{deliverable.supersededBy.slug}</code>
              </li>
            )}
          </ul>
        </section>
      )}

      <section>
        <div className="flex items-center gap-2 mb-2">
          <ListChecks className="h-3.5 w-3.5 text-slate-400" />
          <span className="section-label">Tasks ({deliverable.taskLinks.length})</span>
        </div>
        {deliverable.taskLinks.length === 0 ? (
          <p className="text-xs text-slate-400 italic">No tasks reference this deliverable yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {deliverable.taskLinks.map(({ task }) => (
              <li key={task.id} className="flex items-center gap-2 text-sm">
                <span className={`badge ${taskStatusBadge(task.status)} uppercase shrink-0`}>
                  {task.status}
                </span>
                <span className="text-slate-700 truncate">{task.title}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="flex items-center gap-2 mb-2">
          <Layers className="h-3.5 w-3.5 text-slate-400" />
          <span className="section-label">Discussion ({visibleComments.length})</span>
        </div>
        {visibleComments.length === 0 ? (
          <p className="text-xs text-slate-400 italic mb-2">
            No comments yet. Use the box below to start the thread.
          </p>
        ) : (
          <ul className="space-y-2 mb-2">
            {visibleComments.map((c) => (
              <li key={c.id} className="rounded-md bg-slate-50 px-3 py-2">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium text-slate-700">{c.authorName}</span>
                  <span className="text-[11px] text-slate-400">
                    {new Date(c.createdAt).toLocaleString(undefined, {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </span>
                  {c.authorType === 'agent' && (
                    <span className="badge badge-violet uppercase">agent</span>
                  )}
                </div>
                <p className="text-sm text-slate-700 whitespace-pre-wrap break-words">
                  {c.content}
                </p>
              </li>
            ))}
          </ul>
        )}
        <DeliverableCommentComposer
          projectId={projectId}
          planId={planId}
          deliverableId={deliverable.id}
        />
      </section>
    </article>
  );
}

export function DeliverableTimeline({
  projectId,
  planId,
  deliverables,
}: {
  projectId: string;
  planId: string;
  deliverables: DeliverableWithLinks[];
}) {
  if (deliverables.length === 0) {
    return (
      <div className="panel p-6 text-center">
        <p className="text-base font-semibold text-slate-900">No deliverables defined yet</p>
        <p className="mt-1 text-sm text-slate-500">
          Add deliverables to the plan to see them grouped by status with their tasks and discussion
          thread.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="deliverable-timeline">
      {deliverables.map((d) => (
        <DeliverableCard key={d.id} projectId={projectId} planId={planId} deliverable={d} />
      ))}
    </div>
  );
}
