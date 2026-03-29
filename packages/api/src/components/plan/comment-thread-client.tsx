'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { PlanComment } from '@prisma/client';
import { Bot, User, Send } from 'lucide-react';

export type CommentNode = PlanComment & { replies: CommentNode[] };

function formatRelativeTime(date: Date): string {
  const ms = Date.now() - date.getTime();
  const min = Math.floor(ms / 60000);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day > 7) return date.toLocaleDateString(undefined, { dateStyle: 'medium' });
  if (day > 0) return `${day}d ago`;
  if (hr > 0) return `${hr}h ago`;
  if (min > 0) return `${min}m ago`;
  return 'just now';
}

function CommentComposer({
  projectId,
  planId,
  parentId,
  onDone,
  autoFocus,
  onCancel,
}: {
  projectId: string;
  planId: string;
  parentId?: string;
  onDone: () => void;
  autoFocus?: boolean;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const [content, setContent] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = content.trim();
    if (!trimmed) return;
    setError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: trimmed,
          ...(parentId ? { parentId } : {}),
        }),
        credentials: 'include',
      });
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
      setContent('');
      onDone();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setPending(false);
    }
  }

  if (parentId) {
    return (
      <form onSubmit={submit} className="space-y-2 mt-2">
        <textarea
          autoFocus={autoFocus}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={2}
          placeholder="Write a reply..."
          className="input-field !h-auto py-2 text-sm resize-y"
        />
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={pending || !content.trim()}
            className="btn-primary !text-xs"
          >
            {pending ? '...' : 'Reply'}
          </button>
          {onCancel && (
            <button type="button" onClick={onCancel} className="btn-secondary !text-xs">
              Cancel
            </button>
          )}
        </div>
        {error && <p className="text-xs text-rose-600">{error}</p>}
      </form>
    );
  }

  return (
    <form onSubmit={submit} className="flex gap-2">
      <input
        type="text"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Add a comment..."
        className="input-field flex-1"
      />
      <button type="submit" disabled={pending || !content.trim()} className="btn-primary !px-2.5">
        <Send className="h-3.5 w-3.5" />
      </button>
      {error && <p className="text-xs text-rose-600 ml-2">{error}</p>}
    </form>
  );
}

function CommentBlock({
  node,
  projectId,
  planId,
  depth,
}: {
  node: CommentNode;
  projectId: string;
  planId: string;
  depth: number;
}) {
  const [replyOpen, setReplyOpen] = useState(false);
  const isAgent = node.authorType === 'agent';

  return (
    <div className={depth > 0 ? 'ml-5 border-l-2 border-slate-100 pl-4' : ''}>
      <div>
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-5 w-5 items-center justify-center rounded-md bg-slate-100 shrink-0">
            {isAgent ? (
              <Bot className="h-3 w-3 text-violet-400" />
            ) : (
              <User className="h-3 w-3 text-slate-400" />
            )}
          </div>
          <span className="text-sm font-medium text-slate-700">{node.authorName}</span>
          <span className="text-xs text-slate-400">
            {formatRelativeTime(new Date(node.createdAt))}
          </span>
        </div>
        <p className="text-sm text-slate-600 leading-relaxed pl-7">{node.content}</p>
        <div className="pl-7 mt-1.5">
          {!replyOpen ? (
            <button
              onClick={() => setReplyOpen(true)}
              className="text-xs text-slate-400 hover:text-blue-600 transition-colors font-medium"
            >
              Reply
            </button>
          ) : (
            <CommentComposer
              projectId={projectId}
              planId={planId}
              parentId={node.id}
              autoFocus
              onDone={() => setReplyOpen(false)}
              onCancel={() => setReplyOpen(false)}
            />
          )}
        </div>
      </div>
      {node.replies.length > 0 && (
        <div className="space-y-3 mt-3">
          {node.replies.map((r: CommentNode) => (
            <CommentBlock
              key={r.id}
              node={r}
              projectId={projectId}
              planId={planId}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type CommentThreadClientProps = {
  roots: CommentNode[];
  projectId: string;
  planId: string;
};

export function CommentThreadClient({ roots, projectId, planId }: CommentThreadClientProps) {
  return (
    <div className="space-y-4">
      {roots.length === 0 ? (
        <p className="text-sm text-slate-400 italic">No comments yet.</p>
      ) : (
        <div className="space-y-3 max-h-56 overflow-y-auto mb-4">
          {roots.map((node) => (
            <CommentBlock
              key={node.id}
              node={node}
              projectId={projectId}
              planId={planId}
              depth={0}
            />
          ))}
        </div>
      )}

      <CommentComposer projectId={projectId} planId={planId} onDone={() => {}} />
    </div>
  );
}
