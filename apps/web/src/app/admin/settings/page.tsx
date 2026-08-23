'use client';

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  AdminBody,
  AdminHeader,
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  ThemeToggle,
} from '@aytracker/ui';
import {
  adminApi,
  describeError,
  useApi,
  type LogoRow,
  type MemberRow,
  type OrganizationProfile,
  type SettingsResponse,
} from '../../../lib/admin';
import { ApiError } from '../../../lib/api';
import { BrandMark } from '../../../components/brand-mark';
import { PRODUCT_NAME } from '../../../lib/brand';
import { useSessionContext } from '../auth-guard';

/**
 * Settings.
 *
 * Two kinds of thing live here, and they are deliberately on one screen rather than two: who the
 * organization *is* (name, logo, administrators) and how the product *behaves* for it (the fuel
 * price, shift policy, the GPS sampling floor, the speed limit and the geofence tuning). An
 * operations manager opening "Настройки" is looking for whichever of those they need, and making
 * them guess which of two screens it is on is a worse split than a longer page.
 *
 * Three things an organization has to be able to change about itself without asking anybody:
 * what it is called, what its logo is, and which address its administrators sign in with. Until
 * now all three lived in database columns with no screen attached — a customer whose company was
 * renamed had a product that still called them by the old name for ever.
 *
 * The name is the load-bearing one. It is not a label on this page: it replaces the product's own
 * name in the sidebar, on both staff login screens and in the worker and driver portals. Changing
 * it here re-brands every screen the customer's own people look at, which is why the save
 * refreshes the session rather than waiting for the next page load to reveal it.
 *
 * Each section is gated on its own permission and hidden — not disabled — when the signed-in user
 * lacks it. A greyed-out form is a promise that the button might work; an absent section says
 * plainly that this is somebody else's job.
 */

/** Matches `MAX_LOGO_BYTES` in the API. Checked here too, so a phone photo fails before upload. */
const MAX_LOGO_BYTES = 512 * 1024;

const ACCEPTED_TYPES = 'image/png,image/jpeg,image/webp,image/gif';

export default function SettingsPage() {
  const { session, refresh } = useSessionContext();
  const may = (permission: string) => session.permissions.includes(permission);

  const [version, setVersion] = useState(0);
  const reload = () => setVersion((current) => current + 1);

  return (
    <>
      <AdminHeader
        title="Настройки"
        subtitle="Име, лого и достъп на вашата организация"
        actions={<ThemeToggle labels={{ light: 'Светла', dark: 'Тъмна', system: 'Системна' }} />}
      />

      <AdminBody>
        {may('organization.read') ? (
          <OrganizationSection
            version={version}
            editable={may('organization.update')}
            onSaved={() => {
              reload();
              void refresh();
            }}
          />
        ) : null}

        {may('branding.read') ? (
          <LogoSection
            version={version}
            organizationName={session.organizationName ?? PRODUCT_NAME}
            editable={may('branding.update')}
            onChanged={() => {
              reload();
              void refresh();
            }}
          />
        ) : null}

        {may('users.manage') ? <MembersSection version={version} onChanged={reload} /> : null}

        {/*
          How the product behaves, as opposed to who the organization is. Gated on its own
          permission and hidden rather than disabled when it is missing — a greyed-out form is a
          promise the button might work; an absent section says plainly this is somebody else's job.
        */}
        {may('settings.read') ? <OperationalSection editable={may('settings.update')} /> : null}
      </AdminBody>
    </>
  );
}

/* ------------------------------------------------------------ organization -- */

function OrganizationSection({
  version,
  editable,
  onSaved,
}: {
  version: number;
  editable: boolean;
  onSaved: () => void;
}) {
  const state = useApi(() => adminApi.organization(), [version]);

  return (
    <Card>
      <CardHeader>
        <h2 className="ay-h3">Организация</h2>
      </CardHeader>

      {state.status === 'error' ? (
        <p className="ay-small" role="alert">
          {describeError(state.error)}
        </p>
      ) : state.status === 'loading' ? (
        <p className="ay-small ay-muted">Зареждане…</p>
      ) : (
        <OrganizationForm profile={state.data.organization} editable={editable} onSaved={onSaved} />
      )}
    </Card>
  );
}

function OrganizationForm({
  profile,
  editable,
  onSaved,
}: {
  profile: OrganizationProfile;
  editable: boolean;
  onSaved: () => void;
}) {
  const [name, setName] = useState(profile.name);
  const [legalName, setLegalName] = useState(profile.legalName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const trimmed = name.trim();
  const changed = trimmed !== profile.name || legalName.trim() !== (profile.legalName ?? '');
  const tooShort = trimmed.length < 2;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!changed || tooShort) return;
    setBusy(true);
    setError(null);
    setSaved(false);

    adminApi
      .updateOrganization({ name: trimmed, legalName: legalName.trim() || null })
      .then(() => {
        setSaved(true);
        onSaved();
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? describeError(caught) : 'Промяната не се записа.');
      })
      .finally(() => setBusy(false));
  };

  return (
    <form
      onSubmit={submit}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ay-space-4)' }}
    >
      <Field
        label="Име на организацията"
        hint="Показва се вместо AYTRACKER — в панела, на екраните за вход и в приложенията на работниците и шофьорите."
      >
        <input
          className="ay-input"
          type="text"
          maxLength={160}
          value={name}
          disabled={!editable || busy}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>

      <Field
        label="Юридическо име"
        hint="По регистрация, ако се различава от търговското. Незадължително."
      >
        <input
          className="ay-input"
          type="text"
          maxLength={200}
          value={legalName}
          disabled={!editable || busy}
          onChange={(event) => setLegalName(event.target.value)}
        />
      </Field>

      {/*
        Read-only, and the hint says why rather than leaving it looking like an oversight. This is
        the code every worker and driver types to sign in; a settings form that could change it is
        a settings form that can lock a whole shift out of the building.
      */}
      <Field
        label="Код за вход на работници"
        hint="Не се променя от тук — работниците и шофьорите влизат с него. За промяна се свържете с поддръжката."
      >
        <input className="ay-input ay-numeric" type="text" value={profile.slug} readOnly disabled />
      </Field>

      {error ? (
        <p className="ay-small" style={{ color: 'var(--ay-danger)' }} role="alert">
          {error}
        </p>
      ) : null}

      {editable ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--ay-space-3)' }}>
          <Button type="submit" disabled={busy || !changed || tooShort}>
            {busy ? 'Записване…' : 'Запишете'}
          </Button>
          {saved && !changed ? (
            <span className="ay-caption ay-muted">Записано.</span>
          ) : tooShort ? (
            <span className="ay-caption ay-muted">Името е поне 2 знака.</span>
          ) : null}
        </div>
      ) : (
        <p className="ay-caption ay-muted">Нямате право да променяте тези данни.</p>
      )}
    </form>
  );
}

/* -------------------------------------------------------------------- logo -- */

function LogoSection({
  version,
  organizationName,
  editable,
  onChanged,
}: {
  version: number;
  organizationName: string;
  editable: boolean;
  onChanged: () => void;
}) {
  const state = useApi(() => adminApi.logos(), [version]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const logos = state.status === 'ready' ? state.data.logos : [];
  const active = logos.find((logo) => logo.isActive) ?? null;

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared immediately so choosing the same file twice still fires a change event — otherwise
    // a failed upload cannot be retried without picking a different file first.
    event.target.value = '';
    if (!file) return;

    if (file.size > MAX_LOGO_BYTES) {
      setError(`Файлът е твърде голям. Максимумът е ${Math.floor(MAX_LOGO_BYTES / 1024)} KB.`);
      return;
    }

    setBusy(true);
    setError(null);

    readAsDataUrl(file)
      .then((data) => adminApi.uploadLogo({ fileName: file.name, data, activate: true }))
      .then(() => onChanged())
      .catch((caught: unknown) => setError(uploadProblem(caught)))
      .finally(() => setBusy(false));
  };

  const choose = (logoId: string | null) => {
    setBusy(true);
    setError(null);
    adminApi
      .selectLogo(logoId)
      .then(() => onChanged())
      .catch((caught: unknown) => setError(uploadProblem(caught)))
      .finally(() => setBusy(false));
  };

  const remove = (logo: LogoRow) => {
    setBusy(true);
    setError(null);
    adminApi
      .deleteLogo(logo.id)
      .then(() => onChanged())
      .catch((caught: unknown) => setError(uploadProblem(caught)))
      .finally(() => setBusy(false));
  };

  return (
    <Card>
      <CardHeader>
        <h2 className="ay-h3">Лого</h2>
      </CardHeader>

      <p className="ay-caption ay-muted" style={{ marginBottom: 'var(--ay-space-4)' }}>
        Качете лого и го изберете — избраното се показва навсякъде в системата, включително на
        екраните за вход на работниците. PNG, JPEG, WebP или GIF, до{' '}
        {Math.floor(MAX_LOGO_BYTES / 1024)} KB. SVG не се приема по съображения за сигурност.
      </p>

      {/* What is actually on the login screen right now, shown the way it is shown there. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--ay-space-3)',
          padding: 'var(--ay-space-4)',
          border: '1px solid var(--ay-border)',
          borderRadius: 'var(--ay-radius-md, 0.5rem)',
          marginBottom: 'var(--ay-space-4)',
        }}
      >
        {/* Exactly what a login screen renders, name and all — including the monogram fallback
            when no logo is chosen, so "Без лого" is a preview rather than a leap of faith. */}
        <BrandMark name={organizationName} logoUrl={active?.url ?? null} size="hero" />
      </div>

      {error ? (
        <p
          className="ay-small"
          style={{ color: 'var(--ay-danger)', marginBottom: 'var(--ay-space-3)' }}
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {editable ? (
        <div
          style={{
            display: 'flex',
            gap: 'var(--ay-space-3)',
            flexWrap: 'wrap',
            marginBottom: 'var(--ay-space-4)',
          }}
        >
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPTED_TYPES}
            onChange={upload}
            style={{ display: 'none' }}
          />
          <Button onClick={() => fileInput.current?.click()} disabled={busy}>
            {busy ? 'Моля, изчакайте…' : 'Качете лого'}
          </Button>
          {active ? (
            <Button variant="ghost" disabled={busy} onClick={() => choose(null)}>
              Без лого
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="ay-caption ay-muted">Нямате право да променяте логото.</p>
      )}

      {state.status === 'error' ? (
        <p className="ay-small" role="alert">
          {describeError(state.error)}
        </p>
      ) : logos.length === 0 ? (
        <p className="ay-caption ay-muted">
          {state.status === 'loading' ? 'Зареждане…' : 'Още няма качено лого.'}
        </p>
      ) : (
        <ul
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(11rem, 1fr))',
            gap: 'var(--ay-space-3)',
          }}
        >
          {logos.map((logo) => (
            <li
              key={logo.id}
              style={{
                border: `1px solid ${logo.isActive ? 'var(--ay-accent, var(--ay-border))' : 'var(--ay-border)'}`,
                borderRadius: 'var(--ay-radius-md, 0.5rem)',
                padding: 'var(--ay-space-3)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--ay-space-2)',
              }}
            >
              <div
                style={{
                  height: '4rem',
                  display: 'grid',
                  placeItems: 'center',
                  // A logo drawn for a white letterhead is invisible on a dark surface, and a
                  // gallery is the one place it has to be judged rather than merely seen.
                  background: '#ffffff',
                  borderRadius: 'var(--ay-radius-sm, 0.375rem)',
                }}
              >
                <img
                  src={logo.url}
                  alt={logo.fileName}
                  style={{ maxHeight: '3.5rem', maxWidth: '100%', objectFit: 'contain' }}
                />
              </div>

              <div className="ay-caption ay-muted" style={{ wordBreak: 'break-all' }}>
                {logo.fileName}
              </div>

              {logo.isActive ? (
                <Badge tone="success">Избрано</Badge>
              ) : editable ? (
                <Button variant="ghost" disabled={busy} onClick={() => choose(logo.id)}>
                  Изберете
                </Button>
              ) : null}

              {editable ? (
                <Button variant="ghost" disabled={busy} onClick={() => remove(logo)}>
                  Изтрийте
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------- members -- */

function MembersSection({ version, onChanged }: { version: number; onChanged: () => void }) {
  const state = useApi(() => adminApi.members(), [version]);
  const members = state.status === 'ready' ? state.data.members : [];

  return (
    <Card padded={false}>
      <CardHeader>
        <h2 className="ay-h3">Администратори</h2>
      </CardHeader>

      <p
        className="ay-caption ay-muted"
        style={{ padding: '0 var(--ay-space-5) var(--ay-space-3)' }}
      >
        Имейлът е това, с което човекът влиза. След промяна текущата му сесия приключва и той влиза
        с новия адрес.
      </p>

      {state.status === 'error' ? (
        <p className="ay-small" style={{ padding: '0 var(--ay-space-5) var(--ay-space-4)' }}>
          {describeError(state.error)}
        </p>
      ) : members.length === 0 ? (
        <p
          className="ay-caption ay-muted"
          style={{ padding: '0 var(--ay-space-5) var(--ay-space-5)' }}
        >
          {state.status === 'loading' ? 'Зареждане…' : 'Няма членове.'}
        </p>
      ) : (
        <ul>
          {members.map((member) => (
            <MemberRowItem key={member.id} member={member} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function MemberRowItem({ member, onChanged }: { member: MemberRow; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(member.email);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = `${member.firstName ?? ''} ${member.lastName ?? ''}`.trim() || member.email;
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const changed = email.trim().toLowerCase() !== member.email;

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || !changed) return;
    setBusy(true);
    setError(null);

    adminApi
      .updateMemberEmail(member.id, email.trim().toLowerCase())
      .then((result) => {
        if (result.signedOut) {
          // The caller just changed their own login identity, so the session they are holding is
          // no longer valid. Saying so on the login screen beats the next click failing as an
          // unexplained "сесията изтече".
          window.location.assign('/login');
          return;
        }
        setEditing(false);
        onChanged();
      })
      .catch((caught: unknown) => {
        setError(emailProblem(caught));
      })
      .finally(() => setBusy(false));
  };

  return (
    <li style={{ borderTop: '1px solid var(--ay-border)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 'var(--ay-space-3)',
          padding: 'var(--ay-space-4) var(--ay-space-5)',
        }}
      >
        <div style={{ flex: 1, minWidth: '14rem' }}>
          <div className="ay-small" style={{ fontWeight: 550 }}>
            {name}
            {member.isSelf ? ' (вие)' : ''}
          </div>
          <div className="ay-caption ay-muted">{member.email}</div>
        </div>

        <Badge tone="neutral">{member.roleName}</Badge>
        {member.isPlatformAdmin ? <Badge tone="warning">Админ на платформата</Badge> : null}
        {member.status === 'ACTIVE' ? null : <Badge tone="neutral">{member.status}</Badge>}

        {/*
          A platform administrator's address is not this organization's to change — that account
          administers AYtracker itself. The button is absent rather than disabled, and the badge
          above says why.
        */}
        {member.isPlatformAdmin ? null : (
          <Button
            variant="ghost"
            className="ay-button-row-action"
            disabled={busy}
            onClick={() => {
              setEmail(member.email);
              setError(null);
              setEditing((open) => !open);
            }}
          >
            {editing ? 'Затворете' : 'Смяна на имейл'}
          </Button>
        )}
      </div>

      {editing ? (
        <form
          onSubmit={save}
          style={{ padding: '0 var(--ay-space-5) var(--ay-space-4)', maxWidth: '28rem' }}
        >
          <Field
            label={`Нов имейл за ${name}`}
            hint={
              member.isSelf
                ? 'Това е вашият собствен адрес — след записване ще влезете отново с новия.'
                : 'Човекът ще влиза с новия адрес. Текущата му сесия приключва.'
            }
            action={
              <Button type="submit" disabled={busy || !valid || !changed}>
                {busy ? 'Записване…' : 'Запишете'}
              </Button>
            }
          >
            <input
              className="ay-input"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>

          {error ? (
            <p
              className="ay-small"
              style={{ color: 'var(--ay-danger)', marginTop: 'var(--ay-space-2)' }}
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------------ helpers -- */

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('file.unreadable'));
    reader.readAsDataURL(file);
  });
}

/** The upload errors worth naming, because each one has a different thing to do about it. */
function uploadProblem(caught: unknown): string {
  if (!(caught instanceof ApiError)) return 'Действието не беше успешно.';
  if (caught.code === 'branding.logo_unsupported_type') {
    return 'Този файл не е поддържано изображение. Използвайте PNG, JPEG, WebP или GIF.';
  }
  if (caught.code === 'branding.logo_too_large') {
    return `Файлът е твърде голям. Максимумът е ${Math.floor(MAX_LOGO_BYTES / 1024)} KB.`;
  }
  if (caught.code === 'branding.logo_unreadable') return 'Файлът не можа да бъде прочетен.';
  if (caught.code === 'branding.logo_not_found') return 'Това лого вече не съществува.';
  return describeError(caught);
}

function emailProblem(caught: unknown): string {
  if (!(caught instanceof ApiError)) return 'Имейлът не беше сменен.';
  if (caught.code === 'auth.email_taken') return 'Този имейл вече се използва.';
  if (caught.code === 'members.platform_admin_immutable') {
    return 'Този акаунт е администратор на платформата и не се управлява от тук.';
  }
  return describeError(caught);
}

/* ------------------------------------------------------------- operational -- */

/**
 * The operational settings, loaded on their own.
 *
 * A separate request from the organization profile because they answer different questions and
 * have different permissions; a single combined read would make the whole screen unavailable to
 * somebody who may see one half of it.
 */
function OperationalSection({ editable }: { editable: boolean }) {
  const state = useApi(() => adminApi.settings(), []);

  if (state.status === 'error') {
    return (
      <Card>
        <p className="ay-small">{describeError(state.error)}</p>
      </Card>
    );
  }
  if (state.status !== 'ready') {
    return (
      <Card>
        <p className="ay-small ay-muted">Зареждане…</p>
      </Card>
    );
  }

  return <SettingsForm initial={state.data} editable={editable} />;
}

function SettingsForm({ initial, editable }: { initial: SettingsResponse; editable: boolean }) {
  const [settings, setSettings] = useState(initial);
  const [fuelPrice, setFuelPrice] = useState(initial.fuelPricePerLiter ?? '');
  const [selfStart, setSelfStart] = useState(initial.allowWorkerSelfShiftStart);
  const [maxShift, setMaxShift] = useState(String(initial.maxShiftDurationMinutes));
  const [gpsInterval, setGpsInterval] = useState(String(initial.gpsMinIntervalSeconds));
  const [gpsDistance, setGpsDistance] = useState(String(initial.gpsMinDistanceMeters));
  /**
   * The speed limit is a string because an empty field is a meaningful value here.
   *
   * Empty means "no limit set", and no limit means no speed alerts at all. It is deliberately not
   * a number input defaulting to something plausible: a limit nobody chose is a limit nobody can
   * be held to, and this figure ends up in conversations about people's driving.
   */
  const [speedLimit, setSpeedLimit] = useState(
    initial.speedLimitKph === null ? '' : String(initial.speedLimitKph),
  );
  const [speedSustained, setSpeedSustained] = useState(String(initial.speedSustainedSeconds));
  const [speedCooldown, setSpeedCooldown] = useState(String(initial.speedCooldownSeconds));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // The confirmation is a moment, not a state. Left on screen it becomes wallpaper, and the next
  // save produces no visible change at all.
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 4000);
    return () => clearTimeout(timer);
  }, [saved]);

  const price = fuelPrice.trim().replace(',', '.');
  const priceValid = price === '' || (/^\d{1,6}(\.\d{1,4})?$/.test(price) && Number(price) > 0);
  const minutes = Number(maxShift);
  const shiftValid = Number.isInteger(minutes) && minutes >= 60 && minutes <= 1440;
  const interval = Number(gpsInterval);
  const intervalValid = Number.isInteger(interval) && interval >= 5 && interval <= 300;
  const distance = Number(gpsDistance);
  const distanceValid = Number.isInteger(distance) && distance >= 10 && distance <= 2000;
  const limit = speedLimit.trim();
  const limitValid =
    limit === '' || (Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= 300);
  const sustained = Number(speedSustained);
  const cooldown = Number(speedCooldown);
  const windowsValid =
    Number.isInteger(sustained) &&
    sustained >= 5 &&
    sustained <= 600 &&
    Number.isInteger(cooldown) &&
    cooldown >= 0 &&
    cooldown <= 7200;
  const valid =
    priceValid && shiftValid && intervalValid && distanceValid && limitValid && windowsValid;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);

    adminApi
      .updateSettings({
        // An empty field means "no price", which is a real choice and different from omitting
        // the field. Sent as null so the server clears it rather than keeping the old one.
        fuelPricePerLiter: price === '' ? null : price,
        allowWorkerSelfShiftStart: selfStart,
        maxShiftDurationMinutes: minutes,
        gpsMinIntervalSeconds: interval,
        gpsMinDistanceMeters: distance,
        // Empty means off, and off has to be sent as null — omitting it would leave whatever
        // limit was there before, which is the opposite of what clearing the field means.
        speedLimitKph: limit === '' ? null : Number(limit),
        speedSustainedSeconds: sustained,
        speedCooldownSeconds: cooldown,
      })
      .then((next) => {
        setSettings(next);
        setFuelPrice(next.fuelPricePerLiter ?? '');
        setSpeedLimit(next.speedLimitKph === null ? '' : String(next.speedLimitKph));
        setSaved(true);
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError ? describeError(caught) : 'Настройките не бяха записани.',
        );
      })
      .finally(() => setSaving(false));
  };

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 'var(--ay-space-5)' }}>
      <Card padded={false}>
        <CardHeader>
          <div>
            <h2 className="ay-h3">Гориво</h2>
            <p className="ay-caption ay-muted">
              Без цена системата показва литри, но не и стойност. Нищо не се измисля.
            </p>
          </div>
        </CardHeader>
        <div style={{ padding: 'var(--ay-space-5)', display: 'grid', gap: 'var(--ay-space-4)' }}>
          <Field
            label={`Цена на литър (${settings.currency})`}
            hint="Например 2.45. Оставете празно, ако не искате прогнози за стойност."
          >
            <input
              className="ay-input ay-numeric"
              type="text"
              inputMode="decimal"
              value={fuelPrice}
              placeholder="2.45"
              onChange={(event) => setFuelPrice(event.target.value.replace(/[^\d.,]/g, ''))}
            />
          </Field>
          {!priceValid ? (
            <p className="ay-small" style={{ color: 'var(--ay-danger)' }}>
              Въведете цена като 2.45.
            </p>
          ) : null}
          <p className="ay-caption ay-muted">
            Разходът за курс се изчислява от изминатите километри и средния разход на автомобила,
            който се въвежда в „Автопарк“. Това винаги е прогноза — реалните разходи идват от
            касовите бележки.
          </p>
        </div>
      </Card>

      <Card padded={false}>
        <CardHeader>
          <div>
            <h2 className="ay-h3">Смени</h2>
            <p className="ay-caption ay-muted">Кой започва смяна и колко дълго може да е тя.</p>
          </div>
        </CardHeader>
        <div style={{ padding: 'var(--ay-space-5)', display: 'grid', gap: 'var(--ay-space-4)' }}>
          <label
            className="ay-small"
            style={{ display: 'flex', gap: 'var(--ay-space-3)', alignItems: 'flex-start' }}
          >
            <input
              type="checkbox"
              checked={selfStart}
              onChange={(event) => setSelfStart(event.target.checked)}
              style={{ marginTop: '0.2rem' }}
            />
            <span>
              Работниците могат сами да започват смяна
              <span className="ay-caption ay-muted" style={{ display: 'block' }}>
                Ако е изключено, смяната се започва само от ръководител.
              </span>
            </span>
          </label>

          <Field
            label="Максимална дължина на смяна (минути)"
            hint="Забравена смяна се затваря автоматично на този таван, а не в 03:00 сутринта."
          >
            <input
              className="ay-input ay-numeric"
              type="number"
              min={60}
              max={1440}
              value={maxShift}
              onChange={(event) => setMaxShift(event.target.value)}
            />
          </Field>
          {!shiftValid ? (
            <p className="ay-small" style={{ color: 'var(--ay-danger)' }}>
              Между 60 и 1440 минути.
            </p>
          ) : null}
        </div>
      </Card>

      <Card padded={false}>
        <CardHeader>
          <div>
            <h2 className="ay-h3">Проследяване</h2>
            <p className="ay-caption ay-muted">
              Колко често телефоните на шофьорите изпращат позиция.
            </p>
          </div>
        </CardHeader>
        <div style={{ padding: 'var(--ay-space-5)', display: 'grid', gap: 'var(--ay-space-4)' }}>
          <Field
            label="Минимален интервал (секунди)"
            hint="По-малка стойност е по-точно, но изразходва повече батерия."
          >
            <input
              className="ay-input ay-numeric"
              type="number"
              min={5}
              max={300}
              value={gpsInterval}
              onChange={(event) => setGpsInterval(event.target.value)}
            />
          </Field>

          <Field
            label="Минимално разстояние (метри)"
            hint="Точки по-близки от това не се изпращат — така спиране на светофар не пълни маршрута."
          >
            <input
              className="ay-input ay-numeric"
              type="number"
              min={10}
              max={2000}
              value={gpsDistance}
              onChange={(event) => setGpsDistance(event.target.value)}
            />
          </Field>

          {!intervalValid || !distanceValid ? (
            <p className="ay-small" style={{ color: 'var(--ay-danger)' }}>
              Интервалът е между 5 и 300 секунди, разстоянието между 10 и 2000 метра.
            </p>
          ) : null}

          <p className="ay-caption ay-muted">
            Курсът се записва непрекъснато от началото до края. Шофьорът няма бутон за пауза —
            спиранията се виждат сами на маршрута.
          </p>
        </div>
      </Card>

      <Card padded={false}>
        <CardHeader>
          <div>
            <h2 className="ay-h3">Скорост</h2>
            <p className="ay-caption ay-muted">
              Без зададено ограничение системата не следи скоростта изобщо.
            </p>
          </div>
        </CardHeader>
        <div style={{ padding: 'var(--ay-space-5)', display: 'grid', gap: 'var(--ay-space-4)' }}>
          <Field
            label="Ограничение (км/ч)"
            hint="Празно поле означава, че няма сигнали за скорост. Не се подразбира стойност."
          >
            <input
              className="ay-input ay-numeric"
              type="number"
              min={1}
              max={300}
              placeholder="няма"
              value={speedLimit}
              onChange={(event) => setSpeedLimit(event.target.value)}
            />
          </Field>

          <Field
            label="Продължителност преди сигнал (секунди)"
            hint="Едно засичане е измерване. Половин минута над ограничението е шофиране."
          >
            <input
              className="ay-input ay-numeric"
              type="number"
              min={5}
              max={600}
              value={speedSustained}
              onChange={(event) => setSpeedSustained(event.target.value)}
              disabled={limit === ''}
            />
          </Field>

          <Field
            label="Пауза между сигнали (секунди)"
            hint="Без нея едно пътуване по магистрала дава двайсет сигнала и никой не ги чете."
          >
            <input
              className="ay-input ay-numeric"
              type="number"
              min={0}
              max={7200}
              value={speedCooldown}
              onChange={(event) => setSpeedCooldown(event.target.value)}
              disabled={limit === ''}
            />
          </Field>

          {!limitValid || !windowsValid ? (
            <p className="ay-small" style={{ color: 'var(--ay-danger)' }}>
              Ограничението е между 1 и 300 км/ч, продължителността между 5 и 600 секунди.
            </p>
          ) : null}
        </div>
      </Card>

      {error ? (
        <p className="ay-small" style={{ color: 'var(--ay-danger)' }} role="alert">
          {error}
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: 'var(--ay-space-3)', alignItems: 'center' }}>
        <Button type="submit" disabled={saving || !valid || !editable}>
          {saving ? 'Записване…' : 'Запишете настройките'}
        </Button>
        {saved ? (
          <span className="ay-small" style={{ color: 'var(--ay-state-working)' }} role="status">
            Записано.
          </span>
        ) : null}
      </div>
    </form>
  );
}
