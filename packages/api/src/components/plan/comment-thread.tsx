import type { PlanComment } from '@prisma/client';
import { CommentThreadClient, type CommentNode } from './comment-thread-client';

function buildCommentTree(comments: PlanComment[]): CommentNode[] {
  const visible = comments.filter((c) => !c.isDeleted);
  const map = new Map<string, CommentNode>();
  for (const c of visible) {
    map.set(c.id, { ...c, replies: [] });
  }
  const roots: CommentNode[] = [];
  for (const c of visible) {
    const node = map.get(c.id);
    if (!node) continue;
    if (c.parentId && map.has(c.parentId)) {
      map.get(c.parentId)!.replies.push(node);
    } else {
      roots.push(node);
    }
  }
  function sortRec(nodes: CommentNode[]) {
    nodes.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const n of nodes) sortRec(n.replies);
  }
  sortRec(roots);
  return roots;
}

type CommentThreadProps = {
  projectId: string;
  planId: string;
  comments: PlanComment[];
};

export function CommentThread({ projectId, planId, comments }: CommentThreadProps) {
  const tree = buildCommentTree(comments);

  return (
    <section className="rounded-xl border border-border bg-card p-6 shadow-sm">
      <h2 className="mb-4 text-lg font-semibold">Discussion</h2>
      <CommentThreadClient roots={tree} projectId={projectId} planId={planId} />
    </section>
  );
}
