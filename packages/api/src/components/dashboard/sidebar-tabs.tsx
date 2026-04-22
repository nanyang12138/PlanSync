'use client';

import { useState } from 'react';
import type { Activity } from '@prisma/client';
import { Sparkles, Activity as ActivityIcon } from 'lucide-react';
import { AiChatPanel } from './ai-chat-panel';
import { ActivityFeed } from './activity-feed';

type Tab = 'ai' | 'activity';

const TABS: { id: Tab; label: string; Icon: React.ElementType }[] = [
  { id: 'ai', label: 'AI', Icon: Sparkles },
  { id: 'activity', label: 'Activity', Icon: ActivityIcon },
];

type SidebarTabsProps = {
  projectId: string;
  activities: Activity[];
};

export function SidebarTabs({ projectId, activities }: SidebarTabsProps) {
  const [activeTab, setActiveTab] = useState<Tab>('ai');

  return (
    <div className="panel overflow-hidden flex flex-col">
      {/* Tab bar */}
      <div className="flex border-b border-slate-100 shrink-0">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors border-b-2 ${
              activeTab === id
                ? 'text-blue-600 border-blue-600 bg-white'
                : 'text-slate-500 border-transparent hover:text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* Content area — AI tab uses flex-col to pin input at bottom */}
      {activeTab === 'ai' ? (
        <div className="h-[420px] flex flex-col overflow-hidden">
          <AiChatPanel projectId={projectId} />
        </div>
      ) : (
        <div className="h-[420px] overflow-y-auto p-5">
          {activeTab === 'activity' && <ActivityFeed activities={activities} />}
        </div>
      )}
    </div>
  );
}
