'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
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

interface SessionValue {
  readonly session: MeResponse;
  /**
   * Re-reads `/auth/me`.
   *
   * The settings screen needs it: renaming the organization or choosing a logo changes what the
   * sidebar shows, and the sidebar renders from the session that was fetched when the shell
   * mounted. Without this the only way to see your own rename is to reload the page, which looks
   * like the save did not work.
   */
  readonly refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * The current session.
 *
 * Non-null inside the guard, which is the only place it is callable: children render only after
 * `me` resolved, so a component under `/admin` never has to handle "signed in, but we do not know
 * as whom yet".
 */
export function useSession(): MeResponse {
  return useSessionContext().session;
}

/** The session plus the way to re-read it. */
export function useSessionContext(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error('useSession must be used inside AdminAuthGuard.');
  }
  return value;
}

export function AdminAuthGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<MeResponse | null>(null);

  const refresh = useCallback(async () => {
    // Deliberately does not sign anybody out on failure: this runs after a settings save, and a
    // hiccup re-reading the session must not throw the admin back to the login screen holding a
    // change that did save.
    const me = await authApi.me().catch(() => null);
    if (me) setSession(me);
  }, []);

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

  return <SessionContext.Provider value={{ session, refresh }}>{children}</SessionContext.Provider>;
}
