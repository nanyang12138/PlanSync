import type { Activity } from '@prisma/client';
import {
  Activity as ActivityIcon,
  AlertTriangle,
  CheckCircle2,
  GitBranch,
  MessageSquare,
  Sparkles,
  Zap,
} from 'lucide-react';

type ActivityFeedProps = {
  activities: Activity[];
};

function formatRelativeTime(date: Date): string {
  const ms = Date.now() - date.getTime();
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day > 7) return date.toLocaleDateString(undefined, { dateStyle: 'medium' });
  if (day > 0) return `${day}d`;
  if (hr > 0) return `${hr}h`;
  if (min > 0) return `${min}m`;
  return 'now';
}

function activityIcon(type: string) {
  const t = type.toLowerCase();
  if (t.includes('drift')) return { Icon: AlertTriangle, cls: 'text-amber-500 bg-amber-50' };
  if (t.includes('plan') && t.includes('activ'))
    return { Icon: Zap, cls: 'text-emerald-500 bg-emerald-50' };
  if (t.includes('plan')) return { Icon: GitBranch, cls: 'text-blue-500 bg-blue-50' };
  if (t.includes('suggestion')) return { Icon: Sparkles, cls: 'text-violet-500 bg-violet-50' };
  if (t.includes('comment') || t.includes('review'))
    return { Icon: MessageSquare, cls: 'text-slate-400 bg-slate-100' };
  if (t.includes('execution')) return { Icon: ActivityIcon, cls: 'text-cyan-500 bg-cyan-50' };
  return { Icon: CheckCircle2, cls: 'text-slate-400 bg-slate-100' };
}

export function ActivityFeed({ activities }: ActivityFeedProps) {
  if (activities.length === 0) {
    return <p className="text-sm text-slate-500 italic text-center py-4">No activity yet.</p>;
  }

  return (
    <div className="space-y-3 max-h-80 overflow-y-auto pr-2">
      {activities.map((a) => {
        const { Icon, cls } = activityIcon(a.type);
        return (
          <div key={a.id} className="flex items-start gap-3">
            <div
              className={`flex h-6 w-6 items-center justify-center rounded-md shrink-0 mt-0.5 ${cls}`}
            >
              <Icon className="h-3.5 w-3.5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-slate-600 leading-relaxed line-clamp-2">{a.summary}</p>
              <p className="text-[10px] text-slate-400 mt-0.5">{formatRelativeTime(a.createdAt)}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
