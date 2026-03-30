import React from 'react';

interface SummaryItem {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  trend?: {
    value: string;
    direction: 'up' | 'down' | 'neutral';
  };
  color?: 'blue' | 'emerald' | 'amber' | 'rose' | 'slate' | 'violet';
}

interface SummaryStripProps {
  items: SummaryItem[];
  className?: string;
}

const colorMap: Record<string, { bg: string; text: string; icon: string }> = {
  blue: { bg: 'bg-blue-50', text: 'text-blue-700', icon: 'text-blue-500' },
  emerald: { bg: 'bg-emerald-50', text: 'text-emerald-700', icon: 'text-emerald-500' },
  amber: { bg: 'bg-amber-50', text: 'text-amber-700', icon: 'text-amber-500' },
  rose: { bg: 'bg-rose-50', text: 'text-rose-700', icon: 'text-rose-500' },
  slate: { bg: 'bg-slate-50', text: 'text-slate-700', icon: 'text-slate-500' },
  violet: { bg: 'bg-violet-50', text: 'text-violet-700', icon: 'text-violet-500' },
};

export function SummaryStrip({ items, className = '' }: SummaryStripProps) {
  return (
    <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 ${className}`}>
      {items.map((item, index) => {
        const colors = colorMap[item.color || 'slate'];

        return (
          <div key={index} className="panel p-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-slate-500 mb-1">{item.label}</p>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold text-slate-900 tabular-nums leading-none">
                  {item.value}
                </span>
                {item.trend && (
                  <span
                    className={`text-xs font-medium ${
                      item.trend.direction === 'up'
                        ? 'text-emerald-600'
                        : item.trend.direction === 'down'
                          ? 'text-rose-600'
                          : 'text-slate-400'
                    }`}
                  >
                    {item.trend.direction === 'up'
                      ? '↑'
                      : item.trend.direction === 'down'
                        ? '↓'
                        : '→'}{' '}
                    {item.trend.value}
                  </span>
                )}
              </div>
            </div>
            {item.icon && (
              <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${colors.bg}`}>
                <div className={colors.icon}>{item.icon}</div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
