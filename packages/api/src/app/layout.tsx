import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import './globals.css';
import { NotificationProvider } from '@/components/notifications';

export const metadata: Metadata = {
  title: 'PlanSync',
  description: 'AI Team Plan Coordination Platform',
};

type Theme = 'light' | 'dark';

// R-131 / G3 (Next.js 15): cookies() returns Promise<ReadonlyRequestCookies>
// — every call site must await; the consumer becomes async too.
async function readTheme(): Promise<Theme> {
  const c = await cookies();
  const v = c.get('plansync-theme')?.value;
  return v === 'dark' ? 'dark' : 'light';
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = await readTheme();
  return (
    <html lang="en" className={`scroll-smooth ${theme === 'dark' ? 'dark' : ''}`}>
      <body className="min-h-screen bg-background text-fg antialiased">
        <NotificationProvider>{children}</NotificationProvider>
      </body>
    </html>
  );
}
