import type { PlanComment } from '@prisma/client';
import { MessageSquare } from 'lucide-react';
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
    <div className="panel p-5">
      <div className="flex items-center gap-2 mb-4">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-slate-100">
          <MessageSquare className="h-3.5 w-3.5 text-slate-400" />
        </div>
        <span className="section-label">Discussion</span>
        <span className="ml-auto text-xs text-slate-400">
          {comments.filter((c) => !c.isDeleted).length} comments
        </span>
      </div>
      <CommentThreadClient roots={tree} projectId={projectId} planId={planId} />
    </div>
  );
}
