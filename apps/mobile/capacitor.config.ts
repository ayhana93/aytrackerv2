import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The native shell's configuration.
 *
 * `server.url` points at the deployed web portal rather than bundling a copy of it. That is a
 * deliberate trade: it means a fix ships to every phone the moment it is deployed, without an app
 * store review, and it means there is exactly one build of the portal in the world rather than one
 * per app version still installed somewhere.
 *
 * The cost is that the app needs the network to show anything. It is the right cost for this
 * product: a shift cannot be started offline anyway — the server is what opens the tracking
 * session — and the part that genuinely must survive being offline, the point queue, is native
 * and keeps running whether or not the web view can load.
 *
 * `AY_PORTAL_URL` is read at build time. There is no default: a wrong URL here silently points a
 * fleet at somebody else's deployment, which is a worse failure than not building.
 */
const portalUrl = process.env['AY_PORTAL_URL'];
if (!portalUrl) {
  throw new Error(
    'AY_PORTAL_URL must be set to the portal this app should open (e.g. https://app.example.com).',
  );
}

const config: CapacitorConfig = {
  appId: 'com.aytracker.app',
  appName: 'AYtracker',
  // Built from src/ by `pnpm build`; the portal itself is loaded from server.url.
  webDir: 'dist',
  server: {
    url: portalUrl,
    // Cleartext stays off. A tracking app that will accept a plaintext connection is a tracking
    // app whose location stream can be read and rewritten on any café network.
    cleartext: false,
  },
  android: {
    // The web view is not allowed to be the weak point: mixed content off, no debugging in a
    // release build.
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
  ios: {
    contentInset: 'always',
  },
  plugins: {
    BackgroundGeolocation: {
      // Configured per-watcher in src/bridge.ts, where the sampling floor the server sent is
      // available. Nothing is set here so there is one place the values come from.
    },
  },
};

export default config;
