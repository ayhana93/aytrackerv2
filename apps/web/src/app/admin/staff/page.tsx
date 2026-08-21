'use client';

import { useState, type FormEvent } from 'react';
import {
  AdminBody,
  AdminHeader,
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Grid,
  Kpi,
  ThemeToggle,
} from '@aytracker/ui';
import { adminApi, describeError, useApi, type WorkerRow } from '../../../lib/admin';
import { ApiError } from '../../../lib/api';
import { useSession } from '../auth-guard';

/**
 * The roster.
 *
 * The screen the product could not work without and did not have: until now the only way a worker
 * existed was a seed script, so the login door built for them opened onto an organization with
 * nobody in it.
 *
 * An admin decides both halves of the credential here — the employee number the worker types and
 * the PIN they type after it — and hands them over. There is no self-registration for a worker
 * and there should not be: the point of a tenant is that its staff list is decided by the
 * organization, not by whoever finds the URL.
 *
 * The PIN is write-only everywhere. The server stores an Argon2id hash and returns a boolean; this
 * screen can say "has a PIN" or "no PIN yet", and an admin who forgets one issues a new one. A
 * screen that could show it back would be a screen that leaks every credential in the building.
 */

/**
 * The PIN rule, stated up front rather than after a rejected submit.
 *
 * The server is the authority — `assertPinPolicy` in `@aytracker/auth` guards the hash and would
 * refuse these anyway. This copy exists so an admin choosing a PIN *for somebody else* learns the
 * rule while typing: a rejected submit here means walking back to a person and telling them their
 * PIN changed, which is exactly the sort of friction that ends with 1111 written on a whiteboard.
 *
 * Deliberately not imported from `@aytracker/validation`: that would pull zod into a bundle these
 * screens' users open on factory-floor phones, for four lines of regex.
 */
function pinProblem(pin: string): string | null {
  if (pin === '') return null;
  if (!/^\d{4,8}$/.test(pin)) return 'ПИН-ът е между 4 и 8 цифри.';
  if (/^(\d)\1*$/.test(pin)) return 'Не може да е една и съща цифра.';
  const digits = [...pin].map(Number);
  const step = (delta: number) =>
    digits.every((digit, index) => index === 0 || digit === (digits[index - 1] ?? 0) + delta);
  if (step(1) || step(-1)) return 'Не може да е поредица като 1234.';
  return null;
}

const STATUS_LABEL: Readonly<Record<WorkerRow['status'], string>> = {
  ACTIVE: 'Активен',
  INACTIVE: 'Деактивиран',
  ON_LEAVE: 'В отпуск',
  TERMINATED: 'Напуснал',
};

const STATUS_TONE: Readonly<Record<WorkerRow['status'], 'success' | 'neutral' | 'warning'>> = {
  ACTIVE: 'success',
  INACTIVE: 'neutral',
  ON_LEAVE: 'warning',
  TERMINATED: 'neutral',
};

export default function StaffPage() {
  // Bumped after every write, which re-reads from the server rather than patching the list here:
  // `hasPin` and the lockout are server-decided, and a browser that guessed them would show one
  // thing until the next refresh and another after it.
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const state = useApi(() => adminApi.workers(), [version]);
  const reload = () => setVersion((current) => current + 1);

  const workers = state.status === 'ready' ? state.data.workers : [];
  const active = workers.filter((worker) => worker.status === 'ACTIVE');
  const withoutPin = active.filter((worker) => !worker.hasPin).length;
  const drivers = workers.filter((worker) => worker.driver !== null).length;

  return (
    <>
      <AdminHeader
        title="Персонал"
        subtitle={
          state.status === 'ready'
            ? `${workers.length === 1 ? '1 човек' : `${workers.length} души`} в списъка`
            : 'Зареждане…'
        }
        actions={
          <>
            <Button onClick={() => setAdding((open) => !open)} aria-expanded={adding}>
              {adding ? 'Затворете' : 'Нов работник'}
            </Button>
            <ThemeToggle labels={{ light: 'Светла', dark: 'Тъмна', system: 'Системна' }} />
          </>
        }
      />

      <AdminBody>
        {state.status === 'error' ? (
          <Card>
            <p className="ay-small">{describeError(state.error)}</p>
          </Card>
        ) : null}

        {adding ? (
          <NewWorkerForm
            onCreated={() => {
              setAdding(false);
              reload();
            }}
            onCancel={() => setAdding(false)}
          />
        ) : null}

        <Grid>
          <Kpi label="Активни" value={String(active.length)} caption="могат да са на смяна" />
          <Kpi
            label="Без ПИН"
            value={String(withoutPin)}
            goodDirection="down"
            caption="още не могат да влязат"
          />
          <Kpi label="Шофьори" value={String(drivers)} caption="с достъп до курсове" />
        </Grid>

        <Card padded={false}>
          <CardHeader>
            <h2 className="ay-h3">Работници</h2>
          </CardHeader>

          {workers.length === 0 ? (
            <div style={{ padding: 'var(--ay-space-8)', textAlign: 'center' }}>
              <p className="ay-small" style={{ fontWeight: 550 }}>
                Още няма нито един работник.
              </p>
              <p className="ay-caption ay-muted" style={{ marginTop: 'var(--ay-space-1)' }}>
                {state.status === 'loading'
                  ? 'Зареждане…'
                  : 'Добавете първия с бутона „Нов работник“ горе вдясно. Служебният номер и ПИН-ът, които зададете, са това, което човекът въвежда на своя екран.'}
              </p>
            </div>
          ) : (
            <ul>
              {workers.map((worker) => (
                <WorkerRowItem key={worker.id} worker={worker} onChanged={reload} />
              ))}
            </ul>
          )}
        </Card>
      </AdminBody>
    </>
  );
}

/** One person, with the two things an admin does to them: reset the PIN, or deactivate. */
function WorkerRowItem({ worker, onChanged }: { worker: WorkerRow; onChanged: () => void }) {
  const [resetting, setResetting] = useState(false);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const locked = worker.lockedUntil !== null;

  const pinIssue = pinProblem(pin);

  const savePin = (event: FormEvent) => {
    event.preventDefault();
    if (pin === '' || pinIssue !== null) return;
    setBusy(true);
    setError(null);
    adminApi
      .updateWorker(worker.id, { pin })
      .then(() => {
        setPin('');
        setResetting(false);
        onChanged();
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError ? describeError(caught) : 'ПИН-ът не можа да се смени.',
        );
      })
      .finally(() => setBusy(false));
  };

  const toggleStatus = () => {
    setBusy(true);
    setError(null);
    adminApi
      .updateWorker(worker.id, { status: worker.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' })
      .then(onChanged)
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? describeError(caught) : 'Промяната не се записа.');
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
        <div style={{ flex: 1, minWidth: '12rem' }}>
          <div className="ay-small" style={{ fontWeight: 550 }}>
            {worker.firstName} {worker.lastName}
          </div>
          <div className="ay-caption ay-muted ay-numeric">
            № {worker.employeeNumber}
            {worker.driver ? ` · шофьор ${worker.driver.code}` : ''}
          </div>
        </div>

        {/*
          "No PIN yet" is a warning rather than an error: it is the normal state of somebody added
          to the roster this morning who has not collected their PIN. It still has to be visible,
          because it is the exact reason they cannot sign in.
        */}
        {worker.hasPin ? (
          <Badge tone="neutral">ПИН е зададен</Badge>
        ) : (
          <Badge tone="warning">Без ПИН</Badge>
        )}
        {locked ? <Badge tone="danger">Заключен</Badge> : null}
        <Badge tone={STATUS_TONE[worker.status]}>{STATUS_LABEL[worker.status]}</Badge>

        <Button
          variant="ghost"
          className="ay-button-row-action"
          disabled={busy}
          onClick={() => setResetting((open) => !open)}
        >
          {worker.hasPin ? 'Нов ПИН' : 'Задайте ПИН'}
        </Button>
        <Button
          variant="ghost"
          className="ay-button-row-action"
          disabled={busy}
          onClick={toggleStatus}
        >
          {worker.status === 'ACTIVE' ? 'Деактивирайте' : 'Активирайте'}
        </Button>
      </div>

      {resetting ? (
        <form
          onSubmit={savePin}
          style={{
            padding: '0 var(--ay-space-5) var(--ay-space-4)',
            maxWidth: '24rem',
          }}
        >
          <Field
            label={`Нов ПИН за ${worker.firstName}`}
            hint={
              pinIssue ??
              (locked
                ? 'Новият ПИН отключва и достъпа след много грешни опити.'
                : '4 до 8 цифри. Продиктувайте го на човека — после не може да бъде показан отново.')
            }
            action={
              <Button type="submit" disabled={busy || pin === '' || pinIssue !== null}>
                {busy ? 'Записване…' : 'Запишете'}
              </Button>
            }
          >
            <input
              className="ay-input ay-numeric"
              type="text"
              inputMode="numeric"
              autoFocus
              maxLength={8}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
            />
          </Field>
        </form>
      ) : null}

      {error ? (
        <p
          className="ay-small"
          style={{ color: 'var(--ay-danger)', padding: '0 var(--ay-space-5) var(--ay-space-4)' }}
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Adding somebody.
 *
 * Four fields and a checkbox. Name, the number they will type, and the PIN they will type after
 * it — everything else about a worker (site, qualifications, hire date) is a later decision that
 * should not stand between an admin and a roster.
 */
function NewWorkerForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const session = useSession();
  const [employeeNumber, setEmployeeNumber] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [pin, setPin] = useState('');
  const [isDriver, setIsDriver] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ number: string; name: string } | null>(null);

  const pinIssue = pinProblem(pin);
  const ready =
    employeeNumber.trim() !== '' &&
    firstName.trim() !== '' &&
    lastName.trim() !== '' &&
    pinIssue === null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setSaving(true);
    setError(null);

    adminApi
      .createWorker({
        employeeNumber: employeeNumber.trim(),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        ...(pin === '' ? {} : { pin }),
        isDriver,
      })
      .then((response) => {
        // Shown once, on the way out: the number and the name to hand over. The PIN is not
        // repeated back — whoever typed it thirty seconds ago is the person handing it over.
        setCreated({
          number: response.worker.employeeNumber,
          name: `${response.worker.firstName} ${response.worker.lastName}`,
        });
        setEmployeeNumber('');
        setFirstName('');
        setLastName('');
        setPin('');
        setIsDriver(false);
      })
      .catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.code === 'worker.employee_number_taken') {
          setError('Вече има работник с този служебен номер.');
          return;
        }
        if (caught instanceof ApiError && caught.code === 'driver.code_taken') {
          setError('Вече има шофьор с този код.');
          return;
        }
        if (caught instanceof ApiError && caught.status === 400) {
          setError('Проверете попълнените данни. ПИН-ът е между 4 и 8 цифри.');
          return;
        }
        setError(caught instanceof ApiError ? describeError(caught) : 'Работникът не се записа.');
      })
      .finally(() => setSaving(false));
  };

  return (
    <Card padded={false}>
      <CardHeader>
        <div>
          <h2 className="ay-h3">Нов работник</h2>
          <p className="ay-caption ay-muted">
            Служебният номер и ПИН-ът са това, което човекът въвежда на своя екран.
          </p>
        </div>
      </CardHeader>

      {created ? (
        <div
          style={{
            padding: 'var(--ay-space-4) var(--ay-space-5)',
            borderTop: '1px solid var(--ay-border)',
            background: 'var(--ay-accent-soft)',
          }}
        >
          <p className="ay-small" style={{ fontWeight: 550 }}>
            {created.name} е добавен(а).
          </p>
          <p className="ay-caption ay-muted" style={{ marginTop: 'var(--ay-space-1)' }}>
            Дайте му/ѝ: адреса за вход, код на фирмата <strong>{session.organizationSlug}</strong>,
            служебен номер <strong className="ay-numeric">{created.number}</strong> и ПИН-а, който
            зададохте. <a href="/admin">Връзките за вход са в таблото.</a>
          </p>
        </div>
      ) : null}

      <form
        onSubmit={submit}
        style={{ padding: 'var(--ay-space-5)', borderTop: '1px solid var(--ay-border)' }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 15rem), 1fr))',
            gap: 'var(--ay-space-4)',
          }}
        >
          <Field label="Име">
            <input
              className="ay-input"
              type="text"
              autoFocus
              required
              maxLength={80}
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
            />
          </Field>

          <Field label="Фамилия">
            <input
              className="ay-input"
              type="text"
              required
              maxLength={80}
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
            />
          </Field>

          <Field label="Служебен номер" hint="С него човекът влиза. Например: 1001">
            <input
              className="ay-input ay-numeric"
              type="text"
              required
              maxLength={64}
              value={employeeNumber}
              onChange={(event) => setEmployeeNumber(event.target.value)}
            />
          </Field>

          <Field label="ПИН" hint={pinIssue ?? '4 до 8 цифри. Може и по-късно.'}>
            <input
              className="ay-input ay-numeric"
              type="text"
              inputMode="numeric"
              maxLength={8}
              // Announced as invalid only once there is something to judge — an empty PIN is a
              // deliberate "later", not a mistake somebody has made.
              aria-invalid={pinIssue === null ? undefined : true}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
            />
          </Field>
        </div>

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--ay-space-3)',
            marginTop: 'var(--ay-space-4)',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={isDriver}
            onChange={(event) => setIsDriver(event.target.checked)}
          />
          <span>
            <span className="ay-small">Този човек и шофира</span>
            <span className="ay-caption ay-muted" style={{ display: 'block' }}>
              Създава и профил на шофьор със същия номер и същия ПИН, за входа за шофьори.
            </span>
          </span>
        </label>

        {error ? (
          <p
            className="ay-small"
            style={{ color: 'var(--ay-danger)', marginTop: 'var(--ay-space-4)' }}
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <div style={{ display: 'flex', gap: 'var(--ay-space-3)', marginTop: 'var(--ay-space-5)' }}>
          <Button type="submit" disabled={saving || !ready}>
            {saving ? 'Записване…' : 'Добавете работник'}
          </Button>
          <Button type="button" variant="ghost" onClick={created ? onCreated : onCancel}>
            {created ? 'Готово' : 'Откажете'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
