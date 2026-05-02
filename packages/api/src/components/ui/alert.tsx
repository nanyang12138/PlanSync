import * as React from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';

import { cn } from '@/lib/utils';

type Intent = 'info' | 'success' | 'warning' | 'danger' | 'drift';

const INTENT_STYLES: Record<
  Intent,
  { wrap: string; icon: React.ComponentType<{ className?: string }> }
> = {
  info: {
    wrap: 'bg-info-soft text-info-soft-fg border-info/20',
    icon: Info,
  },
  success: {
    wrap: 'bg-success-soft text-success-soft-fg border-success/20',
    icon: CheckCircle2,
  },
  warning: {
    wrap: 'bg-warning-soft text-warning-soft-fg border-warning/20',
    icon: AlertTriangle,
  },
  danger: {
    wrap: 'bg-danger-soft text-danger-soft-fg border-danger/20',
    icon: XCircle,
  },
  drift: {
    wrap: 'bg-drift-soft text-drift-soft-fg border-drift/25',
    icon: AlertTriangle,
  },
};

export interface AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  intent?: Intent;
  title?: React.ReactNode;
  icon?: boolean;
  /** When true, ARIA live region (auto-announce). */
  live?: boolean;
}

export function Alert({
  intent = 'info',
  title,
  icon = true,
  live = false,
  className,
  children,
  ...props
}: AlertProps) {
  const { wrap, icon: Icon } = INTENT_STYLES[intent];
  return (
    <div
      role="alert"
      {...(live ? { 'aria-live': 'polite' } : {})}
      className={cn('flex gap-2.5 rounded-lg border px-3 py-2.5 text-xs', wrap, className)}
      {...props}
    >
      {icon ? <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : null}
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold leading-tight">{title}</p> : null}
        {children ? (
          <div className={title ? 'mt-1 leading-relaxed' : 'leading-relaxed'}>{children}</div>
        ) : null}
      </div>
    </div>
  );
}
