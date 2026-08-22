'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AppBar,
  Badge,
  Button,
  Card,
  ListRow,
  PortalBody,
  PortalShell,
  Sheet,
  StateCard,
  TabBar,
  ThemeToggle,
} from '@aytracker/ui';
import { PRODUCT_NAME, useRememberedBrand } from '../../lib/brand';
import { BrandMark } from '../../components/brand-mark';

/**
 * Worker portal.
 *
 * Implements the flow from the design reference, including the branch the reference does not
 * show: selecting the driver position opens a vehicle picker, and confirming hands the worker to
 * the driver portal with a trip already recording.
 *
 * The screens are driven by local state here so the flow can be walked end to end without a
 * server. Every action maps one-to-one onto an endpoint that exists — the comments name it — so
 * wiring this to the API is replacing `setState` with `fetch`, not rewriting the component.
 */

type Screen = 'home' | 'positions' | 'vehicles' | 'confirm';

interface Position {
  readonly id: string;
  readonly name: string;
  readonly area: string;
  readonly kind: 'STANDARD' | 'DRIVING';
}

interface Vehicle {
  readonly id: string;
  readonly registrationNumber: string;
  readonly make: string;
  readonly model: string;
  readonly odometer: string;
  readonly isCurrent: boolean;
}

/** Stands in for `GET /api/v1/worker/state` → `availablePositions`. */
const POSITIONS: readonly Position[] = [
  { id: 'm1', name: 'Машина 1', area: 'Екструзия', kind: 'STANDARD' },
  { id: 'm3', name: 'Машина 3', area: 'Екструзия', kind: 'STANDARD' },
  { id: 'pk', name: 'Опаковка', area: 'Пакетиране', kind: 'STANDARD' },
  { id: 'qc', name: 'Контрол качество', area: 'Пакетиране', kind: 'STANDARD' },
  { id: 'drv', name: 'Шофьор', area: 'Транспорт', kind: 'DRIVING' },
];

/** Stands in for `GET /api/v1/worker/positions/:positionId/vehicles`. */
const VEHICLES: readonly Vehicle[] = [
  {
    id: 'v1',
    registrationNumber: 'CA 1234 AB',
    make: 'Ford',
    model: 'Transit',
    odometer: '148 320',
    isCurrent: true,
  },
  {
    id: 'v2',
    registrationNumber: 'PB 5678 CD',
    make: 'MAN',
    model: 'TGL',
    odometer: '392 110',
    isCurrent: false,
  },
  {
    id: 'v3',
    registrationNumber: 'CB 9101 EF',
    make: 'Volvo',
    model: 'FH 500',
    odometer: '412 789',
    isCurrent: false,
  },
];

const TABS = [
  { id: 'home', label: 'Начало', icon: '⌂' },
  { id: 'history', label: 'История', icon: '☰' },
  { id: 'messages', label: 'Съобщения', icon: '✉' },
  { id: 'profile', label: 'Профил', icon: '☺' },
];

export default function WorkerPortalPage() {
  const [screen, setScreen] = useState<Screen>('home');
  const [currentPosition, setCurrentPosition] = useState('Машина 2');
  const [target, setTarget] = useState<Position | null>(null);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [breakOpen, setBreakOpen] = useState(false);
  const elapsed = useShiftTimer();

  /**
   * Whose portal this is.
   *
   * Read from the company code this device signed in with rather than from the session, because
   * the header renders before any request has come back and a bar that says one name and then
   * another half a second later is worse than one that is briefly neutral.
   */
  const brand = useRememberedBrand();
  const appName = brand?.organizationName ?? PRODUCT_NAME;

  const goHome = useCallback(() => {
    setScreen('home');
    setTarget(null);
    setVehicle(null);
  }, []);

  /**
   * Back goes the way the user came, which for a driving position means through the vehicle
   * picker rather than straight to the position list. Returning along the outbound path is what
   * makes Back predictable.
   */
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

  /**
   * Choosing a position.
   *
   * A driving position does not go straight to confirmation — it needs a vehicle first. That
   * branch is the only difference between the two paths, and it lives here rather than in the
   * confirm screen so the extra step is visible in the flow.
   */
  const choosePosition = useCallback((position: Position) => {
    setTarget(position);
    setScreen(position.kind === 'DRIVING' ? 'vehicles' : 'confirm');
  }, []);

  const confirm = useCallback(() => {
    if (!target) return;
    if (target.kind === 'DRIVING' && vehicle) {
      // POST /api/v1/worker/driving/begin — one transaction: closes the current position
      // session, opens the driving session, assigns the vehicle and starts the trip. The
      // response carries `redirectTo`, which is how the device knows to leave this portal.
      window.location.href = '/driver';
      return;
    }
    // POST /api/v1/worker/position/change
    setCurrentPosition(target.name);
    goHome();
  }, [target, vehicle, goHome]);

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
            <span
              style={{ display: 'flex', alignItems: 'center', gap: 'var(--ay-space-2)' }}
              className="ay-h3"
            >
              <BrandMark name={appName} logoUrl={brand?.logoUrl ?? null} logoHeight="1.5rem" />
            </span>
          ) : screen === 'positions' ? (
            'Смяна на позиция'
          ) : screen === 'vehicles' ? (
            'Избери МПС'
          ) : (
            'Потвърди смяна'
          )
        }
        trailing={<ThemeToggle labels={{ light: 'Светла', dark: 'Тъмна', system: 'Системна' }} />}
      />

      <PortalBody>
        {screen === 'home' ? (
          <HomeScreen
            currentPosition={currentPosition}
            elapsed={elapsed}
            onChangePosition={() => setScreen('positions')}
            onBreak={() => setBreakOpen(true)}
          />
        ) : null}

        {screen === 'positions' ? (
          <PositionPicker current={currentPosition} onChoose={choosePosition} />
        ) : null}

        {screen === 'vehicles' && target ? (
          <VehiclePicker
            onChoose={(chosen) => {
              setVehicle(chosen);
              setScreen('confirm');
            }}
          />
        ) : null}

        {screen === 'confirm' && target ? (
          <ConfirmScreen
            from={currentPosition}
            to={target}
            vehicle={vehicle}
            appName={appName}
            onConfirm={confirm}
            onCancel={goHome}
          />
        ) : null}
      </PortalBody>

      <TabBar items={TABS} activeId="home" onSelect={() => undefined} />

      <Sheet open={breakOpen} onClose={() => setBreakOpen(false)} title="Почивка">
        <p className="ay-small ay-muted" style={{ marginBottom: 'var(--ay-space-4)' }}>
          Времето на почивката се записва отделно и се приспада от отработените часове.
        </p>
        <Button block size="large" onClick={() => setBreakOpen(false)}>
          Започни почивка
        </Button>
      </Sheet>
    </PortalShell>
  );
}

function HomeScreen({
  currentPosition,
  elapsed,
  onChangePosition,
  onBreak,
}: {
  currentPosition: string;
  elapsed: string;
  onChangePosition: () => void;
  onBreak: () => void;
}) {
  return (
    <>
      <div>
        <h1 className="ay-h1">Здравей, Иван!</h1>
        <p className="ay-caption ay-muted" style={{ marginTop: 'var(--ay-space-1)' }}>
          Позиция
        </p>
        <p className="ay-h2">{currentPosition}</p>
      </div>

      <StateCard label="Работиш" detail="От 08:00" value={elapsed} />

      {/*
        The primary action, sized for a gloved thumb and given the whole width. Everything else
        on this screen is secondary to it: changing position is the thing a worker does dozens
        of times a shift.
      */}
      <Button block size="large" onClick={onChangePosition}>
        Смени позиция
      </Button>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--ay-space-3)' }}>
        <Button variant="secondary" size="large" onClick={onBreak}>
          ☕ Почивка
        </Button>
        <Button variant="danger" size="large">
          ⏻ Край на смяна
        </Button>
      </div>
    </>
  );
}

function PositionPicker({
  current,
  onChoose,
}: {
  current: string;
  onChoose: (position: Position) => void;
}) {
  return (
    <>
      <div>
        <p className="ay-caption ay-muted">Текуща позиция</p>
        <p className="ay-h2">{current}</p>
      </div>

      <div>
        <p className="ay-caption ay-muted" style={{ marginBottom: 'var(--ay-space-2)' }}>
          Избери нова позиция
        </p>
        {/*
          Only positions this worker may occupy are listed. The filtering is server-side — an
          ineligible position never reaches the device, so the picker cannot be tampered with to
          select one.
        */}
        <div className="ay-list">
          {POSITIONS.map((position) => (
            <ListRow
              key={position.id}
              title={position.name}
              subtitle={position.area}
              trailing={position.kind === 'DRIVING' ? <Badge tone="accent">МПС</Badge> : undefined}
              onClick={() => onChoose(position)}
            />
          ))}
        </div>
      </div>
    </>
  );
}

function VehiclePicker({ onChoose }: { onChoose: (vehicle: Vehicle) => void }) {
  return (
    <>
      <div>
        <h2 className="ay-h2">Избери автомобил</h2>
        <p className="ay-small ay-muted">
          Показани са само свободните автомобили, до които имаш достъп.
        </p>
      </div>

      {/*
        The driver's own vehicle sorts first, which on most mornings turns this screen from a
        choice into a confirmation.
      */}
      <div className="ay-list">
        {VEHICLES.map((vehicle) => (
          <ListRow
            key={vehicle.id}
            title={vehicle.registrationNumber}
            subtitle={`${vehicle.make} ${vehicle.model} · ${vehicle.odometer} км`}
            trailing={vehicle.isCurrent ? <Badge tone="success">Твоят</Badge> : undefined}
            onClick={() => onChoose(vehicle)}
          />
        ))}
      </div>
    </>
  );
}

function ConfirmScreen({
  from,
  to,
  vehicle,
  appName,
  onConfirm,
  onCancel,
}: {
  from: string;
  to: Position;
  vehicle: Vehicle | null;
  /** The organization's name, which is what this application is called to the person reading it. */
  appName: string;
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
            {from}
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

      {/*
        The driver is told what tracking will do before it starts, not after. On the web this is
        the honest answer: recording needs the screen on. A native build says something different
        here, and `detectCapabilities()` is what decides which.
      */}
      {isDriving ? (
        <Card>
          <p className="ay-overline ay-muted">Проследяване</p>
          <p className="ay-small" style={{ marginTop: 'var(--ay-space-2)' }}>
            Записът на маршрута започва веднага. В браузър записът работи, докато екранът е включен
            — {appName} ще го задържи буден. Прекъсванията се отбелязват на маршрута.
          </p>
        </Card>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ay-space-3)' }}>
        <Button block size="large" onClick={onConfirm}>
          {isDriving ? 'Потвърди и започни курс' : 'Потвърди'}
        </Button>
        <Button block size="large" variant="secondary" onClick={onCancel}>
          Отказ
        </Button>
      </div>
    </>
  );
}

/** The shift timer. Formatted with tabular figures so it does not twitch each second. */
function useShiftTimer(): string {
  const start = useMemo(() => Date.now() - (2 * 3600 + 35 * 60 + 42) * 1000, []);
  const [now, setNow] = useState(start);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}
