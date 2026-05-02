import * as React from 'react';
import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  /** Compact = inline (table cells, panel rows). Default = full panel. */
  variant?: 'panel' | 'compact';
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  variant = 'panel',
  className,
}: EmptyStateProps) {
  if (variant === 'compact') {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center gap-1 py-10 text-center',
          className,
        )}
      >
        {icon ? (
          <div className="mb-1 text-fg-subtle" aria-hidden>
            {icon}
          </div>
        ) : null}
        <p className="text-sm text-fg-muted">{title}</p>
        {description ? <p className="text-xs text-fg-subtle">{description}</p> : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    );
  }
  return (
    <div className={cn('panel p-12 text-center', className)}>
      {icon ? (
        <div
          className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-soft text-primary-soft-fg"
          aria-hidden
        >
          {icon}
        </div>
      ) : null}
      <p className="text-base font-semibold text-fg">{title}</p>
      {description ? (
        <p className="text-sm text-fg-subtle mt-1.5 mb-6 max-w-xs mx-auto">{description}</p>
      ) : null}
      {action}
    </div>
  );
}
