'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, Field, ThemeToggle } from '@aytracker/ui';
import { ApiError } from '../lib/api';
import { PRODUCT_NAME, rememberSlug, rememberedSlug, usePublicBrand } from '../lib/brand';
import { BrandMark } from './brand-mark';

/**
 * The door into the worker and driver portals.
 *
 * Shared by both because they differ in two words and one field name, and two copies of a login
 * screen drift: one gets the lockout message, the other keeps saying "wrong PIN" for an hour.
 *
 * Written for the hand that actually uses it. The people signing in here are on a factory floor,
 * often in gloves, frequently on a shared tablet mounted by a door — so the targets are large,
 * the PIN field is numeric, and the company code is remembered on the device rather than typed at
 * the start of every shift by a person who was never told what it is.
 */

export interface StaffLoginProps {
  readonly title: string;
  readonly subtitle: string;
  /** "Служебен номер" for a worker, "Код на шофьора" for a driver. */
  readonly identifierLabel: string;
  readonly identifierHint: string;
  readonly submitLabel: string;
  /** Where to go once the session cookie is set. */
  readonly destination: string;
  readonly onSubmit: (input: {
    organizationSlug: string;
    identifier: string;
    pin: string;
  }) => Promise<unknown>;
}

export function StaffLogin({
  title,
  subtitle,
  identifierLabel,
  identifierHint,
  submitLabel,
  destination,
  onSubmit,
}: StaffLoginProps) {
  const [organizationSlug, setOrganizationSlug] = useState('');
  /**
   * Whether the company was decided by the link rather than typed.
   *
   * When it was, the field is not a field: it is a fact, rendered as text. A worker standing at a
   * terminal has no business editing which company they are signing in to, and an editable box is
   * an invitation to try — one stray keystroke and the answer becomes "грешни данни" for a person
   * whose number and PIN were both correct. It is also the setting where the shared tablet lives,
   * so whatever is typed there is typed by whoever is standing in front of it.
   *
   * `null` while the effect has not run: rendering an empty editable field for one frame and then
   * swapping it for fixed text is a visible flicker on the first screen of the product.
   */
  const [fixedCompany, setFixedCompany] = useState<boolean | null>(null);
  const [identifier, setIdentifier] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /**
   * Whose door this is.
   *
   * Fetched from the company code as soon as there is one — from the link, from what this device
   * remembers, or from what is being typed. A worker signing in should see their own company's
   * name and logo above the form, not the vendor's: the tablet by the workshop door belongs to
   * the factory, and a screen that says otherwise is a screen nobody trusts with their PIN.
   *
   * Falls back to the product name while no code has been entered — which is the only moment
   * nobody knows yet which company this is.
   */
  const brand = usePublicBrand(organizationSlug);

  useEffect(() => {
    // A link from the admin panel carries the code, which beats both typing and remembering.
    const fromLink = new URLSearchParams(window.location.search).get('org')?.trim().toLowerCase();
    if (fromLink) {
      setOrganizationSlug(fromLink);
      setFixedCompany(true);
      return;
    }
    // No code in the link: fall back to what this device used last, and let it be typed if there
    // is nothing. A locked-down field with nothing in it would be a door with no handle.
    setOrganizationSlug(rememberedSlug());
    setFixedCompany(false);
  }, []);

  const ready = organizationSlug.trim() !== '' && identifier.trim() !== '' && /^\d{4,8}$/.test(pin);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setSubmitting(true);
    setError(null);

    const slug = organizationSlug.trim().toLowerCase();

    onSubmit({ organizationSlug: slug, identifier: identifier.trim(), pin })
      .then(() => {
        rememberSlug(slug);
        // A full navigation, not router.push: the portal reads the session on mount, and a fresh
        // document load is the simplest guarantee that nothing cached the signed-out state.
        window.location.assign(destination);
      })
      .catch((caught: unknown) => {
        setSubmitting(false);
        setPin('');
        /*
         * One message for every wrong-credential path, because the server deliberately returns
         * one error for all of them. Telling someone "no such employee number" turns this form
         * into a staff directory for anyone who finds the company code.
         */
        if (caught instanceof ApiError && caught.isUnauthenticated) {
          setError('Грешни данни. Проверете кода и ПИН-а.');
          return;
        }
        if (caught instanceof ApiError && caught.status === 429) {
          setError('Твърде много опити. Изчакайте малко и опитайте отново.');
          return;
        }
        if (caught instanceof ApiError && caught.code === 'network.unreachable') {
          setError('Няма връзка със сървъра. Проверете интернет връзката.');
          return;
        }
        setError('Входът не беше успешен. Опитайте отново.');
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
        gap: 'var(--ay-space-5)',
        padding: 'var(--ay-space-5)',
        background: 'var(--ay-bg)',
      }}
    >
      <div style={{ position: 'absolute', top: 'var(--ay-space-5)', right: 'var(--ay-space-5)' }}>
        <ThemeToggle labels={{ light: 'Светла', dark: 'Тъмна', system: 'Системна' }} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--ay-space-3)' }}>
        <BrandMark
          name={brand?.organizationName ?? PRODUCT_NAME}
          logoUrl={brand?.logoUrl ?? null}
          size="hero"
        />
      </div>

      <Card style={{ width: '100%', maxWidth: '24rem' }}>
        <form
          onSubmit={submit}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ay-space-4)' }}
        >
          <div>
            <h1 className="ay-h3">{title}</h1>
            <p className="ay-caption ay-muted" style={{ marginTop: 'var(--ay-space-1)' }}>
              {subtitle}
            </p>
            {/* The organization's own words to its staff, when it has set any. */}
            {brand?.loginMessage ? (
              <p className="ay-caption" style={{ marginTop: 'var(--ay-space-2)' }}>
                {brand.loginMessage}
              </p>
            ) : null}
          </div>

          {fixedCompany === null ? null : fixedCompany ? (
            <div>
              <span className="ay-label">Фирма</span>
              {/*
                The company's name once it is known, and the code until then. The code is what
                identifies the tenant, but it is not what the person standing here calls their
                employer — showing `acme-eood-2` to somebody who works at "Акме" is a fact
                rendered as a puzzle.
              */}
              <p
                className={brand ? 'ay-small' : 'ay-small ay-numeric'}
                style={{ fontWeight: 600, marginTop: 'var(--ay-space-1)' }}
              >
                {brand?.organizationName ?? organizationSlug}
              </p>
            </div>
          ) : (
            <Field label="Код на фирмата" hint="Получавате го от вашия ръководител">
              <input
                className="ay-input"
                type="text"
                autoComplete="organization"
                inputMode="text"
                required
                value={organizationSlug}
                onChange={(event) => setOrganizationSlug(event.target.value.toLowerCase())}
              />
            </Field>
          )}

          <Field label={identifierLabel} hint={identifierHint}>
            <input
              className="ay-input"
              type="text"
              autoComplete="username"
              required
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
            />
          </Field>

          <Field label="ПИН" hint="4 до 8 цифри">
            <input
              className="ay-input"
              // `type="password"` with a numeric mode: shoulder-surfing is a real risk on a
              // shared tablet by a door, and a numeric keypad is the only keyboard worth showing
              // for four digits.
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              pattern="\d{4,8}"
              maxLength={8}
              required
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
            />
          </Field>

          {error ? (
            <p className="ay-small" style={{ color: 'var(--ay-danger)' }} role="alert">
              {error}
            </p>
          ) : null}

          <Button type="submit" size="large" block disabled={submitting || !ready}>
            {submitting ? 'Влизане…' : submitLabel}
          </Button>
        </form>
      </Card>

      <p className="ay-caption ay-subtle">
        Ръководител? <a href="/login">Вход за администратори</a>
      </p>
    </main>
  );
}
