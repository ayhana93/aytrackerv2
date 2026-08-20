import type { ReactNode } from 'react';
import { AdminShell } from '@aytracker/ui';
import { AdminNav } from './nav';
import { AdminAuthGuard } from './auth-guard';

/**
 * Admin layout.
 *
 * The sidebar lives here rather than in each page so it is not remounted on navigation — a nav
 * that rebuilds itself on every route change loses its scroll position and flickers, which is the
 * kind of thing nobody reports and everybody feels.
 *
 * The auth check wraps the whole shell, sidebar included: a signed-out visitor should see the
 * login page, not a sidebar that leads to pages that will all reject them the same way.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <AdminAuthGuard>
      <AdminShell>
        <AdminNav />
        <main className="ay-admin-main">{children}</main>
      </AdminShell>
    </AdminAuthGuard>
  );
}
