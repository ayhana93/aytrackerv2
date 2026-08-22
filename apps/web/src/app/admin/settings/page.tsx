'use client';

import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
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
} from '../../../lib/admin';
import { ApiError } from '../../../lib/api';
import { BrandMark } from '../../../components/brand-mark';
import { PRODUCT_NAME } from '../../../lib/brand';
import { useSessionContext } from '../auth-guard';

/**
 * Organization settings.
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
