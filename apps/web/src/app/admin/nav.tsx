'use client';

import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { NavItem, Sidebar, SidebarSection } from '@aytracker/ui';
import { authApi } from '../../lib/auth';
import { useSession } from './auth-guard';
import {
  IconDashboard,
  IconFleet,
  IconHistory,
  IconGeofence,
  IconLive,
  IconPeople,
  IconRoute,
  IconSettings,
  IconSignOut,
  IconStaff,
  IconZones,
} from './icons';

/**
 * Admin navigation.
 *
 * Scoped to what this deployment tracks: people and vehicles. No entry links anywhere near
 * production, and none links to a page that does not exist or does not actually work.
 *
 * Deliberately without an open/close animation. This is used dozens of times a day, and the rule
 * from the design system is that frequency decides: a transition a supervisor sees fifty times
 * before lunch reads as lag, not polish. Only the colour of the active item moves.
 */

interface Entry {
  readonly href: string;
  readonly label: string;
  readonly icon: ReactNode;
}

const OVERVIEW: readonly Entry[] = [
  { href: '/admin', label: 'Табло', icon: IconDashboard },
  // Directly under the dashboard: "where is everyone right now" is the question this product is
  // opened for, and it should never be more than one click away.
  { href: '/admin/live', label: 'На живо', icon: IconLive },
];

const PEOPLE: readonly Entry[] = [
  { href: '/admin/people', label: 'На смяна', icon: IconPeople },
  // Above history and zones because it is the first thing a new organization needs: the other two
  // screens have nothing to show until somebody has been added here.
  { href: '/admin/staff', label: 'Персонал', icon: IconStaff },
  { href: '/admin/history', label: 'История', icon: IconHistory },
  { href: '/admin/areas', label: 'Зони и позиции', icon: IconZones },
];

const FLEET: readonly Entry[] = [
  { href: '/admin/fleet', label: 'Автопарк', icon: IconFleet },
  { href: '/admin/trips', label: 'Маршрути', icon: IconRoute },
  // "Геозони" rather than "Зони": /admin/areas already owns that word for work areas, and two
  // navigation entries a synonym apart is how somebody clicks the wrong one every time.
  { href: '/admin/geofences', label: 'Геозони', icon: IconGeofence },
];

const CONFIGURATION: readonly Entry[] = [
  { href: '/admin/settings', label: 'Настройки', icon: IconSettings },
];

export function AdminNav() {
  const pathname = usePathname();
  const router = useRouter();
  const session = useSession();

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
      <SidebarSection>Хора</SidebarSection>
      {group(PEOPLE)}
      <SidebarSection>Автопарк</SidebarSection>
      {group(FLEET)}
      <SidebarSection>Фирма</SidebarSection>
      {group(CONFIGURATION)}

      <div style={{ flex: 1 }} />

      {/*
        The tenant key, where the person who needs it will actually look.
        It is what a worker types on their own login screen, and without it here an admin has no
        way to onboard anybody — the value would exist only in a database column.
      */}
      {session.organizationSlug ? (
        <div
          style={{
            padding: 'var(--ay-space-3)',
            marginBottom: 'var(--ay-space-2)',
            borderTop: '1px solid var(--ay-nav-border)',
          }}
        >
          <div className="ay-caption" style={{ color: 'var(--ay-nav-text)' }}>
            Код за вход на работници
          </div>
          <div
            className="ay-small ay-numeric"
            style={{ color: 'var(--ay-nav-text-active)', fontWeight: 600, wordBreak: 'break-all' }}
          >
            {session.organizationSlug}
          </div>
        </div>
      ) : null}

      <NavItem
        icon={IconSignOut}
        label="Изход"
        onSelect={() => {
          void authApi.logout().finally(() => window.location.assign('/login'));
        }}
      />
    </Sidebar>
  );
}
