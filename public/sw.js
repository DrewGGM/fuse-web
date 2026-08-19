/**
 * Service worker.
 *
 * The game derives its board on the device and scores locally, so once the
 * files are cached there is genuinely nothing left to fetch — a player with no
 * signal gets the whole single-player game, exactly as the Android build does.
 *
 * Strategy, and why:
 *
 *   - **App shell: cache first.** The bundle is a fixed set of hashed files. If
 *     it is cached it cannot have changed, so going to the network first would
 *     only add latency on every launch.
 *   - **API: network only, never cached.** A cached leaderboard is a wrong
 *     leaderboard. The client already handles the request failing.
 *   - **Navigations: cache first, falling back to the network.** This is what
 *     makes launching offline work at all.
 *
 * CACHE_NAME carries the build hash. A new deploy produces a new name, the old
 * cache is deleted on activate, and there is no staleness to reason about.
 */

const CACHE_NAME = 'fuse-9a296ad7bdca';

/** Everything needed to start the game with no network at all. */
const PRECACHE = ['./', './index.html', './manifest.webmanifest', './favicon.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Individually, so one missing optional file cannot fail the whole install.
      await Promise.allSettled(PRECACHE.map((url) => cache.add(url)));
      // A new worker should take over immediately; the alternative is a player
      // stuck on yesterday's build until every tab closes.
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // The API is never cached: a stale rank is worse than no rank.
  if (url.pathname.startsWith('/v1/') || url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;

      try {
        const response = await fetch(request);
        // Only cache what came back whole and from us.
        if (response.ok && response.type === 'basic') {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, response.clone());
        }
        return response;
      } catch {
        // Offline and not cached. For a navigation, the shell is the right
        // answer — the game reconstructs everything else from local storage.
        if (request.mode === 'navigate') {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }
        return new Response('', { status: 504, statusText: 'Offline' });
      }
    })()
  );
});
