/**
 * Re-copies the shared core from the Android repository.
 *
 * The two apps ship separately, so `core/` is a vendored copy rather than a
 * package dependency. This is the supported way to update it: point at the
 * other checkout, copy, then let `npm run core:check` decide whether the change
 * was intended.
 *
 *   FUSE_GAME_REPO=../fuse-game npm run core:sync
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = process.env.FUSE_GAME_REPO ?? '../fuse-game';
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const FILES: { from: string; to: string; rewrite?: (s: string) => string }[] = [
  { from: 'packages/sim/src/index.ts', to: '../core/sim/index.ts' },
  {
    from: 'packages/gen/src/index.ts',
    to: '../core/gen/index.ts',
    // The monorepo resolves this by workspace name; here it is a relative path.
    rewrite: (s) => s.replace(/} from '@fuse\/sim';/, "} from '../sim/index.js';"),
  },
  { from: 'packages/gen/src/seeds.json', to: '../core/gen/seeds.json' },
  { from: 'packages/gen/src/pars.json', to: '../core/gen/pars.json' },
  { from: 'packages/gen/src/targets.json', to: '../core/gen/targets.json' },
];

let copied = 0;
for (const file of FILES) {
  const source = `${repo}/${file.from}`;
  if (!existsSync(source)) {
    console.error(`missing: ${source}`);
    console.error(`\nSet FUSE_GAME_REPO to the fuse-game checkout. Currently: ${repo}`);
    process.exit(1);
  }

  if (file.rewrite) {
    writeFileSync(here(file.to), file.rewrite(readFileSync(source, 'utf8')));
  } else {
    copyFileSync(source, here(file.to));
  }
  console.log(`  ${file.from}`);
  copied++;
}

console.log(`\nCopied ${copied} files from ${repo}.`);
console.log('Now run `npm run core:check`. If the fingerprint moved, the simulation');
console.log('changed — update EXPECTED_FINGERPRINT in test/core-parity.test.ts only');
console.log('if that was deliberate, and make sure the server was redeployed too.');
