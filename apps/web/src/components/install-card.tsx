'use client';

import { Button, Card } from '@aytracker/ui';
import { useInstallPrompt } from '../lib/pwa';

/**
 * The offer to add the app to the home screen.
 *
 * Shown on the field portals only, and only where it is actionable — a card telling somebody to
 * install an app they are already running is noise, and so is one on a supervisor's laptop.
 *
 * **What it claims is exactly what installing does.** Not "record in the background": that is not
 * something the web platform grants, installed or not, and this product does not say things it
 * cannot do. What it does say is what a worker notices — an icon to tap, a full screen, and an
 * app Android is slower to shut down while a shift is open.
 *
 * A refusal is remembered. A banner that comes back every morning is one that gets ignored by
 * the second week and resented by the third.
 */
export function InstallCard({ appName }: { appName: string }) {
  const { support, promptInstall, dismiss } = useInstallPrompt();

  if (support === 'NONE') return null;

  return (
    <Card>
      <p className="ay-overline ay-muted">Добавете на началния екран</p>
      <p className="ay-small" style={{ marginTop: 'var(--ay-space-2)' }}>
        {appName} се отваря с едно докосване, ползва целия екран и Android го затваря по-трудно,
        докато смяната върви.
      </p>

      {support === 'MANUAL_IOS' ? (
        <p className="ay-caption ay-muted" style={{ marginTop: 'var(--ay-space-3)' }}>
          В Safari: бутонът за споделяне долу, после „Add to Home Screen“.
        </p>
      ) : null}

      <div
        style={{
          display: 'flex',
          gap: 'var(--ay-space-3)',
          marginTop: 'var(--ay-space-4)',
          alignItems: 'center',
        }}
      >
        {support === 'PROMPTABLE' ? (
          <Button onClick={() => void promptInstall()}>Добави</Button>
        ) : null}
        <Button variant="ghost" onClick={dismiss}>
          Не сега
        </Button>
      </div>
    </Card>
  );
}
