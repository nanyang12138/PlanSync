'use client';

import { useEffect, useState } from 'react';
import { Bot, User } from 'lucide-react';

export type RunningExecutionInfo = {
  executorName: string;
  executorType: string;
  startedAt: string; // ISO string
} | null;

function formatElapsed(startIso: string) {
  const ms = Math.max(0, Date.now() - new Date(startIso).getTime());
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function LiveExecutionBanner({ run }: { run: RunningExecutionInfo }) {
  // Initialize to empty to avoid hydration mismatch (Date.now() differs server vs client)
  const [elapsed, setElapsed] = useState('');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (!run) return;
    setElapsed(formatElapsed(run.startedAt));
    const timer = setInterval(() => setElapsed(formatElapsed(run.startedAt)), 1000);
    return () => clearInterval(timer);
  }, [run]);

  if (!run || !mounted) return null;

  const isAgent = run.executorType === 'agent';

  return (
    <div className="flex items-center gap-3 rounded-xl border border-blue-200 bg-blue-50/80 p-4 fade-in">
      <span className="relative flex h-3 w-3 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
      </span>

      <div className="flex flex-1 items-center gap-2 min-w-0">
        {isAgent ? (
          <Bot className="h-4 w-4 text-violet-500 shrink-0" />
        ) : (
          <User className="h-4 w-4 text-slate-500 shrink-0" />
        )}
        <span className="text-sm font-medium text-slate-700 truncate">{run.executorName}</span>
        <span className={`badge text-[10px] ${isAgent ? 'badge-violet' : 'badge-neutral'}`}>
          {isAgent ? 'Agent' : 'Human'}
        </span>
        <span className="text-xs text-slate-400">is currently executing</span>
      </div>

      <span className="text-xs font-mono text-blue-600 tabular-nums shrink-0">{elapsed}</span>
    </div>
  );
}
