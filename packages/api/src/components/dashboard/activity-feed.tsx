import type { Activity } from '@prisma/client';
import {
  Activity as ActivityIcon,
  AlertTriangle,
  CheckCircle2,
  FileText,
  GitBranch,
  MessageSquare,
  Sparkles,
  UserMinus,
  UserPlus,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type ActivityFeedProps = {
  activities: Activity[];
};

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

function activityVisual(type: string) {
  const t = type.toLowerCase();
  if (t.includes('drift')) {
    return {
      Icon: AlertTriangle,
      wrap: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    };
  }
  if (t.includes('plan') && t.includes('activ')) {
    return { Icon: Zap, wrap: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' };
  }
  if (t.includes('plan')) {
    return { Icon: GitBranch, wrap: 'bg-primary/15 text-primary' };
  }
  if (t.includes('suggestion')) {
    return { Icon: Sparkles, wrap: 'bg-violet-500/15 text-violet-700 dark:text-violet-300' };
  }
  if (t.includes('review')) {
    return { Icon: MessageSquare, wrap: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' };
  }
  if (t.includes('member_added') || t.includes('claimed')) {
    return { Icon: UserPlus, wrap: 'bg-blue-500/15 text-blue-700 dark:text-blue-300' };
  }
  if (t.includes('member_removed')) {
    return { Icon: UserMinus, wrap: 'bg-muted text-muted-foreground' };
  }
  if (t.includes('execution')) {
    return { Icon: ActivityIcon, wrap: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300' };
  }
  if (t.includes('task')) {
    return { Icon: FileText, wrap: 'bg-secondary text-secondary-foreground' };
  }
  return { Icon: CheckCircle2, wrap: 'bg-muted text-muted-foreground' };
}

function actorBadge(actorType: string) {
  const t = actorType.toLowerCase();
  if (t === 'system') return 'text-xs text-muted-foreground';
  if (t === 'agent') return 'text-xs font-medium text-violet-600 dark:text-violet-400';
  return 'text-xs font-medium text-foreground';
}

export function ActivityFeed({ activities }: ActivityFeedProps) {
  if (activities.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
        No activity yet.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {activities.map((a) => {
        const { Icon, wrap } = activityVisual(a.type);
        return (
          <li
            key={a.id}
            className={cn(
              'flex gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm',
            )}
          >
            <span
              className={cn(
                'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
                wrap,
              )}
            >
              <Icon className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0">
                <span className={cn('truncate', actorBadge(a.actorType))}>{a.actorName}</span>
                <span className="text-xs text-muted-foreground">
                  · {formatRelativeTime(a.createdAt)}
                </span>
              </div>
              <p className="text-sm leading-snug">{a.summary}</p>
              <p className="text-xs capitalize text-muted-foreground">
                {a.type.replace(/_/g, ' ')}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
