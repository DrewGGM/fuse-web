# Deploy on push

A push to `main` that passes CI publishes itself. Nothing else to run.

```
push to main
    │
    ├─ verify ──── lint · types · core drift · tests · audit · end-to-end
    │                                    │
    │                              all green?
    │                                    │
    └─ deploy ──── build · wrangler deploy · load the live site and check it
```

The `needs: verify` line is what makes that safe: a push whose tests fail never
reaches the deploy job, so a broken build cannot reach the live site. Pull
requests run `verify` only — they never deploy.

---

## One-time setup

Two secrets. Both go in **Settings → Secrets and variables → Actions** on each
repository, or once at the organisation level if you prefer.

### `CLOUDFLARE_ACCOUNT_ID`

```
45b874a5d5551005fb44634d46759bf8
```

Not sensitive — it appears in dashboard URLs — but it is stored as a secret so
the workflow reads it the same way as the token.

### `CLOUDFLARE_API_TOKEN`

Create at **dash.cloudflare.com → My Profile → API Tokens → Create Token**.
Start from *Edit Cloudflare Workers*, then narrow it. It needs exactly:

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

Scope it to **your account** and to the **`andrewgarcia.dev` zone** — not "all
accounts", which is the default and grants far more than this needs.

The zone permissions are needed on every deploy that touches a route, not only
the first, so leave them.

**Do not reuse a Global API Key.** It has no scope at all: anything holding it
can do everything to every zone on the account.

---

## What each workflow does

### `fuse-web`

| Step | |
|---|---|
| `verify` | lint, typecheck, **core drift**, unit tests, production audit, end-to-end |
| `deploy` | build with `FUSE_API_BASE`, `wrangler deploy`, then load the live URL in a real browser |

The core-drift check is the one that matters most. The two builds keep separate
leaderboards, but they run the *same* vendored simulation — so a drift means a
web player and a phone player are no longer playing the same game on the same
day's board, and the two boards stop being comparable at all. That check gates
the deploy.

The final step is not decoration: a deploy can return success and still serve a
page with a broken CSP, a rejected manifest, or a service worker that never
takes control. `scripts/verify-web.mjs` loads what actually went live and fails
the run if any of that is wrong.

### `fuse-game`

| Step | |
|---|---|
| `verify` | lint, typecheck, tests, **cross-engine parity**, end-to-end |
| `android` | builds the AAB, proving the app half still compiles |
| `deploy-api` | migrations, `wrangler deploy`, smoke test against the live API |

`deploy-api` needs **both** earlier jobs. The Android build is included on
purpose: the app and the Worker share the simulation, so a commit that breaks the
app should not put its server half live.

The Android app is **not** deployed by CI. It ships as a signed bundle through
Play's review queue — see `docs/release.md` in that repository.

---

## Migrations run automatically

`deploy-api` applies pending D1 migrations before deploying the code that needs
them. Wrangler tracks what has already run, so this is idempotent.

That is safe *because* migrations here are additive and forward-only: add a
nullable column, backfill, then constrain — never rename in place. A migration
that dropped a column would run automatically against production with no
confirmation. If you ever need a destructive one, take it out of the automatic
path and run it by hand.

---

## Deliberately not included

**No manual approval gate.** Both jobs declare `environment: production`, so if
you later want a human to click before each deploy, add a required reviewer to
that environment in GitHub settings. It is one checkbox and no code change. For
a daily puzzle it seemed like ceremony.

**No rollback step.** `wrangler rollback` exists and is a better answer than a
scripted one, because a rollback is a decision. If a deploy goes wrong:

```bash
npx wrangler rollback            # the site
cd apps/api && npx wrangler rollback   # the API
```

**No preview deploys per pull request.** They cost a Worker per branch and
duplicate what `npm run preview` already gives locally. Worth adding if more
than one person starts working on this.

---

## Checking it works

The honest test is a real push. Before that:

```bash
gh secret list                                  # both secrets present?
npx wrangler deploy --dry-run                   # config parses?
git commit --allow-empty -m "test the pipeline" && git push
gh run watch                                    # follow it
```

The first deploy is the slow one — Cloudflare provisions the custom domain and
issues a certificate, which can take a few minutes. Later deploys take seconds.
