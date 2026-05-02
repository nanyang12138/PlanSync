'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Moon, Sun } from 'lucide-react';

import { cn } from '@/lib/utils';

type Theme = 'light' | 'dark';

function readCookieTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  const m = document.cookie.match(/(?:^|; )plansync-theme=([^;]*)/);
  if (!m) return 'light';
  try {
    return decodeURIComponent(m[1]) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function writeCookieTheme(value: Theme) {
  // 1 year, root path, lax — same scope as plansync-user
  const maxAge = 60 * 60 * 24 * 365;
  document.cookie = `plansync-theme=${value}; max-age=${maxAge}; path=/; samesite=lax`;
}

interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  const router = useRouter();
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    setTheme(readCookieTheme());
  }, []);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    writeCookieTheme(next);
    // Apply immediately on client (avoids waiting for full reload)
    document.documentElement.classList.toggle('dark', next === 'dark');
    // Re-render server components so cookie-driven UI elsewhere updates
    router.refresh();
  }

  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggle}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-lg border border-subtle bg-surface-1 text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg',
        className,
      )}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
