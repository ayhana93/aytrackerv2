'use client';

import type { ReactNode } from 'react';
import { useServiceWorker } from '../lib/pwa';

/**
 * The runtime shared by the worker and driver portals.
 *
 * Registers the service worker for the whole route tree, login screen included. That last part
 * is the point: an installed app opens at the login screen, and if the shell is not cached by
 * then, a worker with one bar of signal in a metal-roofed yard gets a blank page and no way in.
 * Registering only after they are signed in would cache the shell exactly one visit too late.
 *
 * The admin panel deliberately does not use this. It is opened on a laptop with a network, and
 * an offline shell there buys nothing worth the extra moving part.
 */
export function FieldApp({ children }: { children: ReactNode }) {
  useServiceWorker();
  return <>{children}</>;
}
