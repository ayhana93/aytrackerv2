import type { ReactNode } from 'react';
import { AdminShell } from '@aytracker/ui';
import { AdminNav } from './nav';

/**
 * Admin layout.
 *
 * The sidebar lives here rather than in each page so it is not remounted on navigation — a nav
 * that rebuilds itself on every route change loses its scroll position and flickers, which is the
 * kind of thing nobody reports and everybody feels.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <AdminShell>
      <AdminNav />
      <main className="ay-admin-main">{children}</main>
    </AdminShell>
  );
}
