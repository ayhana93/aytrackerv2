'use client';

import { usePathname, useRouter } from 'next/navigation';
import { NavItem, Sidebar, SidebarSection } from '@aytracker/ui';
import { authApi } from '../../lib/auth';

/**
 * Admin navigation.
 *
 * Scoped to what this deployment actually tracks: people and vehicles. No entry links anywhere
 * production, and none links to a page that does not exist or does not actually work — the
 * previous version pointed at `/admin/production`, `/admin/workforce`, `/admin/positions` and
 * `/admin/billing`, none of which had a route behind them, and at `/admin/settings`, which had a
 * page but no backend to save to, so it accepted a new brand colour and quietly discarded it.
 *
 * Deliberately without an open/close animation. This is used dozens of times a day, and the rule
 * from the design system is that frequency decides: a transition a supervisor sees fifty times
 * before lunch reads as lag, not polish. Only the colour of the active item moves.
 */

interface Entry {
  readonly href: string;
  readonly label: string;
  readonly icon: string;
}

const OVERVIEW: readonly Entry[] = [{ href: '/admin', label: 'Табло', icon: '▤' }];

const TRACKING: readonly Entry[] = [
  { href: '/admin/people', label: 'Хора', icon: '☺' },
  { href: '/admin/fleet', label: 'Автопарк', icon: '⛟' },
  { href: '/admin/trips', label: 'Маршрути', icon: '⇄' },
];

export function AdminNav() {
  const pathname = usePathname();
  const router = useRouter();

  const group = (entries: readonly Entry[]) =>
    entries.map((entry) => (
      <NavItem
        key={entry.href}
        icon={entry.icon}
        label={entry.label}
        // Exact match, not `startsWith`: with a prefix test "/admin" would light up on every page.
        active={pathname === entry.href}
        onSelect={() => router.push(entry.href)}
      />
    ));

  return (
    <Sidebar
      brand={
        <>
          <span className="ay-sidebar-mark" aria-hidden="true">
            A
          </span>
          <span style={{ fontWeight: 650, letterSpacing: '-0.01em' }}>AYTRACKER</span>
        </>
      }
    >
      {group(OVERVIEW)}
      <SidebarSection>Проследяване</SidebarSection>
      {group(TRACKING)}
      <div style={{ flex: 1 }} />
      <NavItem
        icon="⏻"
        label="Изход"
        onSelect={() => {
          void authApi.logout().finally(() => window.location.assign('/login'));
        }}
      />
    </Sidebar>
  );
}
