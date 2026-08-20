'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { authApi, type MeResponse } from '../../lib/auth';

/**
 * Gate for everything under `/admin`.
 *
 * Every admin page assumes `request.actor` is already set server-side, but the *browser* has no
 * such guarantee — a bookmark, an expired session, or a direct link can land here signed out.
 * Without this, that lands on a page full of "Сесията изтече" cards with nowhere to act on it.
 * This checks once, up front, and sends the visitor to the one place that fixes it.
 *
 * The answer is then published on a context rather than thrown away. The shell needs the
 * organization slug and the sidebar needs the feature list, and both were about to re-request
 * `/auth/me` to get facts this component already had in hand.
 */

const SessionContext = createContext<MeResponse | null>(null);

/**
 * The current session.
 *
 * Non-null inside the guard, which is the only place it is callable: children render only after
 * `me` resolved, so a component under `/admin` never has to handle "signed in, but we do not know
 * as whom yet".
 */
export function useSession(): MeResponse {
  const session = useContext(SessionContext);
  if (!session) {
    throw new Error('useSession must be used inside AdminAuthGuard.');
  }
  return session;
}

export function AdminAuthGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<MeResponse | null>(null);

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
        setSession(me);
      })
      .catch(() => {
        if (!cancelled) router.replace('/login');
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!session) {
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

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}
