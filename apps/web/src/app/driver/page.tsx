'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AppBar,
  Badge,
  Button,
  Card,
  PortalBody,
  PortalShell,
  StateCard,
  TabBar,
  ThemeToggle,
  TrackingIndicator,
} from '@aytracker/ui';
import { detectCapabilities, type BackgroundCapability } from '@aytracker/tracking-client';
import type { TrackingState } from '@aytracker/tracking';
import { PRODUCT_NAME, useRememberedBrand } from '../../lib/brand';
import { BrandMark } from '../../components/brand-mark';

/**
 * Driver portal — where the worker lands after picking a vehicle.
 *
 * The screen a driver looks at from a cradle while moving, so it answers three questions at a
 * glance and nothing else: is it recording, how far have I come, and how do I stop.
 *
 * The tracking notice is the part that matters most. It states what will happen when the screen
 * goes off *before* it happens, based on what this device can actually do — see
 * `@aytracker/tracking-client/capabilities`.
 */

const TABS = [
  { id: 'home', label: 'Начало', icon: '⌂' },
  { id: 'routes', label: 'Маршрути', icon: '⇄' },
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

/**
 * What to tell the driver about the screen going off.
 *
 * Never a promise the platform will not keep. On the web the honest answer is that recording
 * needs the screen on; only a native build can say otherwise.
 *
 * Takes the application's name rather than hardcoding it: to the driver reading this, the
 * application is their employer's, and it is that name on the bar above the text.
 */
function backgroundNotice(capability: BackgroundCapability, appName: string): string {
  switch (capability) {
    case 'NATIVE':
      return 'Записът продължава и при изгасен екран.';
    case 'WAKE_LOCK':
      return `Записът работи, докато екранът е включен. ${appName} го задържа буден по време на курса.`;
    case 'FOREGROUND_ONLY':
      return `Дръж ${appName} отворен, за да се записва маршрутът. Прекъсванията се отбелязват.`;
    case 'NONE':
      return 'Това устройство не поддържа проследяване на местоположението.';
  }
}

export default function DriverPortalPage() {
  const [paused, setPaused] = useState(false);
  const elapsed = useTripTimer();
  const capabilities = useCapabilities();
  // The employer's name and logo, from the company code this device signed in with.
  const brand = useRememberedBrand();
  const appName = brand?.organizationName ?? PRODUCT_NAME;

  const state: TrackingState = paused ? 'PAUSED' : 'ACTIVE';

  return (
    <PortalShell>
      <AppBar
        leading={
          <BrandMark name={appName} logoUrl={brand?.logoUrl ?? null} nameless logoHeight="1.5rem" />
        }
        title={<span className="ay-h3">Текущ маршрут</span>}
        trailing={<ThemeToggle labels={{ light: 'Светла', dark: 'Тъмна', system: 'Системна' }} />}
      />

      <PortalBody>
        <div>
          <h1 className="ay-h1">Здравей, Иван!</h1>
          <p className="ay-caption ay-muted" style={{ marginTop: 'var(--ay-space-1)' }}>
            Автомобил
          </p>
          <p className="ay-h2">CA 1234 AB · Ford Transit</p>
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
            <TrackingIndicator state={state} label={TRACKING_LABELS[state]} />
            <Badge tone={state === 'ACTIVE' ? 'success' : 'warning'}>
              {state === 'ACTIVE' ? 'Записва' : 'Пауза'}
            </Badge>
          </div>
          <p className="ay-caption ay-muted" style={{ marginTop: 'var(--ay-space-3)' }}>
            {capabilities ? backgroundNotice(capabilities, appName) : ' '}
          </p>
        </Card>

        <div>
          <p className="ay-caption ay-muted">Маршрут</p>
          <p className="ay-h2">София → Пловдив</p>
          <p className="ay-small ay-muted">Започнат в 07:15</p>
        </div>

        <StateCard
          label={paused ? 'Пауза' : 'Движение'}
          detail="Време на път"
          value={elapsed}
          caption="156 км"
        />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--ay-space-3)' }}>
          <Card padded>
            <p className="ay-caption ay-muted">Среден разход</p>
            <p className="ay-h2 ay-numeric">8.2</p>
            <p className="ay-caption ay-muted">л/100км</p>
          </Card>
          <Card padded>
            <p className="ay-caption ay-muted">Разход за гориво</p>
            <p className="ay-h2 ay-numeric">24.32</p>
            <p className="ay-caption ay-muted">лв. (прогноза)</p>
          </Card>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ay-space-3)' }}>
          <Button block size="large" variant="secondary" onClick={() => setPaused((v) => !v)}>
            {paused ? '▶ Продължи' : '⏸ Пауза'}
          </Button>
          <Button block size="large" variant="danger">
            Край на маршрут
          </Button>
        </div>
      </PortalBody>

      <TabBar items={TABS} activeId="home" onSelect={() => undefined} />
    </PortalShell>
  );
}

/**
 * Capability detection runs on the client only.
 *
 * Rendering the notice on the server would mean guessing, and guessing here means telling a
 * driver their route is safe when it is not. Until the answer is known the line is blank.
 */
function useCapabilities(): BackgroundCapability | null {
  const [capability, setCapability] = useState<BackgroundCapability | null>(null);
  useEffect(() => {
    setCapability(detectCapabilities().background);
  }, []);
  return capability;
}

function useTripTimer(): string {
  const start = useMemo(() => Date.now() - (2 * 3600 + 35 * 60) * 1000, []);
  const [now, setNow] = useState(start);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}`;
}
