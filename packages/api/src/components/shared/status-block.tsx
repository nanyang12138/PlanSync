import React from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';

export type StatusType = 'warning' | 'danger' | 'success' | 'info';

interface StatusBlockProps {
  type: StatusType;
  title: string;
  message?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

const config = {
  warning: {
    icon: AlertTriangle,
    bgClass: 'bg-amber-50/50',
    borderClass: 'border-amber-200',
    iconClass: 'text-amber-500',
    titleClass: 'text-amber-800',
    messageClass: 'text-amber-700/80',
  },
  danger: {
    icon: XCircle,
    bgClass: 'bg-rose-50/50',
    borderClass: 'border-rose-200',
    iconClass: 'text-rose-500',
    titleClass: 'text-rose-800',
    messageClass: 'text-rose-700/80',
  },
  success: {
    icon: CheckCircle2,
    bgClass: 'bg-emerald-50/50',
    borderClass: 'border-emerald-200',
    iconClass: 'text-emerald-500',
    titleClass: 'text-emerald-800',
    messageClass: 'text-emerald-700/80',
  },
  info: {
    icon: Info,
    bgClass: 'bg-blue-50/50',
    borderClass: 'border-blue-200',
    iconClass: 'text-blue-500',
    titleClass: 'text-blue-800',
    messageClass: 'text-blue-700/80',
  },
};

export function StatusBlock({ type, title, message, action, className = '' }: StatusBlockProps) {
  const styles = config[type];
  const Icon = styles.icon;

  return (
    <div className={`rounded-xl border p-4 ${styles.bgClass} ${styles.borderClass} ${className}`}>
      <div className="flex items-start gap-3">
        <Icon className={`h-5 w-5 shrink-0 mt-0.5 ${styles.iconClass}`} />
        <div className="flex-1 min-w-0">
          <h3 className={`text-sm font-semibold ${styles.titleClass}`}>{title}</h3>
          {message && <div className={`text-sm mt-1 ${styles.messageClass}`}>{message}</div>}
        </div>
        {action && <div className="shrink-0 ml-4">{action}</div>}
      </div>
    </div>
  );
}
