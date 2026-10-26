import Link from 'next/link';
import type { ReactNode } from 'react';
import { SignOutButton } from './client';
import type { SessionUser } from '@/modules/tenancy';
import { Badge, cx } from './ui';
import type { PageContext } from '@/server/page-context';

/** Top bar and navigation for tenant pages. */
export function TenantShell({ ctx, current, children }: { ctx: PageContext; current?: string; children: ReactNode }) {
  const base = `/t/${ctx.tenant.slug}`;
  const nav = [
    { key: 'home', href: base, label: 'Home', show: true },
    { key: 'members', href: `${base}/settings/members`, label: 'Members', show: ctx.can('members:read') },
    { key: 'integrations', href: `${base}/settings/integrations`, label: 'Integrations', show: ctx.can('integrations:manage') },
    { key: 'ai', href: `${base}/settings/ai`, label: 'AI runs', show: ctx.can('settings:manage') },
    { key: 'audit', href: `${base}/settings/audit`, label: 'Audit', show: ctx.can('audit:read') },
    { key: 'profile', href: `${base}/profile`, label: 'Profile', show: true },
  ].filter((n) => n.show);
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2">
          <Link href={base} className="flex items-center gap-2 text-sm font-semibold">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-accent text-xs font-bold text-white">S</span>
            Scout
          </Link>
          <details className="relative">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded px-2 py-1 text-sm hover:bg-sunken">
              <span>{ctx.tenant.name}</span>
              {ctx.principal.supportAccess && <Badge tone="near">Support access</Badge>}
              <span className="text-ink-faint" aria-hidden>
                ▾
              </span>
            </summary>
            <ul className="absolute left-0 z-20 mt-1 min-w-48 rounded border border-line bg-surface p-1 shadow-pop">
              {ctx.tenants.map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/t/${t.slug}`}
                    className={cx('block rounded px-2 py-1.5 text-sm hover:bg-sunken', t.slug === ctx.tenant.slug && 'font-medium')}
                  >
                    {t.name}
                  </Link>
                </li>
              ))}
            </ul>
          </details>
          <nav className="flex flex-1 items-center gap-1" aria-label="Main">
            {nav.map((n) => (
              <Link
                key={n.key}
                href={n.href}
                className={cx(
                  'rounded px-2.5 py-1 text-sm',
                  n.key === current ? 'bg-accent-soft font-medium text-accent-ink' : 'text-ink-muted hover:bg-sunken hover:text-ink',
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            {ctx.user.platformAdmin && (
              <Link href="/admin/tenants" className="text-sm text-ink-muted hover:text-ink">
                All workspaces
              </Link>
            )}
            <span className="text-xs text-ink-muted">{ctx.user.email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}

/** Top bar for platform admin pages. */
export function AdminShell({ user, current, children }: { user: SessionUser; current: 'tenants' | 'system'; children: ReactNode }) {
  const nav = [
    { key: 'tenants', href: '/admin/tenants', label: 'Workspaces' },
    { key: 'system', href: '/admin/system', label: 'System' },
  ];
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-accent text-xs font-bold text-white">S</span>
            Scout
            <Badge tone="near">Support access</Badge>
          </div>
          <nav className="flex flex-1 items-center gap-1" aria-label="Main">
            {nav.map((n) => (
              <Link
                key={n.key}
                href={n.href}
                className={cx(
                  'rounded px-2.5 py-1 text-sm',
                  n.key === current ? 'bg-accent-soft font-medium text-accent-ink' : 'text-ink-muted hover:bg-sunken hover:text-ink',
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <span className="text-xs text-ink-muted">{user.email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
