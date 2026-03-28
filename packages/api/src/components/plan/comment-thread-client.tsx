'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { PlanComment } from '@prisma/client';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export type CommentNode = PlanComment & { replies: CommentNode[] };

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const sec = Math.floor(diffMs / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day > 7) {
    return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  if (day > 0) return `${day}d ago`;
  if (hr > 0) return `${hr}h ago`;
  if (min > 0) return `${min}m ago`;
  return 'just now';
}

function AuthorBadge({ type }: { type: string }) {
  const isAgent = type === 'agent';
  return (
    <span
      className={cn(
        'rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        isAgent
          ? 'border-violet-500/40 bg-violet-500/10 text-violet-800 dark:text-violet-300'
          : 'border-border bg-muted text-muted-foreground',
      )}
    >
      {isAgent ? 'agent' : 'human'}
    </span>
  );
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

  return (
    <form onSubmit={submit} className="space-y-2">
      <textarea
        autoFocus={autoFocus}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={parentId ? 3 : 4}
        placeholder={parentId ? 'Write a reply…' : 'Add a comment…'}
        className={cn(
          'w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm',
          'ring-offset-background placeholder:text-muted-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending || !content.trim()}>
          {pending ? '…' : parentId ? 'Reply' : 'Comment'}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
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
  const created = new Date(node.createdAt);

  return (
    <li className="rounded-lg border border-border bg-background/50">
      <div className={cn('space-y-2 p-4', depth > 0 && 'border-l-2 border-primary/20 pl-4')}>
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-medium">{node.authorName}</span>
          <AuthorBadge type={node.authorType} />
          <time className="text-xs text-muted-foreground" dateTime={created.toISOString()}>
            {formatRelativeTime(created)}
          </time>
        </div>
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{node.content}</p>
        <div>
          {!replyOpen ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setReplyOpen(true)}>
              Reply
            </Button>
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
        <ul className="space-y-2 border-t border-border/60 p-2 pl-4">
          {node.replies.map((r: CommentNode) => (
            <CommentBlock
              key={r.id}
              node={r}
              projectId={projectId}
              planId={planId}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

type CommentThreadClientProps = {
  roots: CommentNode[];
  projectId: string;
  planId: string;
};

export function CommentThreadClient({ roots, projectId, planId }: CommentThreadClientProps) {
  return (
    <div className="space-y-6">
      {roots.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet.</p>
      ) : (
        <ul className="space-y-3">
          {roots.map((node) => (
            <CommentBlock
              key={node.id}
              node={node}
              projectId={projectId}
              planId={planId}
              depth={0}
            />
          ))}
        </ul>
      )}

      <div className="border-t border-border pt-4">
        <h3 className="mb-2 text-sm font-semibold">Add comment</h3>
        <CommentComposer projectId={projectId} planId={planId} onDone={() => {}} />
      </div>
    </div>
  );
}
