/**
 * Guards for the two things that make this build work with no network.
 *
 * Both were broken at once and neither was visible from inside the app: the
 * worker installed, reported itself ready, and served a blank page offline
 * while holding the entire game in its cache. The end-to-end offline suite does
 * catch it, but it needs a browser, a build and a service worker to say so, and
 * it has its own timing flakiness. These read the file.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sw = readFileSync(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8');

describe('the precache list', () => {
  it('includes the hashed bundle, not just the shell', () => {
    // The bundle used to be left to the runtime handler. That is a race: on the
    // first load the worker has not claimed the page, so the script and
    // stylesheet requests never reach it, and whether they are ever cached
    // depends on when clients.claim() lands. Losing it ships an app that
    // installs and then cannot start.
    expect(sw).toContain('...BUILD_ASSETS');
    expect(sw).toMatch(/const BUILD_ASSETS = \[\s*\];/);
  });

  it('includes every sound cue', () => {
    for (const cue of ['select', 'place', 'pickup', 'invalid', 'launch', 'ignite', 'bomb', 'result']) {
      expect(sw).toContain(`./sfx/${cue}.m4a`);
    }
  });

  it('says so when an entry fails instead of swallowing it', () => {
    // allSettled is right — one missing optional file should not fail the whole
    // install — but an unreported rejection is how a half-cached worker passes
    // for a working one.
    expect(sw).toContain('not precached');
  });
});

describe('cache lookups', () => {
  it('ignore Vary', () => {
    // The host answers assets with `Vary: Origin` and Vite marks its own script
    // and link tags `crossorigin`, so the page asks in CORS mode with an Origin
    // header while cache.add() asks without one. Same URL, different Vary key,
    // no match — every asset present and invisible.
    expect(sw).toMatch(/caches\.match\(request,\s*\{\s*ignoreVary:\s*true\s*\}\)/);
  });
});
