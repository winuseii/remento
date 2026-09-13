// Remento service worker.
//
// Caches the app shell ONLY — never card data, never a Supabase response.
// §1.5 of the spec is explicit about what this does and does not buy you:
// Remento *opens* without a connection, and then has nothing to show. v2 is
// where an IndexedDB mirror makes it actually usable offline. The PWA exists
// now so that stays possible.

const VERSION = 'v1';
const SHELL = `remento-shell-${VERSION}`;

/** Everything needed to paint the frame. No data, no user content. */
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/tokens.css',
  './css/app.css',
  './js/app.js',
  './js/icons.js',
  './js/command-palette.js',
  './js/views/subject.js',
  './js/config.js',
  './js/supabase.js',
  './js/auth.js',
  './js/db.js',
  './js/ui.js',
  './js/images.js',
  './js/importer.js',
  './js/scheduler.js',
  './js/card-render.js',
  './js/card-editor.js',
  './js/views/drill.js',
  './js/views/browse.js',
  './js/views/import.js',
  './js/views/stats.js',
  './js/views/settings.js',
  './icons/mark.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // addAll is all-or-nothing; one 404 would leave no cache at all, so each
    // file is added on its own and a miss is logged rather than fatal.
    await Promise.all(SHELL_FILES.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (e) {
        console.warn('[sw] could not cache', url, e.message);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Card data never touches the cache. Not the REST API, not auth, not the
  // signed image URLs — a stale card is worse than no card, and a cached
  // token is a security problem.
  if (url.hostname.endsWith('supabase.co')) return;

  // Navigations: network first, so a deploy is picked up immediately, with the
  // cached shell as the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(SHELL);
        return (await cache.match('./index.html')) ?? Response.error();
      }
    })());
    return;
  }

  // Our own static files: serve from cache, refresh in the background.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(request, { ignoreSearch: true });
      const live = fetch(request).then((res) => {
        if (res.ok) cache.put(request, res.clone());
        return res;
      }).catch(() => null);
      return hit ?? (await live) ?? Response.error();
    })());
    return;
  }

  // jsDelivr and the font CDN: try the network, fall back to whatever we have.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    try {
      const res = await fetch(request);
      if (res.ok) cache.put(request, res.clone());
      return res;
    } catch {
      return (await cache.match(request)) ?? Response.error();
    }
  })());
});
