import type { MetadataRoute } from 'next';

/**
 * The web app manifest — what makes this installable.
 *
 * This product is web-based, which makes installing it the single most useful thing a field
 * worker can do with it. Not because it unlocks background GPS — it does not, and nothing in
 * this codebase pretends otherwise — but for three effects that matter on a shift:
 *
 *   * **An icon instead of a URL.** A worker taps a thing on their home screen. Nobody types an
 *     address at 05:40 in a yard.
 *   * **Its own task on Android.** An installed app is backgrounded far less aggressively than
 *     a tab, so the stretch between locking the screen and the recording stopping is longer, and
 *     it is much less likely to be discarded outright while a shift is open.
 *   * **No browser chrome.** The portals are full-screen control surfaces; a URL bar and a tab
 *     strip are a hundred pixels of a phone screen spent on nothing.
 *
 * `start_url` is the bare domain rather than a portal, because one manifest serves all three and
 * the root already routes by session. The two shortcuts are what make it feel like the right app
 * anyway: a long-press on the icon goes straight to the screen that person actually uses.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'AYtracker',
    short_name: 'AYtracker',
    description: 'Работни часове, позиции и маршрути.',
    start_url: '/',
    /*
     * A stable identity, independent of `start_url`.
     *
     * Without it the browser derives the app's id from the start URL, and changing that URL later
     * would register a *second* app rather than updating the installed one — leaving a fleet with
     * two icons and no idea which is current.
     */
    id: '/',
    scope: '/',
    display: 'standalone',
    // Matches the icon tile, so the splash screen and the status bar do not flash a colour the
    // app never uses.
    background_color: '#4F46E5',
    theme_color: '#4F46E5',
    lang: 'bg',
    dir: 'ltr',
    // Deliberately unset: the field portals are portrait, the admin panel is used on a laptop and
    // a tablet, and one manifest serves both. Locking it would break the half it does not fit.
    categories: ['business', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      /*
       * The maskable variant is a separate file, not the same one relabelled.
       *
       * A launcher crops a maskable icon to its own shape — a circle on most Android skins — so
       * the artwork has to sit inside the middle 80% with the background running to the edge.
       * Declaring the rounded tile as maskable is how an icon ends up with its corners sliced off.
       */
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    shortcuts: [
      {
        name: 'Моята смяна',
        short_name: 'Смяна',
        url: '/worker',
        icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }],
      },
      {
        name: 'Курс',
        short_name: 'Курс',
        url: '/driver',
        icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }],
      },
    ],
  };
}
