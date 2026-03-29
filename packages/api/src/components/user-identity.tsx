'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { User } from 'lucide-react';

function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)};path=/;max-age=31536000;SameSite=Lax`;
}

export function UserIdentity() {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState('');

  useEffect(() => {
    const saved = getCookie('plansync-user');
    if (saved) {
      setCurrentUser(saved);
    } else {
      const fallback =
        typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search).get('user') || 'anonymous'
          : 'anonymous';
      setCookie('plansync-user', fallback);
      setCurrentUser(fallback);
    }
  }, []);

  function switchUser(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCookie('plansync-user', trimmed);
    setCurrentUser(trimmed);
    setEditing(false);
    router.refresh();
  }

  if (!currentUser) return null;

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          autoFocus
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') switchUser(inputValue);
            if (e.key === 'Escape') setEditing(false);
          }}
          onBlur={() => {
            if (inputValue.trim()) switchUser(inputValue);
            else setEditing(false);
          }}
          placeholder="User name"
          className="input-field !h-7 !w-28 !text-xs"
        />
      </div>
    );
  }

  return (
    <button
      onClick={() => {
        setInputValue(currentUser);
        setEditing(true);
      }}
      className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-blue-600 transition-colors rounded-lg px-2.5 py-1.5 hover:bg-slate-100"
      title="Click to switch user identity"
    >
      <div className="flex h-5 w-5 items-center justify-center rounded-md bg-slate-100">
        <User className="h-3 w-3 text-slate-400" />
      </div>
      <span className="font-medium">{currentUser}</span>
    </button>
  );
}
