/**
 * Stamps the service worker with a build id and copies it into public/.
 *
 * The cache name has to change on every deploy or a returning player keeps the
 * old bundle forever. Deriving it from the content of what is being shipped
 * means it changes exactly when something did.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const hash = createHash('sha256');
for (const dir of ['../src', '../core/sim', '../core/gen']) {
  for (const name of readdirSync(here(dir)).sort()) {
    hash.update(readFileSync(here(`${dir}/${name}`)));
  }
}
hash.update(readFileSync(here('../index.html')));
const buildId = hash.digest('hex').slice(0, 12);

const template = readFileSync(here('../public/sw.js'), 'utf8');
writeFileSync(here('../public/sw.js'), template.replace(/fuse-[a-f0-9]{12}|fuse-__BUILD_ID__/, `fuse-${buildId}`));

console.log(`service worker stamped: fuse-${buildId}`);
