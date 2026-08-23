import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectCapabilities } from './capabilities';

/**
 * What the device can do, and — more importantly — what it is never allowed to claim.
 *
 * This product is web-based. There is no configuration, no browser and no installed state in
 * which recording survives a locked screen, so the one thing these tests defend is that no code
 * path can report otherwise. A worker who believes their route is recording, and finds out at
 * the end of the week that it was not, discovers the platform's limits in an argument about
 * their pay.
 */

const realWindow = globalThis.window;
const realNavigator = globalThis.navigator;

function stubBrowser(options: {
  geolocation?: boolean;
  wakeLock?: boolean;
  permissions?: boolean;
  standalone?: boolean;
  iosStandalone?: boolean;
}) {
  const navigatorStub: Record<string, unknown> = {};
  if (options.geolocation !== false) navigatorStub['geolocation'] = {};
  if (options.wakeLock) navigatorStub['wakeLock'] = {};
  if (options.permissions) navigatorStub['permissions'] = {};
  if (options.iosStandalone) navigatorStub['standalone'] = true;

  vi.stubGlobal('navigator', navigatorStub);
  vi.stubGlobal('window', {
    matchMedia: (query: string) => ({
      matches: options.standalone === true && query.includes('standalone'),
    }),
    navigator: navigatorStub,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (realWindow) vi.stubGlobal('window', realWindow);
  if (realNavigator) vi.stubGlobal('navigator', realNavigator);
  vi.unstubAllGlobals();
});

describe('detectCapabilities', () => {
  /**
   * The assertion this whole file exists for.
   *
   * `BackgroundCapability` has no member that means "records with the screen off", so there is
   * no value `detectCapabilities` could return that would let a screen promise it. If somebody
   * ever adds one back, this fails.
   */
  it('never reports a capability that would promise screen-off recording', () => {
    for (const state of [
      { wakeLock: true },
      { wakeLock: false },
      { standalone: true, wakeLock: true },
      { iosStandalone: true, wakeLock: true },
      { geolocation: false },
    ]) {
      stubBrowser(state);
      const capabilities = detectCapabilities();
      expect(['WAKE_LOCK', 'FOREGROUND_ONLY', 'NONE']).toContain(capabilities.background);
      vi.unstubAllGlobals();
    }
  });

  it('reports WAKE_LOCK when the browser can hold the screen on', () => {
    stubBrowser({ wakeLock: true, permissions: true });
    const capabilities = detectCapabilities();
    expect(capabilities.background).toBe('WAKE_LOCK');
    expect(capabilities.geolocation).toBe(true);
    expect(capabilities.wakeLock).toBe(true);
    expect(capabilities.backgroundNoticeKey).toBe('tracking.background.wake_lock');
  });

  it('falls back to FOREGROUND_ONLY without wake lock support', () => {
    stubBrowser({ wakeLock: false });
    expect(detectCapabilities().background).toBe('FOREGROUND_ONLY');
  });

  it('reports NONE when there is no geolocation at all', () => {
    stubBrowser({ geolocation: false, wakeLock: true });
    const capabilities = detectCapabilities();
    expect(capabilities.background).toBe('NONE');
    expect(capabilities.backgroundNoticeKey).toBe('tracking.background.unavailable');
  });

  /**
   * Installing changes how long Android tolerates the app, not what the platform permits. The
   * capability is therefore unchanged by it — only `installed` moves, which is what the portal
   * uses to decide whether offering the install is worth the space.
   */
  it('notices an installed app without changing what it promises', () => {
    stubBrowser({ wakeLock: true });
    const inTab = detectCapabilities();
    expect(inTab.installed).toBe(false);

    vi.unstubAllGlobals();
    stubBrowser({ wakeLock: true, standalone: true });
    const installed = detectCapabilities();
    expect(installed.installed).toBe(true);
    expect(installed.background).toBe(inTab.background);
  });

  it('notices an iOS home-screen app, which reports itself differently', () => {
    // iOS Safari has never implemented `display-mode: standalone` for this; `navigator.standalone`
    // is the only signal, and it exists on no other platform.
    stubBrowser({ wakeLock: true, iosStandalone: true });
    expect(detectCapabilities().installed).toBe(true);
  });

  it('is safe to call during a server render', () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('navigator', undefined);
    const capabilities = detectCapabilities();
    expect(capabilities.background).toBe('NONE');
    expect(capabilities.installed).toBe(false);
  });
});
