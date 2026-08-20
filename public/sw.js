/**
 * Service worker.
 *
 * The game derives its board on the device and scores locally, so once the
 * files are cached there is genuinely nothing left to fetch — a player with no
 * signal gets the whole single-player game, exactly as the Android build does.
 *
 * Strategy, and why:
 *
 *   - **App shell: cache first, and precached by name.** The bundle is a fixed
 *     set of hashed files, so if it is cached it cannot have changed and going
 *     to the network first would only add latency. It is named in PRECACHE
 *     rather than left to the runtime handler: on the first load this worker
 *     has not claimed the page yet, so those requests never reach it, and
 *     relying on them being cached later is a race this build used to lose.
 *   - **API: network only, never cached.** A cached leaderboard is a wrong
 *     leaderboard. The client already handles the request failing.
 *   - **Navigations: cache first, falling back to the network.** This is what
 *     makes launching offline work at all.
 *
 * CACHE_NAME carries the build hash. A new deploy produces a new name, the old
 * cache is deleted on activate, and there is no staleness to reason about.
 */

const CACHE_NAME = 'fuse-__BUILD_ID__';

/**
 * The hashed bundle, filled in by `scripts/stamp-sw.ts` after vite has run.
 *
 * Empty here on purpose: this file is the template, and the names only exist
 * once the build has produced them.
 */
const BUILD_ASSETS = [];

/** Everything needed to start the game with no network at all. */
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.png',
  './icon-512.png',
  // The eight cues, 37 kB in total. Fetch-on-demand would cache them too, but
  // only after they had already played silently once: a player who installs the
  // game and then loses signal would get their first run with no sound at all.
  './sfx/select.m4a',
  './sfx/place.m4a',
  './sfx/pickup.m4a',
  './sfx/invalid.m4a',
  './sfx/launch.m4a',
  './sfx/ignite.m4a',
  './sfx/bomb.m4a',
  './sfx/result.m4a',
  ...BUILD_ASSETS,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Individually, so one missing optional file cannot fail the whole install.
      const results = await Promise.allSettled(PRECACHE.map((url) => cache.add(url)));
      // Named, not swallowed. A precache entry that quietly fails produces a
      // worker that reports itself installed and an app that is not actually
      // offline-capable, which is the hardest kind of bug to see from outside.
      for (const [i, r] of results.entries()) {
        if (r.status === 'rejected') console.warn('[fuse-sw] not precached:', PRECACHE[i], r.reason);
      }
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
      // ignoreVary, and this is load-bearing rather than defensive.
      //
      // The static host answers assets with `Vary: Origin`, and Vite marks its
      // own script and stylesheet tags `crossorigin` — so the page asks for the
      // bundle in CORS mode, with an Origin header, while `cache.add()` in the
      // install step asks for it without one. Same URL, different Vary key, and
      // the match fails: every hashed asset sits in the cache and is invisible
      // to the request that needs it. Offline, that is a blank screen served
      // from a cache that has the whole game in it.
      //
      // These are content-hashed, same-origin files. There is exactly one
      // representation of each, so there is nothing for Vary to distinguish.
      const cached = await caches.match(request, { ignoreVary: true });
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
