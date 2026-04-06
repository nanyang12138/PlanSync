'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { User, LogOut } from 'lucide-react';

function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function UserIdentity() {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<string | null>(null);

  useEffect(() => {
    const saved = getCookie('plansync-user');
    setCurrentUser(saved || 'anonymous');
  }, []);

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  if (!currentUser) return null;

  return (
    <div className="flex items-center gap-1">
      <div className="flex items-center gap-1.5 text-xs text-slate-500 rounded-lg px-2.5 py-1.5">
        <div className="flex h-5 w-5 items-center justify-center rounded-md bg-slate-100">
          <User className="h-3 w-3 text-slate-400" />
        </div>
        <span className="font-medium">{currentUser}</span>
      </div>
      <button
        onClick={handleLogout}
        className="flex items-center gap-1 text-xs text-slate-400 hover:text-red-500 transition-colors rounded-lg px-2 py-1.5 hover:bg-red-50"
        title="Sign out"
      >
        <LogOut className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
