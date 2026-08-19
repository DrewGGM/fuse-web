# Deploying

Two things go up: this site, and the API it talks to. They are independent —
the site works without the API, it just has no leaderboard — so deploy the site
first and get something you can look at.

Your Cloudflare account (`pages@andrewgarcia.dev`) is already authenticated, and
`andrewgarcia.dev` already uses Cloudflare nameservers. That removes the two
things that usually block this.

---

## 1. The site

```bash
npm run deploy
```

That runs the build and publishes. On the first deploy Cloudflare creates the
DNS record for `fuse.andrewgarcia.dev` itself, because `wrangler.jsonc` declares
the route as a `custom_domain`. Expect a minute or two for the certificate.

**If it fails on the route**, the zone is not reachable from this account — the
domain uses Cloudflare nameservers, but it must also be a zone on *this* account
rather than another one. Two options:

- Add `andrewgarcia.dev` to the `pages@andrewgarcia.dev` account, or
- Comment out the `routes` block and deploy anyway. The site is then live at
  `fuse-web.<account>.workers.dev`, which is a perfectly good place to test.

Check it:

```bash
curl -sI https://fuse.andrewgarcia.dev | head -1
node scripts/verify-web.mjs https://fuse.andrewgarcia.dev
```

The second one loads the deployed site in a clean browser and reports CSP
violations, whether the manifest is accepted, and whether the service worker
takes control. If it passes, the site is genuinely installable.

---

## 2. The API

From the [fuse-game](https://github.com/DrewGGM/fuse-game) checkout:

```bash
cd apps/api
npx wrangler d1 create fuse-db
# paste the printed database_id into wrangler.toml
npx wrangler d1 migrations apply fuse-db --remote
npx wrangler secret put TOKEN_SECRET     # openssl rand -base64 32
npx wrangler deploy
```

Then give it the matching hostname so it sits on the same zone. In
`apps/api/wrangler.toml`:

```toml
routes = [
  { pattern = "api.fuse.andrewgarcia.dev", custom_domain = true }
]
```

If you host it somewhere else instead, rebuild this site pointing at it —
`FUSE_API_BASE` drives both the client and the CSP's `connect-src`, so they
cannot fall out of step:

```bash
FUSE_API_BASE=https://your-api.example.com npm run deploy
```

### Before real traffic

Two things the API still needs, both from the fuse-game repository's
`docs/release.md`:

- **Security headers** on Worker responses: `X-Frame-Options`,
  `X-Content-Type-Options`, `Strict-Transport-Security`. This site sets its own
  in `public/_headers`; the API does not yet.
- **A rate limit on `POST /v1/players`.** Every other endpoint is bounded —
  three ranked attempts per player per day — but player creation is not, and it
  writes a row. Cloudflare dashboard → Security → WAF → Rate limiting rules.

---

## Decisions you may want to revisit

**One leaderboard or two.** Right now web and Android submit to the same API, so
they share a board. That is the right default — a daily puzzle with two separate
communities is two smaller communities — but it does mean a web player and a
phone player compete directly, and the web build has no ads while the Android one
eventually will. If you would rather split them, deploy a second Worker and
point `FUSE_API_BASE` at it.

**The web build is free of ads on purpose.** Its job is to be the frictionless
way to try the game and the way you recruit the twelve testers Play requires
before production access. Monetising it would tax exactly that.

**Analytics.** There is none. Cloudflare Web Analytics is one script tag and no
cookies, but it needs a `script-src` entry in the CSP, so it is a deliberate
choice rather than something to add by reflex.

---

## Routine

```bash
npm run ci        # lint, types, core drift, tests, build
npm run deploy    # build and publish
```

`npm run core:check` is the one that matters most. Both builds submit to the
same leaderboard, so the vendored simulation in `core/` must behave identically
to the Android one. If it fails, do not adjust the pinned fingerprint to make it
pass — resync, or reconcile the change in both repositories deliberately.
