'use client';

import { usePathname, useRouter } from 'next/navigation';
import { NavItem, Sidebar, SidebarSection } from '@aytracker/ui';

/**
 * Admin navigation.
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

const OPERATIONS: readonly Entry[] = [
  { href: '/admin', label: 'Табло', icon: '▤' },
  { href: '/admin/production', label: 'Производство', icon: '◱' },
  { href: '/admin/workforce', label: 'Персонал', icon: '☺' },
  { href: '/admin/positions', label: 'Позиции', icon: '⌗' },
];

const FLEET: readonly Entry[] = [
  { href: '/admin/fleet', label: 'Автопарк', icon: '⛟' },
  { href: '/admin/trips', label: 'Маршрути', icon: '⇄' },
];

const SETTINGS: readonly Entry[] = [
  { href: '/admin/settings', label: 'Брандиране', icon: '◐' },
  { href: '/admin/billing', label: 'Абонамент', icon: '▦' },
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
      {group(OPERATIONS)}
      <SidebarSection>Автопарк</SidebarSection>
      {group(FLEET)}
      <SidebarSection>Настройки</SidebarSection>
      {group(SETTINGS)}
    </Sidebar>
  );
}
