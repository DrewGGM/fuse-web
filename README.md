# Fuse — web

The browser build of [Fuse](https://github.com/DrewGGM/fuse-game), a daily
chain-reaction puzzle. Same board, same leaderboard, no install required.

**Live at [fuse.andrewgarcia.dev](https://fuse.andrewgarcia.dev)** · leaderboard at `api-fuse.andrewgarcia.dev`

```
        ▽
        ●            ← nodes light as the spark passes
        ●
        ●
      ╲   ●
  ▓▓  ●   ▓▓  ○      ← walls kill the spark
  ●  ╲        ○
  ●  ●  ●  ●  ○      ← unlit nodes stay cold
```

Everyone gets the same board and the same five pieces each day. Place as many or
as few as you like, light one spark, and watch. There is no correct solution —
you chase a score, and the game shows you what a reachable target looks like and
what the record is.

---

## Why this repository exists separately

The Android build ships through Play and moves at Play's pace: a closed test, a
review queue, a version code. The web build ships in about four seconds. Tying
them together would mean the slower one sets the tempo for both.

They share one thing that must never diverge: **the simulation**. Both submit to
the same leaderboard, so if the two copies of the physics disagree by a single
tick, one of them starts producing scores the server refuses — or worse, accepts
against a different board.

`core/` is therefore a vendored copy of `packages/sim` and `packages/gen` from
the Android repository, guarded by a test that hashes 2,000 complete runs:

```bash
npm run core:check      # fails loudly if the two repos have drifted
npm run core:sync       # re-copy from a sibling fuse-game checkout
```

If `core:check` fails, do not edit the pinned fingerprint to make it pass. It
means the two builds are no longer playing the same game.

---

## Getting started

```bash
npm ci
npm run dev             # http://localhost:5173
npm test                # unit + core drift check
npm run test:e2e        # PWA, offline, and a real run in a browser
npm run ci              # everything at once
```

The leaderboard needs the API. Without it the game is fully playable and simply
has nothing to compare against — that is by design, not a fallback.

```bash
# in the fuse-game checkout
cd apps/api && npx wrangler dev          # http://localhost:8787

# here
FUSE_API_BASE=http://localhost:8787 npm run build && npm run preview
```

`FUSE_API_BASE` sets both the API the client calls **and** the CSP's
`connect-src`. Building without it points at production, and the local API is
then refused by the policy — correct behaviour, and confusing for ten minutes if
you do not know it.

### Two verification scripts worth knowing

```bash
node scripts/verify-web.mjs      # loads the built site in a clean browser
node scripts/verify-offline.mjs  # installs, cuts the network, plays a full run
```

`verify-web` exists because a local antivirus rewrites CSP meta tags in the
developer's browser and invents violations. A test that only matches strings
would never have caught the real bug it did catch: `default-src 'none'` blocks
the manifest unless `manifest-src` is set, which means the app is quietly not
installable while looking completely fine.

---

## What differs from the Android build

| | Android | Web |
|---|---|---|
| Daily board, scoring, leaderboard | same | same |
| Offline play | app is local | service worker + cache |
| Install | Play Store | install prompt, PWA |
| Daily reminder | real local notification | **not offered** — see below |
| Ads and purchases | ports wired, adapters pending | **none, ever** |
| Clip export | share sheet | share sheet, download fallback |

**No reminder.** A browser cannot reliably schedule a daily notification —
there is no wake-up when the tab is closed. Rather than ship a switch that
silently does nothing, `isSupported()` returns false and the setting says the
reminder lives in the app.

**No ads, no purchases, deliberately.** The web build is the shop window: it is
how someone tries the game with one tap, and how the twelve closed testers Play
requires get recruited. Monetising it would tax the thing whose job is to be
frictionless.

---

## Deploying

**A push to `main` that passes CI deploys itself.** Two GitHub secrets set it
up: [docs/continuous-deployment.md](docs/continuous-deployment.md).

To publish by hand — the first time, or from a branch:

```bash
npm run deploy
```

Step by step, including what to do if the custom domain does not attach:
**[DEPLOY.md](DEPLOY.md)**.

That builds and publishes to Cloudflare Workers with static assets. The custom
domain in `wrangler.jsonc` is created automatically **if** `andrewgarcia.dev` is
already a zone on the same Cloudflare account. If it is not, add the site in the
Cloudflare dashboard and repoint the nameservers first; until then, comment the
`routes` block out and the site is reachable at `fuse-web.<account>.workers.dev`.

Response headers live in `public/_headers` — `frame-ancestors`, HSTS and the
rest, which a `<meta>` tag cannot set. Hashed assets are immutable; `sw.js` is
never cached, because a cached service worker cannot learn that a new one exists.

The service worker's cache name is stamped from a hash of the source at build
time, so every deploy invalidates cleanly and no deploy invalidates more than it
has to.

---

## Repository settings

Public, with `main` protected: no force pushes, no deletions, CI must pass, and
secret scanning blocks credentials before they land. What that does and does not
cover is in [docs/repository-security.md](docs/repository-security.md).

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE.md).

Read it, learn from it, fork it, run it yourself, send a patch — all fine.
Publishing it to an app store or selling it is not: that right stays with the
author, because this is a commercial game and its store listing is the thing
worth protecting. A clone on Play would be a licence violation, not merely
against Google's rules.

If you want to use any of it commercially, ask.
