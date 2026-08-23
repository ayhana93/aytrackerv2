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
  StateCard,
  TabBar,
  ThemeToggle,
  TrackingIndicator,
} from '@aytracker/ui';
import type { BackgroundCapability, CollectorStatus } from '@aytracker/tracking-client';
import type { TrackingState } from '@aytracker/tracking';
import { ApiError } from '../../lib/api';
import { authApi } from '../../lib/auth';
import { backgroundNotice, useCapabilities, useTrackingCollector } from '../../lib/tracking';
import {
  currentPosition,
  driverApi,
  type DriverState,
  type DriverVehicle,
  type TripHistoryRow,
} from '../../lib/driver';
import { PRODUCT_NAME, useRememberedBrand } from '../../lib/brand';
import { BrandMark } from '../../components/brand-mark';
import { InstallCard } from '../../components/install-card';

/**
 * Driver portal.
 *
 * The screen a driver looks at from a cradle while moving, so it answers three questions and
 * nothing else: is it recording, how far have I come, and how do I stop.
 *
 * Two things are load-bearing here.
 *
 * **There is no pause.** A trip records from the moment it starts until the driver ends it.
 * The button that used to sit between those two states let the vehicle keep moving while the
 * record stopped, and the fuel burned in that window belonged to nobody. Standing still needs no
 * button: it shows up as a stop on the route, computed from the points.
 *
 * **The route is optional.** A driver who has to leave now presses one button. A run that is
 * worth naming gets a name and, if anyone knows it, a planned distance — and is then measured
 * against it. Neither is a precondition for recording anything.
 */

type Tab = 'home' | 'history' | 'profile';

const TABS = [
  { id: 'home', label: 'Начало', icon: '⌂' },
  { id: 'history', label: 'История', icon: '☰' },
  { id: 'profile', label: 'Профил', icon: '☺' },
];

const TRACKING_LABELS: Readonly<Record<TrackingState, string>> = {
  ACTIVE: 'Проследяването е активно',
  DEGRADED: 'Слаб сигнал',
  PAUSED: 'На пауза',
  INTERRUPTED: 'Проследяването е прекъснато',
  OFFLINE: 'Устройството е офлайн',
  STOPPED: 'Спряно',
};

export default function DriverPortalPage() {
  const [state, setState] = useState<DriverState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('home');
  const capability = useCapabilities();
  const clock = useServerClock(state?.serverTime ?? null);
  // The employer's name and logo, from the company code this device signed in with.
  const brand = useRememberedBrand();
  const appName = brand?.organizationName ?? PRODUCT_NAME;

  const reload = useCallback(async () => {
    try {
      const next = await driverApi.state();
      setState(next);
      setLoadError(null);
      return next;
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthenticated) {
        window.location.assign('/driver/login');
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
   * While a trip is running, the server is asked again every fifteen seconds.
   *
   * Distance and the fuel estimate are computed there, from the points the collector has
   * uploaded — never in the browser from what it happens to have seen. The driver's screen is a
   * view of the record, so it shows the same kilometres the invoice will.
   */
  const tripId = state?.trip?.id ?? null;
  useEffect(() => {
    if (!tripId) return;
    const timer = setInterval(() => void reload(), 15_000);
    return () => clearInterval(timer);
  }, [tripId, reload]);

  /**
   * One collector, shared with the worker portal.
   *
   * The session id comes from the server and may be the trip's own or the working day it runs
   * inside — the driver's screen does not need to know which, and must not decide it.
   */
  const collectorStatus = useTrackingCollector(
    state?.trackingSessionId ?? null,
    state?.samplingPolicy ?? null,
    { holdScreenAwake: true },
  );

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setActionError(null);
      try {
        await action();
        await reload();
      } catch (error) {
        if (error instanceof ApiError && error.isUnauthenticated) {
          window.location.assign('/driver/login');
          return;
        }
        setActionError(describe(error));
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

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

  const trip = state.trip;

  return (
    <PortalShell>
      {/* The title follows the state: there is no "current route" until a trip is running. */}
      <AppBar
        leading={
          <BrandMark name={appName} logoUrl={brand?.logoUrl ?? null} nameless logoHeight="1.5rem" />
        }
        title={<span className="ay-h3">{trip ? 'Текущ маршрут' : appName}</span>}
        trailing={<ThemeToggle labels={{ light: 'Светла', dark: 'Тъмна', system: 'Системна' }} />}
      />

      <PortalBody>
        {actionError ? (
          <p className="ay-small" style={{ color: 'var(--ay-danger)' }} role="alert">
            {actionError}
          </p>
        ) : null}

        {tab === 'home' && trip ? (
          <ActiveTrip
            state={state}
            trip={trip}
            now={clock}
            busy={busy}
            capability={capability}
            collector={collectorStatus}
            appName={appName}
            onEnd={() =>
              void run(async () => {
                const position = await currentPosition();
                await driverApi.endTrip(trip.id, {
                  endLatitude: position?.lat ?? null,
                  endLongitude: position?.lon ?? null,
                });
              })
            }
          />
        ) : null}

        {tab === 'home' && !trip ? (
          <StartTrip
            state={state}
            busy={busy}
            capability={capability}
            appName={appName}
            onStart={(input) =>
              void run(async () => {
                const position = await currentPosition();
                await driverApi.startTrip({
                  ...input,
                  startLatitude: position?.lat ?? null,
                  startLongitude: position?.lon ?? null,
                });
              })
            }
          />
        ) : null}

        {tab === 'history' ? <TripHistory /> : null}

        {tab === 'profile' ? <Profile state={state} /> : null}
      </PortalBody>

      <TabBar items={TABS} activeId={tab} onSelect={(id) => setTab(id as Tab)} />
    </PortalShell>
  );
}

/* ------------------------------------------------------------ active trip */

function ActiveTrip({
  state,
  trip,
  now,
  busy,
  capability,
  collector,
  appName,
  onEnd,
}: {
  state: DriverState;
  trip: NonNullable<DriverState['trip']>;
  now: () => number;
  busy: boolean;
  capability: BackgroundCapability | null;
  collector: CollectorStatus | null;
  /** The employer's name. To the driver, that is what this application is called. */
  appName: string;
  onEnd: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  /**
   * The state the driver is shown is the device's when the device knows better.
   *
   * The server's `trackingState` lags by up to a batch; the collector knows *now* whether fixes
   * are arriving. Showing the stale one would tell a driver in a tunnel that everything is fine.
   */
  const tracking: TrackingState =
    collector && collector.state !== 'STOPPED'
      ? collector.state
      : (trip.trackingState as TrackingState);

  const planned = trip.plannedDistanceMeters;
  const km = (trip.distanceMeters / 1000).toFixed(1);

  return (
    <>
      <InstallCard appName={appName} />

      <div>
        <h1 className="ay-h1">
          Здравей, {state.driver?.firstName ?? state.driver?.code ?? 'шофьор'}!
        </h1>
        <p className="ay-caption ay-muted" style={{ marginTop: 'var(--ay-space-1)' }}>
          Автомобил
        </p>
        <p className="ay-h2">
          {state.vehicle
            ? `${state.vehicle.registrationNumber} · ${state.vehicle.make} ${state.vehicle.model}`
            : '—'}
        </p>
      </div>

      {/*
        The recording indicator, given its own card at the top. A driver must never have to
        wonder whether the route is being recorded — that uncertainty is exactly what turns a
        tracking gap into an argument at the end of the week.
      */}
      <Card>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--ay-space-3)',
          }}
        >
          <TrackingIndicator state={tracking} label={TRACKING_LABELS[tracking]} />
          <Badge tone={tracking === 'ACTIVE' ? 'success' : 'warning'}>
            {tracking === 'ACTIVE' ? 'Записва' : 'Внимание'}
          </Badge>
        </div>
        <p className="ay-caption ay-muted" style={{ marginTop: 'var(--ay-space-3)' }}>
          {capability ? backgroundNotice(capability, appName) : ' '}
        </p>
        {collector && collector.queuedPoints > 0 ? (
          <p className="ay-caption ay-muted">
            {collector.queuedPoints} точки чакат да се изпратят. Ще тръгнат при връзка.
          </p>
        ) : null}
      </Card>

      <div>
        <p className="ay-caption ay-muted">Маршрут</p>
        <p className="ay-h2">{trip.label ?? 'Без зададен маршрут'}</p>
        <p className="ay-small ay-muted">
          {trip.startedAt ? `Започнат в ${formatTime(trip.startedAt)}` : 'Започнат'}
        </p>
      </div>

      <StateCard
        label="ДВИЖЕНИЕ"
        detail="Време на път"
        value={elapsed(trip.startedAt, now())}
        caption={`${km} км`}
      />

      {planned ? (
        <Card padded>
          <p className="ay-caption ay-muted">Планиран маршрут</p>
          <p className="ay-h2 ay-numeric">
            {km} / {(planned / 1000).toFixed(0)} км
          </p>
          <p className="ay-caption ay-muted">
            {trip.distanceMeters > planned
              ? `${((trip.distanceMeters - planned) / 1000).toFixed(1)} км над плана`
              : `остават ${((planned - trip.distanceMeters) / 1000).toFixed(1)} км`}
          </p>
        </Card>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--ay-space-3)' }}>
        <Card padded>
          <p className="ay-caption ay-muted">Среден разход</p>
          <p className="ay-h2 ay-numeric">
            {state.vehicle?.averageConsumption
              ? Number(state.vehicle.averageConsumption).toFixed(1)
              : '—'}
          </p>
          <p className="ay-caption ay-muted">л/100км</p>
        </Card>
        <Card padded>
          <p className="ay-caption ay-muted">Разход за гориво</p>
          <p className="ay-h2 ay-numeric">{state.fuel?.cost ?? '—'}</p>
          <p className="ay-caption ay-muted">
            {state.fuel?.cost
              ? `${state.fuel.currency} (прогноза)`
              : state.fuel
                ? `${state.fuel.liters.toFixed(1)} л (без цена)`
                : 'няма данни'}
          </p>
        </Card>
      </div>

      {/*
        Ending a route is the one irreversible thing on this screen, and it is pressed from a
        cradle by someone who has just parked. Two taps, because one is how a trip gets closed at
        a red light.
      */}
      {confirming ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ay-space-3)' }}>
          <p className="ay-small">Край на маршрута? Записът спира.</p>
          <Button block size="large" variant="danger" disabled={busy} onClick={onEnd}>
            {busy ? 'Приключване…' : 'Да, приключи'}
          </Button>
          <Button
            block
            size="large"
            variant="secondary"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            Продължи курса
          </Button>
        </div>
      ) : (
        <Button block size="large" variant="danger" onClick={() => setConfirming(true)}>
          Край на маршрут
        </Button>
      )}
    </>
  );
}

/* ------------------------------------------------------------- start trip */

function StartTrip({
  state,
  busy,
  capability,
  appName,
  onStart,
}: {
  state: DriverState;
  busy: boolean;
  capability: BackgroundCapability | null;
  /** The employer's name. To the driver, that is what this application is called. */
  appName: string;
  onStart: (input: {
    vehicleId: string | null;
    label: string | null;
    plannedDistanceKm: number | null;
  }) => void;
}) {
  const [vehicles, setVehicles] = useState<readonly DriverVehicle[] | null>(null);
  const [vehicleId, setVehicleId] = useState<string | null>(state.vehicle?.id ?? null);
  const [label, setLabel] = useState('');
  const [plannedKm, setPlannedKm] = useState('');
  const [listError, setListError] = useState<string | null>(null);

  const held = state.vehicle;

  useEffect(() => {
    if (held) return;
    driverApi
      .vehicles()
      .then((response) => {
        setVehicles(response.vehicles);
        // The one they drove last sorts first, so the common morning is a single tap.
        setVehicleId((current) => current ?? response.vehicles[0]?.id ?? null);
      })
      .catch((error: unknown) => {
        setListError(describe(error));
        setVehicles([]);
      });
  }, [held]);

  const parsedKm = plannedKm.trim() === '' ? null : Number(plannedKm.replace(',', '.'));
  const plannedValid = parsedKm === null || (Number.isFinite(parsedKm) && parsedKm > 0);
  const ready = Boolean(held ?? vehicleId) && plannedValid && !busy;

  return (
    <>
      <div>
        <h1 className="ay-h1">
          Здравей, {state.driver?.firstName ?? state.driver?.code ?? 'шофьор'}!
        </h1>
        <p className="ay-small ay-muted" style={{ marginTop: 'var(--ay-space-1)' }}>
          Нямаш започнат курс.
        </p>
      </div>

      {held ? (
        <Card>
          <p className="ay-caption ay-muted">Твоят автомобил</p>
          <p className="ay-h2">{held.registrationNumber}</p>
          <p className="ay-small ay-muted">
            {held.make} {held.model} · {formatOdometer(held.odometerCurrent)} км
          </p>
        </Card>
      ) : (
        <div>
          <p className="ay-caption ay-muted" style={{ marginBottom: 'var(--ay-space-2)' }}>
            Избери автомобил
          </p>

          {listError ? (
            <p className="ay-small" style={{ color: 'var(--ay-danger)' }}>
              {listError}
            </p>
          ) : null}

          {vehicles === null && !listError ? <p className="ay-small ay-muted">Зареждане…</p> : null}

          {vehicles !== null && vehicles.length === 0 ? (
            <Card>
              <p className="ay-small ay-muted">
                Няма свободен автомобил. Или всички са заети в момента, или във фирмата още не са
                въведени — ръководителят ги добавя от админ панела, в „Автопарк“.
              </p>
            </Card>
          ) : null}

          {vehicles !== null && vehicles.length > 0 ? (
            <div className="ay-list">
              {vehicles.map((vehicle) => (
                <ListRow
                  key={vehicle.id}
                  chevron={false}
                  selected={vehicle.id === vehicleId}
                  title={vehicle.registrationNumber}
                  subtitle={`${vehicle.make} ${vehicle.model} · ${formatOdometer(vehicle.odometer)} км`}
                  trailing={
                    vehicle.id === vehicleId ? (
                      <Badge tone="success">Избран</Badge>
                    ) : vehicle.isYourUsual ? (
                      <Badge tone="accent">Твоят</Badge>
                    ) : undefined
                  }
                  onClick={() => setVehicleId(vehicle.id)}
                />
              ))}
            </div>
          ) : null}
        </div>
      )}

      {/*
        The route, and the two fields that make it one. Both optional, and the hints say so —
        a driver who has to leave now should not be reading a form.
      */}
      <Field label="Маршрут (по желание)" hint="Например: София → Пловдив. Може и празно.">
        <input
          className="ay-input"
          type="text"
          maxLength={160}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </Field>

      {label.trim() !== '' ? (
        <Field
          label="Планирани километри (по желание)"
          hint="Ако е зададено, курсът се сравнява с плана."
        >
          <input
            className="ay-input ay-numeric"
            type="text"
            inputMode="decimal"
            value={plannedKm}
            onChange={(event) => setPlannedKm(event.target.value.replace(/[^\d.,]/g, ''))}
          />
        </Field>
      ) : null}

      <Card>
        <p className="ay-overline ay-muted">Проследяване</p>
        <p className="ay-small" style={{ marginTop: 'var(--ay-space-2)' }}>
          {capability ? backgroundNotice(capability, appName) : ' '}
        </p>
        <p className="ay-caption ay-muted" style={{ marginTop: 'var(--ay-space-2)' }}>
          Записът върви от началото до края на курса. Няма пауза — спиранията се виждат сами на
          маршрута.
        </p>
      </Card>

      <Button
        block
        size="large"
        disabled={!ready}
        onClick={() =>
          onStart({
            vehicleId: held ? null : vehicleId,
            label: label.trim() === '' ? null : label.trim(),
            plannedDistanceKm: label.trim() === '' ? null : parsedKm,
          })
        }
      >
        {busy ? 'Стартиране…' : '▶ Започни курс'}
      </Button>
    </>
  );
}

/* ---------------------------------------------------------------- history */

function TripHistory() {
  const [rows, setRows] = useState<readonly TripHistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    driverApi
      .trips()
      .then((response) => setRows(response.trips))
      .catch((caught: unknown) => setError(describe(caught)));
  }, []);

  return (
    <>
      <div>
        <h2 className="ay-h2">Последни курсове</h2>
        <p className="ay-small ay-muted">Разстоянието е изчислено от записаните точки.</p>
      </div>

      {error ? (
        <p className="ay-small" style={{ color: 'var(--ay-danger)' }}>
          {error}
        </p>
      ) : null}

      {rows === null && !error ? <p className="ay-small ay-muted">Зареждане…</p> : null}

      {rows !== null && rows.length === 0 ? (
        <Card>
          <p className="ay-small ay-muted">Още няма записани курсове.</p>
        </Card>
      ) : null}

      {rows !== null && rows.length > 0 ? (
        <div className="ay-list">
          {rows.map((row) => (
            <ListRow
              key={row.id}
              chevron={false}
              title={row.label ?? row.vehicle.registrationNumber}
              subtitle={
                row.startedAt ? `${formatDate(row.startedAt)} · ${formatTime(row.startedAt)}` : '—'
              }
              trailing={
                <span className="ay-small ay-numeric">
                  {(row.distanceMeters / 1000).toFixed(1)} км
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

function Profile({ state }: { state: DriverState }) {
  return (
    <>
      <div>
        <h2 className="ay-h2">
          {state.driver?.firstName ?? ''} {state.driver?.lastName ?? ''}
        </h2>
        <p className="ay-small ay-muted">Код на шофьора {state.driver?.code ?? '—'}</p>
      </div>

      <Card>
        <p className="ay-caption ay-muted">Автомобил</p>
        <p className="ay-small">
          {state.vehicle
            ? `${state.vehicle.registrationNumber} · ${state.vehicle.make} ${state.vehicle.model}`
            : 'Няма зачислен автомобил'}
        </p>
      </Card>

      <Button
        block
        size="large"
        variant="secondary"
        onClick={() => {
          void authApi
            .logout()
            .catch(() => undefined)
            .then(() => window.location.assign('/driver/login'));
        }}
      >
        Изход
      </Button>
    </>
  );
}

/* ----------------------------------------------------------------- shared */

/** A clock anchored to the server, so a wrong device clock cannot invent hours. */
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
  if (!since) return '00:00';
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('bg-BG', { day: '2-digit', month: '2-digit' });
}

function formatOdometer(value: string): string {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number).toLocaleString('bg-BG') : value;
}

/** What to tell a driver when a request failed, by cause rather than by status code. */
function describe(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Нещо се обърка. Опитай отново.';
  if (error.code === 'network.unreachable') return 'Няма връзка със сървъра.';
  if (error.isEntitlement) return 'Проследяването не е включено в абонамента на фирмата.';

  const messages: Readonly<Record<string, string>> = {
    'trip.no_vehicle_assigned': 'Първо избери автомобил.',
    'trip.already_active': 'Вече имаш започнат курс.',
    'trip.not_found': 'Курсът не беше намерен.',
    'driving.vehicle_taken': 'Автомобилът вече е зает от друг шофьор.',
    'driving.vehicle_not_available': 'Автомобилът не е на разположение.',
    'fleet.vehicle_already_assigned': 'Автомобилът вече е зает.',
    'fleet.driver_already_assigned': 'Вече държиш друг автомобил.',
    'vehicle.not_found': 'Автомобилът не беше намерен.',
  };
  return messages[error.code] ?? 'Действието не беше изпълнено. Опитай отново.';
}
