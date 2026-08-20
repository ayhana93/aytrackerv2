'use client';

import { useState, type FormEvent } from 'react';
import { Button, Card, Field, ThemeToggle } from '@aytracker/ui';
import { authApi } from '../../lib/auth';
import { ApiError } from '../../lib/api';

/**
 * Create an organization.
 *
 * One screen, five fields, no plan picker and no billing step. Everything else about the tenant —
 * the slug, the trial, the first site, the owner role — is decided by the server, so there is
 * nothing here for someone to get wrong before they have seen the product.
 *
 * The password rule is stated up front rather than after a rejected submit. A requirement you
 * only learn by failing is a requirement designed for the validator, not the person typing.
 */

const MIN_PASSWORD_LENGTH = 12;

export default function RegisterPage() {
  const [companyName, setCompanyName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    authApi
      .register({ companyName, firstName, lastName, email, password })
      .then(() => {
        // A full navigation rather than router.push: registration already set the session cookie,
        // and a fresh document load is the simplest guarantee that nothing cached the logged-out
        // state on the way in.
        window.location.assign('/admin');
      })
      .catch((caught: unknown) => {
        setSubmitting(false);
        if (caught instanceof ApiError && caught.code === 'auth.email_taken') {
          setError('Вече има регистрация с този имейл. Опитайте да влезете.');
          return;
        }
        if (caught instanceof ApiError && caught.status === 429) {
          setError('Твърде много опити. Опитайте отново по-късно.');
          return;
        }
        if (caught instanceof ApiError && caught.status === 400) {
          setError('Проверете попълнените данни и опитайте отново.');
          return;
        }
        setError('Регистрацията не беше успешна. Опитайте отново.');
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

      <Card style={{ width: '100%', maxWidth: '26rem' }}>
        <form
          onSubmit={submit}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ay-space-4)' }}
        >
          <div>
            <h1 className="ay-h3">Създайте организация</h1>
            <p className="ay-caption ay-muted" style={{ marginTop: 'var(--ay-space-1)' }}>
              30 дни безплатно. Без карта.
            </p>
          </div>

          <Field label="Фирма">
            <input
              className="ay-input"
              type="text"
              autoComplete="organization"
              required
              autoFocus
              value={companyName}
              onChange={(event) => setCompanyName(event.target.value)}
            />
          </Field>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 'var(--ay-space-3)',
            }}
          >
            <Field label="Име">
              <input
                className="ay-input"
                type="text"
                autoComplete="given-name"
                required
                value={firstName}
                onChange={(event) => setFirstName(event.target.value)}
              />
            </Field>
            <Field label="Фамилия">
              <input
                className="ay-input"
                type="text"
                autoComplete="family-name"
                required
                value={lastName}
                onChange={(event) => setLastName(event.target.value)}
              />
            </Field>
          </div>

          <Field label="Имейл">
            <input
              className="ay-input"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>

          <Field label="Парола" hint={`Поне ${MIN_PASSWORD_LENGTH} знака`}>
            <input
              className="ay-input"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              // Announced as invalid only once there is something to judge — an empty field the
              // user has not reached yet is not a mistake they have made.
              aria-invalid={tooShort || undefined}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>

          {error ? (
            <p className="ay-small" style={{ color: 'var(--ay-danger)' }} role="alert">
              {error}
            </p>
          ) : null}

          <Button type="submit" block disabled={submitting || tooShort}>
            {submitting ? 'Създаване…' : 'Създайте организация'}
          </Button>

          <p className="ay-caption ay-muted" style={{ textAlign: 'center' }}>
            Вече имате акаунт? <a href="/login">Вход</a>
          </p>
        </form>
      </Card>
    </main>
  );
}
