'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppBar,
  Badge,
  Button,
  Card,
  Field,
  ListRow,
  PortalBody,
  PortalShell,
  Sheet,
  StateCard,
  TabBar,
  ThemeToggle,
} from '@aytracker/ui';
import { ApiError } from '../../lib/api';
import { authApi } from '../../lib/auth';
import {
  workerApi,
  type AvailablePosition,
  type BreakType,
  type PositionHistoryRow,
  type SelectableVehicle,
  type WorkerState,
} from '../../lib/worker';

/**
 * Worker portal.
 *
 * Everything on this screen is the server's answer to `GET /worker/state`. The component holds
 * which screen is open and what has been typed into it — nothing else. There is no local roster,
 * no local position list and, most importantly, no local idea of when the shift began: the
 * elapsed time is measured from `actualStart` against the server's clock, so a worker who clocks
 * in at 09:00 sees 00:00:01, whatever the tablet's clock believes.
 *
 * Every action reloads the state it changed rather than patching a local copy. A position change
 * touches the shift, the open session and what may be chosen next, and guessing at all three in
 * the browser is how a screen ends up disagreeing with the record behind it.
 */

type Screen = 'home' | 'positions' | 'vehicles' | 'confirm';
type Tab = 'home' | 'history' | 'profile';

const TABS = [
  { id: 'home', label: 'Начало', icon: '⌂' },
  { id: 'history', label: 'История', icon: '☰' },
  { id: 'profile', label: 'Профил', icon: '☺' },
];

const BREAK_TYPES: readonly { id: BreakType; label: string; hint: string }[] = [
  { id: 'MEAL', label: 'Обедна почивка', hint: 'Приспада се от отработените часове' },
  { id: 'UNPAID', label: 'Кратка почивка', hint: 'Приспада се от отработените часове' },
  { id: 'TECHNICAL', label: 'Технически престой', hint: 'Машината не работи' },
];

export default function WorkerPortalPage() {
  const [state, setState] = useState<WorkerState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('home');
  const [screen, setScreen] = useState<Screen>('home');
  const [target, setTarget] = useState<AvailablePosition | null>(null);
  const [vehicles, setVehicles] = useState<readonly SelectableVehicle[] | null>(null);
  const [vehicle, setVehicle] = useState<SelectableVehicle | null>(null);
  const [routeLabel, setRouteLabel] = useState('');
  const [breakOpen, setBreakOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const clock = useServerClock(state?.serverTime ?? null);

  const reload = useCallback(async () => {
    try {
      const next = await workerApi.state();
      setState(next);
      setLoadError(null);
      return next;
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthenticated) {
        window.location.assign('/worker/login');
        return null;
      }
      setLoadError(describe(error));
      return null;
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Runs an action, then re-reads the state it changed.
   *
   * One place for the busy flag and one place for the error, so no button can be pressed twice
   * while its request is in flight and no failure can be swallowed into a screen that simply
   * does not change.
   */
  const run = useCallback(
    async (action: () => Promise<unknown>, after?: () => void) => {
      setBusy(true);
      setActionError(null);
      try {
        await action();
        await reload();
        after?.();
      } catch (error) {
        if (error instanceof ApiError && error.isUnauthenticated) {
          window.location.assign('/worker/login');
          return;
        }
        setActionError(describe(error));
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const goHome = useCallback(() => {
    setScreen('home');
    setTarget(null);
    setVehicle(null);
    setVehicles(null);
    setRouteLabel('');
    setActionError(null);
  }, []);

  /** Back retraces the way in, which for a driving position runs through the vehicle picker. */
  const goBack = useCallback(() => {
    if (screen === 'confirm') {
      setScreen(target?.kind === 'DRIVING' ? 'vehicles' : 'positions');
      return;
    }
    if (screen === 'vehicles') {
      setScreen('positions');
      return;
    }
    goHome();
  }, [screen, target, goHome]);

  const choosePosition = useCallback((position: AvailablePosition) => {
    setTarget(position);
    setActionError(null);
    if (position.kind !== 'DRIVING') {
      setScreen('confirm');
      return;
    }
    // The vehicle list is fetched, not remembered: which vans are free changes minute to
    // minute, and a cached list is how two drivers are offered the same one.
    setScreen('vehicles');
    setVehicles(null);
    workerApi
      .vehiclesFor(position.id)
      .then((response) => setVehicles(response.vehicles))
      .catch((error: unknown) => {
        setActionError(describe(error));
        setVehicles([]);
      });
  }, []);

  const confirm = useCallback(() => {
    if (!target) return;
    if (target.kind === 'DRIVING') {
      if (!vehicle) return;
      void run(async () => {
        const position = await currentPositionOrNull();
        const result = await workerApi.beginDriving({
          positionId: target.id,
          vehicleId: vehicle.id,
          label: routeLabel.trim() === '' ? null : routeLabel.trim(),
          startLatitude: position?.lat ?? null,
          startLongitude: position?.lon ?? null,
        });
        // The server says where to go, so the route is not hardcoded in two places.
        window.location.assign(result.redirectTo || '/driver');
      });
      return;
    }
    void run(() => workerApi.changePosition(target.id), goHome);
  }, [target, vehicle, routeLabel, run, goHome]);

  if (loadError && !state) {
    return (
      <PortalShell>
        <AppBar title={<span className="ay-h3">AYtracker</span>} />
        <PortalBody>
          <Card>
            <p className="ay-h3">Данните не се заредиха</p>
            <p className="ay-small ay-muted" style={{ marginTop: 'var(--ay-space-2)' }}>
              {loadError}
            </p>
            <Button
              block
              size="large"
              style={{ marginTop: 'var(--ay-space-4)' }}
              onClick={() => void reload()}
            >
              Опитай отново
            </Button>
          </Card>
        </PortalBody>
      </PortalShell>
    );
  }

  if (!state) {
    return (
      <PortalShell>
        <AppBar title={<span className="ay-h3">AYtracker</span>} />
        <PortalBody>
          <p className="ay-small ay-muted">Зареждане…</p>
        </PortalBody>
      </PortalShell>
    );
  }

  const shift = state.shift;
  const onBreak = shift?.openBreak != null;

  return (
    <PortalShell>
      <AppBar
        leading={
          screen === 'home' ? null : (
            <button
              type="button"
              className="ay-button ay-button-ghost"
              style={{ minHeight: '2.25rem', padding: '0 var(--ay-space-2)' }}
              onClick={goBack}
              aria-label="Назад"
            >
              ‹
            </button>
          )
        }
        title={
          screen === 'home' ? (
            <span className="ay-h3">AYtracker</span>
          ) : screen === 'positions' ? (
            'Смяна на позиция'
          ) : screen === 'vehicles' ? (
            'Избери МПС'
          ) : (
            'Потвърди'
          )
        }
        trailing={<ThemeToggle labels={{ light: 'Светла', dark: 'Тъмна', system: 'Системна' }} />}
      />

      <PortalBody>
        {actionError ? (
          <p className="ay-small" style={{ color: 'var(--ay-danger)' }} role="alert">
            {actionError}
          </p>
        ) : null}

        {screen === 'home' && tab === 'home' ? (
          <HomeScreen
            state={state}
            now={clock}
            busy={busy}
            onStartShift={() => void run(() => workerApi.startShift({}))}
            onEndShift={() => void run(() => workerApi.endShift())}
            onChangePosition={() => setScreen('positions')}
            onBreak={() => setBreakOpen(true)}
            onEndBreak={() => void run(() => workerApi.endBreak())}
          />
        ) : null}

        {screen === 'home' && tab === 'history' ? (
          <HistoryScreen hasShift={shift !== null} />
        ) : null}

        {screen === 'home' && tab === 'profile' ? <ProfileScreen state={state} /> : null}

        {screen === 'positions' ? <PositionPicker state={state} onChoose={choosePosition} /> : null}

        {screen === 'vehicles' && target ? (
          <VehiclePicker
            vehicles={vehicles}
            onChoose={(chosen) => {
              setVehicle(chosen);
              setScreen('confirm');
            }}
          />
        ) : null}

        {screen === 'confirm' && target ? (
          <ConfirmScreen
            from={shift?.currentPosition?.name ?? null}
            to={target}
            vehicle={vehicle}
            routeLabel={routeLabel}
            onRouteLabelChange={setRouteLabel}
            busy={busy}
            onConfirm={confirm}
            onCancel={goHome}
          />
        ) : null}
      </PortalBody>

      {screen === 'home' ? (
        <TabBar items={TABS} activeId={tab} onSelect={(id) => setTab(id as Tab)} />
      ) : null}

      <Sheet open={breakOpen} onClose={() => setBreakOpen(false)} title="Почивка">
        <p className="ay-small ay-muted" style={{ marginBottom: 'var(--ay-space-4)' }}>
          Времето на почивката се записва отделно и се приспада от отработените часове.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ay-space-2)' }}>
          {BREAK_TYPES.map((type) => (
            <ListRow
              key={type.id}
              title={type.label}
              subtitle={type.hint}
              disabled={busy || onBreak}
              onClick={() => {
                setBreakOpen(false);
                void run(() => workerApi.startBreak(type.id));
              }}
            />
          ))}
        </div>
      </Sheet>
    </PortalShell>
  );
}

/* ------------------------------------------------------------------- home */

function HomeScreen({
  state,
  now,
  busy,
  onStartShift,
  onEndShift,
  onChangePosition,
  onBreak,
  onEndBreak,
}: {
  state: WorkerState;
  now: () => number;
  busy: boolean;
  onStartShift: () => void;
  onEndShift: () => void;
  onChangePosition: () => void;
  onBreak: () => void;
  onEndBreak: () => void;
}) {
  const shift = state.shift;

  return (
    <>
      <div>
        <h1 className="ay-h1">Здравей, {state.worker.firstName}!</h1>
        <p className="ay-caption ay-muted" style={{ marginTop: 'var(--ay-space-1)' }}>
          {shift ? 'Позиция' : 'Служебен номер'}
        </p>
        <p className="ay-h2">
          {shift ? (shift.currentPosition?.name ?? 'Без позиция') : state.worker.employeeNumber}
        </p>
        {shift?.currentPosition?.workArea ? (
          <p className="ay-small ay-muted">{shift.currentPosition.workArea}</p>
        ) : null}
      </div>

      {shift === null ? <NoShift state={state} busy={busy} onStartShift={onStartShift} /> : null}

      {shift !== null ? (
        <>
          <StateCard
            label={shift.openBreak ? 'ПОЧИВКА' : 'РАБОТИШ'}
            detail={
              shift.actualStart ? `От ${formatTime(shift.actualStart)}` : 'Смяната е започната'
            }
            value={elapsed(shift.openBreak?.startedAt ?? shift.actualStart, now())}
            caption={shift.openBreak ? 'време на почивката' : undefined}
          />

          {shift.activeTripId ? (
            <Card>
              <p className="ay-small">
                Курсът ти още се записва. Управлението на маршрута е в екрана за шофьори.
              </p>
              <Button
                block
                size="large"
                style={{ marginTop: 'var(--ay-space-3)' }}
                onClick={() => window.location.assign('/driver')}
              >
                Към маршрута
              </Button>
            </Card>
          ) : null}

          <Button
            block
            size="large"
            disabled={busy || shift.openBreak !== null}
            onClick={onChangePosition}
          >
            Смени позиция
          </Button>

          <div
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--ay-space-3)' }}
          >
            {shift.openBreak ? (
              <Button variant="secondary" size="large" disabled={busy} onClick={onEndBreak}>
                ▶ Край на почивка
              </Button>
            ) : (
              <Button variant="secondary" size="large" disabled={busy} onClick={onBreak}>
                ☕ Почивка
              </Button>
            )}
            <Button variant="danger" size="large" disabled={busy} onClick={onEndShift}>
              ⏻ Край на смяна
            </Button>
          </div>
        </>
      ) : null}
    </>
  );
}

/**
 * Before the shift starts.
 *
 * The one screen a new organization sees first, so it has to be honest about what is missing.
 * A worker with no positions to move to is not looking at a broken app — they are looking at a
 * company whose administrator has not created any zones yet, and saying so is the difference
 * between a support call and someone finishing their setup.
 */
function NoShift({
  state,
  busy,
  onStartShift,
}: {
  state: WorkerState;
  busy: boolean;
  onStartShift: () => void;
}) {
  const blocked = !state.policy.allowWorkerSelfShiftStart;

  return (
    <>
      <Card>
        <p className="ay-overline ay-muted">Смяна</p>
        <p className="ay-small" style={{ marginTop: 'var(--ay-space-2)' }}>
          {blocked
            ? 'Във вашата фирма смяната се започва от ръководител.'
            : 'Още не си започнал смяна. Часовете се броят от момента, в който натиснеш.'}
        </p>
      </Card>

      {blocked ? null : (
        <Button block size="large" disabled={busy} onClick={onStartShift}>
          ▶ Започни смяна
        </Button>
      )}

      {state.availablePositions.length === 0 ? (
        <Card>
          <p className="ay-small ay-muted">
            Няма създадени позиции за твоя обект. Ръководителят ги добавя от админ панела, в „Зони и
            позиции“. Можеш да започнеш смяна и без позиция.
          </p>
        </Card>
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------- positions */

function PositionPicker({
  state,
  onChoose,
}: {
  state: WorkerState;
  onChoose: (position: AvailablePosition) => void;
}) {
  const positions = state.availablePositions;

  return (
    <>
      <div>
        <p className="ay-caption ay-muted">Текуща позиция</p>
        <p className="ay-h2">{state.shift?.currentPosition?.name ?? 'Без позиция'}</p>
      </div>

      <div>
        <p className="ay-caption ay-muted" style={{ marginBottom: 'var(--ay-space-2)' }}>
          Избери нова позиция
        </p>
        {positions.length === 0 ? (
          <Card>
            <p className="ay-small ay-muted">
              Няма позиции, които можеш да заемеш. Обърни се към ръководителя си.
            </p>
          </Card>
        ) : (
          /*
            Only positions this worker may occupy are listed, and the filtering is the server's.
            An ineligible position never reaches the device, so the picker cannot be tampered
            with to select one.
          */
          <div className="ay-list">
            {positions.map((position) => (
              <ListRow
                key={position.id}
                title={position.name}
                subtitle={position.workArea ?? position.code}
                disabled={position.isCurrent}
                trailing={
                  position.isCurrent ? (
                    <Badge tone="neutral">Текуща</Badge>
                  ) : position.kind === 'DRIVING' ? (
                    <Badge tone="accent">МПС</Badge>
                  ) : undefined
                }
                onClick={() => onChoose(position)}
              />
            ))}
          </div>
        )}
      </div>

      {!state.worker.isDriver ? (
        <p className="ay-caption ay-subtle">
          Шофьорските позиции се появяват тук само ако си заведен като шофьор.
        </p>
      ) : null}
    </>
  );
}

/* --------------------------------------------------------------- vehicles */

function VehiclePicker({
  vehicles,
  onChoose,
}: {
  vehicles: readonly SelectableVehicle[] | null;
  onChoose: (vehicle: SelectableVehicle) => void;
}) {
  return (
    <>
      <div>
        <h2 className="ay-h2">Избери автомобил</h2>
        <p className="ay-small ay-muted">
          Показани са само свободните автомобили, до които имаш достъп.
        </p>
      </div>

      {vehicles === null ? <p className="ay-small ay-muted">Зареждане…</p> : null}

      {vehicles !== null && vehicles.length === 0 ? (
        <Card>
          <p className="ay-small ay-muted">
            Няма свободен автомобил. Или всички са заети, или във фирмата още не са въведени —
            ръководителят ги добавя от админ панела, в „Автопарк“.
          </p>
        </Card>
      ) : null}

      {vehicles !== null && vehicles.length > 0 ? (
        <div className="ay-list">
          {vehicles.map((vehicle) => (
            <ListRow
              key={vehicle.id}
              title={vehicle.registrationNumber}
              subtitle={`${vehicle.make} ${vehicle.model} · ${formatOdometer(vehicle.odometer)} км`}
              trailing={vehicle.isCurrent ? <Badge tone="success">Твоят</Badge> : undefined}
              onClick={() => onChoose(vehicle)}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------------- confirm */

function ConfirmScreen({
  from,
  to,
  vehicle,
  routeLabel,
  onRouteLabelChange,
  busy,
  onConfirm,
  onCancel,
}: {
  from: string | null;
  to: AvailablePosition;
  vehicle: SelectableVehicle | null;
  routeLabel: string;
  onRouteLabelChange: (value: string) => void;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isDriving = to.kind === 'DRIVING';

  return (
    <>
      <Card>
        <div style={{ textAlign: 'center' }}>
          <p className="ay-caption ay-muted">Смяна на позиция</p>
          <p className="ay-h2" style={{ marginTop: 'var(--ay-space-3)' }}>
            {from ?? 'Без позиция'}
          </p>
          <p className="ay-h1 ay-muted" aria-hidden="true">
            ↓
          </p>
          <p className="ay-h2">{to.name}</p>
          {vehicle ? (
            <p className="ay-small ay-muted" style={{ marginTop: 'var(--ay-space-2)' }}>
              {vehicle.registrationNumber} · {vehicle.make} {vehicle.model}
            </p>
          ) : null}
        </div>
      </Card>

      {isDriving ? (
        <>
          {/*
            The route is optional, and the field says so rather than leaving a driver to guess
            whether an empty box will refuse them. Most trips do not have a route worth naming;
            the ones that do are measured against it afterwards.
          */}
          <Field label="Маршрут (по желание)" hint="Например: София → Пловдив. Може и празно.">
            <input
              className="ay-input"
              type="text"
              maxLength={160}
              value={routeLabel}
              onChange={(event) => onRouteLabelChange(event.target.value)}
            />
          </Field>

          <Card>
            <p className="ay-overline ay-muted">Проследяване</p>
            <p className="ay-small" style={{ marginTop: 'var(--ay-space-2)' }}>
              Записът на маршрута започва веднага и продължава до края на курса. Няма пауза —
              спиранията се виждат сами на маршрута.
            </p>
          </Card>
        </>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ay-space-3)' }}>
        <Button block size="large" disabled={busy} onClick={onConfirm}>
          {busy ? 'Момент…' : isDriving ? 'Потвърди и започни курс' : 'Потвърди'}
        </Button>
        <Button block size="large" variant="secondary" disabled={busy} onClick={onCancel}>
          Отказ
        </Button>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- history */

function HistoryScreen({ hasShift }: { hasShift: boolean }) {
  const [rows, setRows] = useState<readonly PositionHistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    workerApi
      .positionHistory()
      .then((response) => setRows(response.sessions))
      .catch((caught: unknown) => setError(describe(caught)));
  }, []);

  return (
    <>
      <div>
        <h2 className="ay-h2">Днешната смяна</h2>
        <p className="ay-small ay-muted">Къде си работил и по колко време.</p>
      </div>

      {error ? (
        <p className="ay-small" style={{ color: 'var(--ay-danger)' }}>
          {error}
        </p>
      ) : null}

      {rows === null && !error ? <p className="ay-small ay-muted">Зареждане…</p> : null}

      {rows !== null && rows.length === 0 ? (
        <Card>
          <p className="ay-small ay-muted">
            {hasShift ? 'Още няма записани позиции за тази смяна.' : 'Няма активна смяна.'}
          </p>
        </Card>
      ) : null}

      {rows !== null && rows.length > 0 ? (
        <div className="ay-list">
          {rows.map((row) => (
            <ListRow
              key={row.id}
              chevron={false}
              title={row.position.name}
              subtitle={`${formatTime(row.startedAt)} – ${row.endedAt ? formatTime(row.endedAt) : 'сега'}`}
              trailing={
                <span className="ay-small ay-numeric">
                  {row.durationSeconds === null ? '—' : formatDuration(row.durationSeconds)}
                </span>
              }
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------------- profile */

function ProfileScreen({ state }: { state: WorkerState }) {
  return (
    <>
      <div>
        <h2 className="ay-h2">
          {state.worker.firstName} {state.worker.lastName}
        </h2>
        <p className="ay-small ay-muted">Служебен номер {state.worker.employeeNumber}</p>
      </div>

      <Card>
        <p className="ay-caption ay-muted">Обект</p>
        <p className="ay-small">{state.worker.site?.name ?? 'Не е зададен'}</p>
        {state.worker.isDriver ? (
          <p className="ay-caption ay-muted" style={{ marginTop: 'var(--ay-space-3)' }}>
            Заведен си и като шофьор.
          </p>
        ) : null}
      </Card>

      <Button
        block
        size="large"
        variant="secondary"
        onClick={() => {
          // Logout is best-effort: the cookie is cleared server-side, and a failure here still
          // has to land on the login screen rather than leaving someone on a dead portal.
          void authApi
            .logout()
            .catch(() => undefined)
            .then(() => window.location.assign('/worker/login'));
        }}
      >
        Изход
      </Button>
    </>
  );
}

/* ----------------------------------------------------------------- shared */

/**
 * A clock anchored to the server.
 *
 * The offset between the device and the server is measured once, when the state arrives, and
 * every duration on the screen is computed through it. Without this a tablet whose clock is an
 * hour out renders a shift that started five minutes ago as an hour and five minutes — and the
 * number a worker disputes is always the one on the screen, never the one in the database.
 */
function useServerClock(serverTime: string | null): () => number {
  const skew = useRef(0);
  const [, tick] = useState(0);

  useEffect(() => {
    if (serverTime) skew.current = Date.parse(serverTime) - Date.now();
  }, [serverTime]);

  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return useCallback(() => Date.now() + skew.current, []);
}

function elapsed(since: string | null, now: number): string {
  if (!since) return '00:00:00';
  return formatDuration(Math.max(0, Math.floor((now - Date.parse(since)) / 1000)));
}

function formatDuration(totalSeconds: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' });
}

function formatOdometer(value: string): string {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number).toLocaleString('bg-BG') : value;
}

/** The device's position for the start of a trip, or null. Never blocks the action. */
async function currentPositionOrNull(): Promise<{ lat: number; lon: number } | null> {
  const { currentPosition } = await import('../../lib/driver');
  return currentPosition();
}

/** What to tell a worker when a request failed, by cause rather than by status code. */
function describe(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Нещо се обърка. Опитай отново.';
  if (error.code === 'network.unreachable') return 'Няма връзка със сървъра.';
  if (error.isEntitlement) return 'Тази функция не е включена в абонамента на фирмата.';

  const messages: Readonly<Record<string, string>> = {
    'shift.already_active': 'Вече имаш започната смяна.',
    'shift.not_active': 'Нямаш започната смяна.',
    'shift.self_start_disabled': 'Смяната се започва от ръководител.',
    'shift.break_already_active': 'Вече си в почивка.',
    'shift.no_open_break': 'Няма започната почивка.',
    'position.change_while_on_break': 'Първо приключи почивката.',
    'position.session_already_open': 'Вече си на тази позиция.',
    'worker.no_site': 'Не си зачислен към обект. Обърни се към ръководителя си.',
    'driving.no_driver_profile': 'Не си заведен като шофьор.',
    'driving.driver_not_active': 'Шофьорският ти профил не е активен.',
    'driving.license_expired': 'Шофьорската ти книжка е изтекла.',
    'driving.vehicle_taken': 'Автомобилът вече е зает от друг шофьор.',
    'driving.vehicle_not_available': 'Автомобилът не е на разположение.',
    'driving.already_holds_vehicle': 'Държиш друг автомобил.',
    'fleet.vehicle_already_assigned': 'Автомобилът вече е зает.',
    'fleet.driver_already_assigned': 'Вече държиш автомобил.',
    'trip.already_active': 'Вече имаш започнат курс.',
  };
  return messages[error.code] ?? 'Действието не беше изпълнено. Опитай отново.';
}
