'use client';

import { useState, type FormEvent } from 'react';
import { Button, Card, Field, ThemeToggle } from '@aytracker/ui';
import { authApi } from '../../lib/auth';
import { ApiError } from '../../lib/api';

/**
 * Admin login.
 *
 * The one door into the admin app. Everything under `/admin` assumes a session already exists —
 * this is where one gets created, and the only place a wrong password is expected and handled
 * rather than surfaced as a generic "could not load" error.
 */
export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    authApi
      .login(email, password)
      .then(() => {
        // A full navigation, not router.push: the admin shell reads the session on mount, and a
        // fresh document load is the simplest way to guarantee nothing cached the logged-out state.
        window.location.assign('/admin');
      })
      .catch((caught: unknown) => {
        setSubmitting(false);
        if (caught instanceof ApiError && caught.isUnauthenticated) {
          setError('Грешен имейл или парола.');
          return;
        }
        setError('Неуспешен вход. Опитайте отново.');
      });
  };

  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--ay-space-6)',
        padding: 'var(--ay-space-5)',
        background: 'var(--ay-bg)',
      }}
    >
      <div style={{ position: 'absolute', top: 'var(--ay-space-5)', right: 'var(--ay-space-5)' }}>
        <ThemeToggle labels={{ light: 'Светла', dark: 'Тъмна', system: 'Системна' }} />
      </div>

      <div
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--ay-space-3)' }}
        aria-hidden="true"
      >
        <span className="ay-sidebar-mark" style={{ width: '2.5rem', height: '2.5rem' }}>
          A
        </span>
        <span className="ay-h2" style={{ fontWeight: 650, letterSpacing: '-0.01em' }}>
          AYTRACKER
        </span>
      </div>

      <Card style={{ width: '100%', maxWidth: '22rem' }}>
        <form
          onSubmit={submit}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ay-space-4)' }}
        >
          <div>
            <h1 className="ay-h3">Вход за администратори</h1>
            <p className="ay-caption ay-muted" style={{ marginTop: 'var(--ay-space-1)' }}>
              Проследяване на персонал и автопарк
            </p>
          </div>

          <Field label="Имейл">
            <input
              className="ay-input"
              type="email"
              autoComplete="username"
              required
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>

          <Field label="Парола">
            <input
              className="ay-input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>

          {error ? (
            <p className="ay-small" style={{ color: 'var(--ay-danger)' }} role="alert">
              {error}
            </p>
          ) : null}

          <Button type="submit" block disabled={submitting}>
            {submitting ? 'Влизане…' : 'Вход'}
          </Button>
        </form>
      </Card>
    </main>
  );
}
