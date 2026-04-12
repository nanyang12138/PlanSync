import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { NotificationProvider } from '@/components/notifications';

export const metadata: Metadata = {
  title: 'PlanSync',
  description: 'AI Team Plan Coordination Platform',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="scroll-smooth">
      <body className="min-h-screen bg-background antialiased">
        <NotificationProvider>{children}</NotificationProvider>
      </body>
    </html>
  );
}
