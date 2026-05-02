'use client';

import { useEffect } from 'react';

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[PlanSync] Unhandled error:', error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="panel p-10 max-w-md text-center space-y-4">
        <p className="text-base font-semibold text-fg">Something went wrong</p>
        <p className="text-sm text-fg-muted">{error.message || 'An unexpected error occurred.'}</p>
        <button type="button" onClick={reset} className="btn-primary">
          Try again
        </button>
      </div>
    </div>
  );
}
