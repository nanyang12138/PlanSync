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

function readTheme(): Theme {
  const v = cookies().get('plansync-theme')?.value;
  return v === 'dark' ? 'dark' : 'light';
}

export default function RootLayout({ children }: { children: ReactNode }) {
  const theme = readTheme();
  return (
    <html lang="en" className={`scroll-smooth ${theme === 'dark' ? 'dark' : ''}`}>
      <body className="min-h-screen bg-background text-fg antialiased">
        <NotificationProvider>{children}</NotificationProvider>
      </body>
    </html>
  );
}
