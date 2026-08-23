/*
 * The service worker.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR, AND WHAT IT MUST NEVER DO
 * ---------------------------------------------------------------------------
 *
 * It exists for one situation: a worker in a metal-roofed warehouse or a yard with one bar of
 * signal opens the app and gets a blank page, because the JavaScript bundle could not be
 * fetched. Their shift data is on the server and the app cannot even render the button that
 * would load it. Caching the shell fixes that, and nothing else here is worth doing.
 *
 * **It never caches an API response.** Not once, not briefly, not "just the GET". Every screen in
 * this product reports how far someone drove, how long they worked, and whether their phone is
 * currently reporting — and a cached copy of any of those is a confident, plausible lie. A
 * supervisor looking at a stale live map would conclude a van is somewhere it left twenty minutes
 * ago. Requests to the API are not intercepted at all: they go to the network, and if the network
 * is not there the app already knows how to say so.
 *
 * **It never caches a navigation permanently.** A stale HTML document paired with a new API is
 * how a client starts sending a request shape the server stopped accepting. Navigations are
 * network-first; the cached copy is a fallback for when the network fails outright.
 *
 * Hashed build assets are the one thing cached confidently: `/_next/static/...` filenames contain
 * a content hash, so a given URL's bytes never change and a cache hit is always correct.
 *
 * The queue of unsent GPS points does **not** live here. It is in IndexedDB, owned by
 * `packages/tracking-client`, and it survives without any of this.
 */

/** Bumped when the cached shell changes shape. Old caches are deleted on activate. */
const CACHE = 'aytracker-shell-v1';

/** Requests that must always reach the network. Checked before anything else. */
function isApi(url) {
  return url.pathname.startsWith('/api/');
}

function isHashedAsset(url) {
  return url.pathname.startsWith('/_next/static/');
}

function isIcon(url) {
  return url.pathname.startsWith('/icons/') || url.pathname === '/favicon.png';
}

self.addEventListener('install', (event) => {
  // The icons only. The HTML and the bundles are cached as they are actually fetched, because
  // their URLs contain build hashes that this file cannot know.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(['/icons/icon-192.png', '/favicon.png']))
      // A failed precache must not block activation: the app works without it.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Same-origin only. A tile server or a font host is not ours to cache or to speak for.
  if (url.origin !== self.location.origin) return;

  // The rule that matters. Left entirely alone, so the browser's own handling applies.
  if (isApi(url)) return;

  if (isHashedAsset(url) || isIcon(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
  }
});

/** Immutable by construction: the URL carries a content hash. */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE);
    void cache.put(request, response.clone());
  }
  return response;
}

/**
 * Fresh when possible, cached when the network fails.
 *
 * The cache is updated on every success, so the fallback is the last page that actually loaded
 * rather than whatever was there on install day.
 */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      void cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw error;
  }
}
