'use client';

// R-156: thin client wrapper around the comments POST endpoint that posts
// `{content, deliverableId}` so the comment is attached to the deliverable
// card it was written under. Kept separate from `CommentThreadClient` so
// the deliverable-timeline page can stay a server component for the
// initial render and only hydrate the small composer islands.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Send } from 'lucide-react';

export function DeliverableCommentComposer({
  projectId,
  planId,
  deliverableId,
}: {
  projectId: string;
  planId: string;
  deliverableId: string;
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
        body: JSON.stringify({ content: trimmed, deliverableId }),
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
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex gap-2">
      <input
        type="text"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Comment on this deliverable..."
        className="input-field flex-1 !text-sm"
        disabled={pending}
      />
      <button
        type="submit"
        disabled={pending || !content.trim()}
        className="btn-primary !px-2.5"
        aria-label="Post comment"
      >
        <Send className="h-3.5 w-3.5" />
      </button>
      {error && <p className="text-xs text-rose-600 ml-2 self-center">{error}</p>}
    </form>
  );
}
