'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { authApi } from '../../lib/auth';

/**
 * Gate for everything under `/admin`.
 *
 * Every admin page assumes `request.actor` is already set server-side, but the *browser* has no
 * such guarantee — a bookmark, an expired session, or a direct link can land here signed out.
 * Without this, that lands on a page full of "Сесията изтече" cards with nowhere to act on it.
 * This checks once, up front, and sends the visitor to the one place that fixes it.
 */
export function AdminAuthGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authApi
      .me()
      .then((me) => {
        if (cancelled) return;
        if (me.actorType !== 'USER') {
          // A worker or driver session exists but not an admin one — same fix, log in as an admin.
          router.replace('/login');
          return;
        }
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) router.replace('/login');
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!ready) {
    return (
      <div
        style={{
          minHeight: '100dvh',
          display: 'grid',
          placeItems: 'center',
          background: 'var(--ay-bg)',
        }}
      >
        <p className="ay-small ay-muted">Зареждане…</p>
      </div>
    );
  }

  return <>{children}</>;
}
