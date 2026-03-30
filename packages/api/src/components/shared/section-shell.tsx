import React from 'react';

interface SectionShellProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  icon?: React.ReactNode;
}

export function SectionShell({
  title,
  description,
  action,
  children,
  className = '',
  icon,
}: SectionShellProps) {
  return (
    <section className={`panel overflow-hidden ${className}`}>
      <div className="panel-header flex-col sm:flex-row items-start sm:items-center gap-4">
        <div className="flex items-center gap-3">
          {icon && (
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-50 text-slate-500">
              {icon}
            </div>
          )}
          <div>
            <h2 className="text-base font-semibold text-slate-900">{title}</h2>
            {description && <p className="text-sm text-slate-500 mt-0.5">{description}</p>}
          </div>
        </div>
        {action && <div className="shrink-0 w-full sm:w-auto">{action}</div>}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}
