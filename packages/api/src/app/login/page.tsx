'use client';

import { useState } from 'react';
import { GitBranch, LogIn } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Alert } from '@/components/ui/alert';
import { ThemeToggle } from '@/components/theme-toggle';

export default function LoginPage() {
  const [userName, setUserName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userName: userName.trim(), password }),
      });

      if (res.ok) {
        window.location.href = '/';
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Login failed');
      }
    } catch {
      setError('Network error, please try again');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-surface-2 to-surface-3 relative">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-agent shadow-lg shadow-primary/25 mb-3"
            aria-hidden
          >
            <GitBranch className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-xl font-bold text-fg">PlanSync</h1>
          <p className="text-sm text-fg-muted mt-0.5">Where Plans Meet Execution</p>
        </div>

        {/* Card */}
        <main
          className="bg-surface-1 rounded-2xl shadow-sm border border-subtle p-6"
          aria-labelledby="login-heading"
        >
          <h2 id="login-heading" className="text-base font-semibold text-fg mb-4">
            Sign In
          </h2>

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div>
              <label
                htmlFor="login-username"
                className="block text-xs font-medium text-fg-muted mb-1.5"
              >
                Username
              </label>
              <input
                id="login-username"
                type="text"
                autoComplete="username"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder="your-name"
                required
                autoFocus
                disabled={loading}
                aria-invalid={Boolean(error)}
                className="input-field w-full"
              />
            </div>

            <div>
              <label
                htmlFor="login-password"
                className="block text-xs font-medium text-fg-muted mb-1.5"
              >
                Password
              </label>
              <input
                id="login-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                disabled={loading}
                aria-invalid={Boolean(error)}
                aria-describedby="login-password-hint"
                className="input-field w-full"
              />
              <p id="login-password-hint" className="text-xs text-fg-subtle mt-1.5">
                First login: choose any password to create your account
              </p>
            </div>

            {error && (
              <Alert intent="danger" live>
                {error}
              </Alert>
            )}

            <button
              type="submit"
              disabled={loading || !userName.trim() || !password}
              className="btn-primary w-full flex items-center justify-center gap-2 !py-2"
            >
              {loading ? (
                <Spinner size="sm" className="text-primary-foreground" />
              ) : (
                <LogIn className="h-4 w-4" aria-hidden />
              )}
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
        </main>
      </div>
    </div>
  );
}
