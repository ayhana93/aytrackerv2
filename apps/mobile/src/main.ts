import { installNativeBridge } from './bridge.js';

/**
 * The app entry point.
 *
 * There is no UI here. The mobile app is the web portal in a native shell — one set of screens,
 * one set of API calls, one place where a bug gets fixed. What the shell adds is the one thing a
 * browser cannot do: keep recording with the display off.
 *
 * The bridge is installed before anything else so `detectCapabilities()` finds it on first paint.
 * Install it late and the portal has already decided it is a plain browser, told the driver their
 * screen must stay on, and started the wrong collector.
 */
installNativeBridge();
