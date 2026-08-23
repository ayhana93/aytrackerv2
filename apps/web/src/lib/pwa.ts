'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Installing the app, and the service worker behind it.
 *
 * This product is web-based, so "install" means adding it to the home screen. It does not unlock
 * background GPS — nothing does, on the web — but it is still the most useful thing a field
 * worker can do with the app: an icon instead of a URL, its own task on Android so the recording
 * survives being backgrounded longer, and no browser chrome eating a fifth of the screen.
 *
 * The prompt is offered, never forced. A banner that reappears every morning is how an app gets
 * dismissed permanently, so a refusal is remembered.
 */

/** Chrome's install event, which is not in the DOM lib. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISSED_KEY = 'ay.install.dismissed';

/** How platforms differ, which decides whether there is a button or an instruction. */
export type InstallSupport =
  /** Chrome/Android fired `beforeinstallprompt`: a real button that opens the OS dialog. */
  | 'PROMPTABLE'
  /** iOS Safari has no API. The only route is Share → Add to Home Screen, so we say so. */
  | 'MANUAL_IOS'
  /** Already running from the home screen, or the browser does not support installing. */
  | 'NONE';

export interface InstallState {
  readonly support: InstallSupport;
  /** True once the app is running standalone. Nothing to offer. */
  readonly installed: boolean;
  /** Opens the OS install dialog. Only meaningful when support is `PROMPTABLE`. */
  readonly promptInstall: () => Promise<void>;
  /** Remembers a refusal so the offer stops appearing. */
  readonly dismiss: () => void;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  // iPadOS reports as a Mac, and the touch-point count is the only reliable way to tell one from
  // an actual desktop Safari where the Share-sheet instruction would be wrong.
  return (
    /iphone|ipod|ipad/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function useInstallPrompt(): InstallState {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setInstalled(isStandalone());
    try {
      setDismissed(window.localStorage.getItem(DISMISSED_KEY) === '1');
    } catch {
      // Private mode, or storage blocked. Treat it as not dismissed; the worst case is that the
      // offer appears again next time, which is better than never appearing at all.
      setDismissed(false);
    }

    const onBeforeInstall = (event: Event) => {
      // Chrome shows its own mini-infobar unless this is prevented, and it appears at the moment
      // the browser chooses rather than the moment the screen has something to say about it.
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    // One shot: the event cannot be reused, and the browser fires a fresh one if it still applies.
    setDeferred(null);
  }, [deferred]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Nothing to do. The offer will come back, which is the tolerable failure.
    }
  }, []);

  const support: InstallSupport =
    installed || dismissed ? 'NONE' : deferred ? 'PROMPTABLE' : isIos() ? 'MANUAL_IOS' : 'NONE';

  return { support, installed, promptInstall, dismiss };
}

/**
 * Registers the service worker.
 *
 * Deliberately after `load`: registration competes with the first render for bandwidth, and the
 * shift screen is what the person opened the app for. The worker caches nothing but the shell and
 * never touches `/api` — see `public/sw.js`, which explains why at length.
 */
export function useServiceWorker(): void {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    // Registering from a dev server means a stale worker serving yesterday's bundle for the rest
    // of the afternoon. Production only.
    if (process.env.NODE_ENV !== 'production') return;

    const register = () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        // A failed registration costs the offline shell and nothing else. The app works.
      });
    };

    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);
}
