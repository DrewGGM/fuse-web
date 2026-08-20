# Deploying

**The web build is live.** `https://fuse.andrewgarcia.dev`, with its leaderboard
at `https://api-fuse.andrewgarcia.dev`.

| | |
|---|---|
| Site | `fuse-web` Worker, static assets |
| API | `fuse-web-api` Worker |
| Database | `fuse-web-db` (D1), `7ddfac13-d4b3-402b-a3b9-00249688cad1` |
| Signing secret | set as a Cloudflare secret, not in this repository |

Redeploying by hand is two commands:

```bash
npm run api:deploy    # only when api/ changed
npm run deploy        # build and publish the site
```

---

## The one thing left: deploy on push

Everything above happens automatically once GitHub can talk to Cloudflare. Two
secrets, once.

### 1. `CLOUDFLARE_ACCOUNT_ID`

```
45b874a5d5551005fb44634d46759bf8
```

### 2. `CLOUDFLARE_API_TOKEN`

**dash.cloudflare.com → My Profile → API Tokens → Create Token → Create Custom
Token.**

Give it exactly these, and no more:

| Section | Permission | Level |
|---|---|---|
| Account | Workers Scripts | Edit |
| Account | Workers R2 Storage | Edit |
| Account | D1 | Edit |
| Account | Account Settings | Read |
| Zone | **Workers Routes** | **Edit** |
| Zone | DNS | Edit |
| User | User Details | Read |

`Workers Routes` is the one that is easy to miss and the one that fails: a
custom domain is a zone-level route, so without it the deploy uploads the Worker
and then dies on `/zones/.../workers/routes` with `Authentication error [code:
10000]`. `User Details → Read` only silences a warning, but wrangler prints it
loudly enough to look like the cause.

Then scope it:

- **Account Resources** → Include → `Pages@andrewgarcia.dev's Account`
- **Zone Resources** → Include → Specific zone → `andrewgarcia.dev`

Not "All accounts", which is the default and grants far more than this needs.
Never a Global API Key, which has no scope at all.

Copy the token — it is shown once.

### 3. Add both to GitHub

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID --body "45b874a5d5551005fb44634d46759bf8"
gh secret set CLOUDFLARE_API_TOKEN          # paste when prompted
```

Or **Settings → Secrets and variables → Actions → New repository secret** in the
browser. Do it in both `fuse-web` and `fuse-game`.

### 4. Prove it

```bash
git commit --allow-empty -m "check the pipeline"
git push
gh run watch
```

The deploy job should now run its steps instead of skipping them. Without the
secrets it posts a notice and stops, which is why every push so far has been
green with nothing deployed.

---

## Setting it up somewhere else

The commands that produced the current deployment, in order:

```bash
cd api
npx wrangler d1 create fuse-web-db
# paste the printed database_id into api/wrangler.toml

npx wrangler d1 migrations apply fuse-web-db --remote --config ./wrangler.toml
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" \
  | npx wrangler secret put TOKEN_SECRET --config ./wrangler.toml
npx wrangler deploy --config ./wrangler.toml

cd ..
npm run deploy
```

**`--config ./wrangler.toml` is not optional** when running from `api/`.
Wrangler searches upward and finds the site's `wrangler.jsonc` at the repository
root, then reports that it cannot find a database binding which is defined right
there in front of it. That error cost ten minutes the first time.

**`TOKEN_SECRET` must be a secret, never a `[vars]` entry.** A var in
`wrangler.toml` becomes the deployed value, so putting it there publishes the
signing key to a public repository.

---

## Verifying a deployment

```bash
node scripts/verify-web.mjs https://fuse.andrewgarcia.dev
node scripts/verify-production.mjs
```

The first loads the site in a clean browser and reports CSP violations, whether
the manifest is accepted and whether the service worker takes control. The
second plays an actual ranked run against the live API and checks the rank comes
back — which is the only test that exercises DNS, TLS, the Worker and D1 at once.

Both run in CI after a deploy, so a deploy that succeeds while serving something
broken fails the build.

---

## Still to do before real traffic

- **Rate limit `POST /v1/players`.** Every other endpoint is bounded — three
  ranked attempts per player per day, counted on the player row — but player
  creation writes a row for anyone who asks. Cloudflare dashboard → Security →
  WAF → Rate limiting rules.
- **Security headers on the API's responses.** The site sets its own in
  `public/_headers`; the Worker does not yet set `X-Frame-Options`,
  `X-Content-Type-Options` or HSTS.

---

## Decisions already made

**Separate leaderboards.** This API serves the web build only. The Android app
has its own in [fuse-game](https://github.com/DrewGGM/fuse-game), with its own
database. The code is identical and vendored from the same `core/`; only the
deployment and therefore the community differ.

**No ads or purchases on the web.** Its job is to be the frictionless way to try
the game, and how the twelve testers Play requires get recruited.

**Cloudflare Web Analytics is allowed in the CSP.** Cloudflare injects the
beacon at zone level, and a policy that blocks it leaves a failing script tag on
every page load without stopping the request. It is cookieless. To have none,
turn the injection off in the dashboard *and* remove it from the CSP.
