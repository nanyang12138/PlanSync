'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { UserIdentity } from '@/components/user-identity';

interface NavItem {
  label: string;
  href: string;
  icon?: React.ReactNode;
}

interface PageHeaderProps {
  breadcrumbs?: React.ReactNode;
  title?: React.ReactNode;
  navigation?: NavItem[];
  actions?: React.ReactNode;
}

export function PageHeader({ breadcrumbs, title, navigation, actions }: PageHeaderProps) {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="page-header">
      <div className="mx-auto flex max-w-7xl flex-col px-6 py-3">
        {/* Top Row: Breadcrumbs, Title, Actions */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {breadcrumbs}
            {title && <div className="truncate">{title}</div>}
          </div>

          <div className="flex items-center gap-3">
            {actions}
            <div className="sm:hidden">
              <UserIdentity />
            </div>
            <div className="hidden sm:flex items-center gap-3 border-l border-slate-200 pl-3">
              <UserIdentity />
              <div className="flex items-center gap-1.5 text-xs text-emerald-600 font-medium bg-emerald-50 rounded-full px-2.5 py-1">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
                </span>
                Live
              </div>
            </div>

            {/* Mobile Menu Toggle */}
            {navigation && navigation.length > 0 && (
              <button
                className="sm:hidden btn-ghost !px-2 !py-1.5"
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              >
                {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
              </button>
            )}
          </div>
        </div>

        {/* Desktop Navigation Tabs */}
        {navigation && navigation.length > 0 && (
          <nav className="hidden sm:flex items-center gap-6 mt-4 -mb-3">
            {navigation.map((item) => {
              const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-2 pb-3 text-sm font-medium border-b-2 transition-colors ${
                    isActive
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300'
                  }`}
                >
                  {item.icon}
                  {item.label}
                </Link>
              );
            })}
          </nav>
        )}

        {/* Mobile Navigation Dropdown */}
        {navigation && navigation.length > 0 && mobileMenuOpen && (
          <nav className="sm:hidden flex flex-col gap-1 mt-4 pt-4 border-t border-slate-100 pb-2">
            <div className="mb-2 flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2.5">
              <UserIdentity />
              <div className="flex items-center gap-1.5 text-xs text-emerald-600 font-medium bg-emerald-50 rounded-full px-2.5 py-1">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
                </span>
                Live
              </div>
            </div>
            {navigation.map((item) => {
              const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`}
                >
                  {item.icon}
                  {item.label}
                </Link>
              );
            })}
          </nav>
        )}
      </div>
    </header>
  );
}
