/**
 * Fills in the service worker's cache name and precache list from the build.
 *
 * Runs *after* vite, because both answers only exist once the bundle does. The
 * cache name has to change on every deploy or a returning player keeps the old
 * bundle forever; deriving it from the content of what is being shipped means it
 * changes exactly when something did.
 *
 * The precache list matters more than it looks. It used to name only the shell —
 * `index.html`, the manifest, the icons — and the hashed bundle was left to the
 * runtime handler, which caches whatever it happens to see. That is a race, not
 * a strategy: on the first load the worker has not claimed the page yet, so the
 * script and stylesheet requests never reach it, and whether they are ever
 * cached depends on when `clients.claim()` lands relative to the browser's own
 * cache. Losing that race produces a game that installs, reports itself
 * offline-ready, and then serves a blank screen with no network — which is the
 * one thing this build exists to do. Naming the real files removes the race.
 *
 * `public/sw.js` stays a template with `__BUILD_ID__` and an empty `BUILD_ASSETS`;
 * only the copy in `dist/` is filled in. A source file that rewrites itself on
 * every build shows up as a spurious diff and eventually gets committed wrong.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = walk(DIST).sort();

// Source maps are fetched by devtools and nothing else; precaching a quarter of
// a megabyte of them would triple the offline install for no player benefit.
const shipped = files.filter((f) => !f.endsWith('.map') && !f.endsWith('sw.js'));

const hash = createHash('sha256');
for (const file of shipped) hash.update(readFileSync(file));
const buildId = hash.digest('hex').slice(0, 12);

const assets = shipped
  .map((f) => relative(DIST, f).split('\\').join('/'))
  .filter((f) => f.startsWith('assets/'))
  .filter((f) => /\.(js|css|woff2)$/.test(f))
  .map((f) => `./${f}`);

if (assets.length === 0) throw new Error('no hashed assets found in dist/ — did vite run?');

const sw = join(DIST, 'sw.js');
const source = readFileSync(sw, 'utf8');

const stamped = source
  .replace(/fuse-[a-f0-9]{12}|fuse-__BUILD_ID__/, `fuse-${buildId}`)
  .replace(/const BUILD_ASSETS = \[[^\]]*\];/, `const BUILD_ASSETS = ${JSON.stringify(assets)};`);

if (!stamped.includes(`fuse-${buildId}`)) throw new Error('cache name placeholder not found in sw.js');
if (!stamped.includes(assets[0])) throw new Error('BUILD_ASSETS placeholder not found in sw.js');

writeFileSync(sw, stamped);
console.log(`service worker stamped: fuse-${buildId}, ${assets.length} hashed asset(s) precached`);
