# Repository settings

Both repositories are public. This records what protects them and what does not,
because "public" changes the threat model: the code, the history, the CI
configuration and every past commit are now readable by anyone, permanently.

---

## Nobody can push to `main`

Not a setting so much as how GitHub works: **a public repository grants no write
access to strangers.** Someone who wants to change it must fork it and open a
pull request, which you review. There is no configuration that would let a
random visitor push.

On top of that, `main` is protected on both repositories:

| | |
|---|---|
| Force pushes | blocked — history cannot be rewritten |
| Branch deletion | blocked |
| Status check `verify` | must pass before merge |
| Linear history | required — no merge commits |
| Conversation resolution | required before merge |

**You can still push directly**, because `enforce_admins` is off. That is a
deliberate trade for a solo project: requiring yourself to open a pull request
for every change is friction with no reviewer at the other end. To close that
too, once someone else is working on this:

```bash
gh api -X PUT repos/DrewGGM/fuse-web/branches/main/protection/enforce_admins
```

---

## Secrets

Nothing sensitive is in either repository, and it was checked rather than
assumed — tracked files and full history, both repos, for API-key shapes, tokens
and private keys. Clean.

What keeps it that way:

- **Secret scanning and push protection are on.** GitHub blocks a push that
  contains something shaped like a credential, before it lands.
- **`TOKEN_SECRET` is a Cloudflare secret, never a `wrangler.toml` var.** This
  one bit us: it lived in a `[vars]` block for local development, and vars in
  that file *become* the deployed value — the first automated deploy would have
  published the signing key. Local development reads `.dev.vars`, which is
  gitignored and which `wrangler deploy` ignores.
- **The signing keystore is not here.** `.local/` is gitignored in the Android
  repository; the disposable test key inside it is worthless and the real upload
  key must live off the machine entirely.

### What *is* public, and is fine

- The daily seed table and par values. The game is designed around this being
  derivable (ADR-005) — it is what makes offline play work. Someone can compute
  tomorrow's board; there are no prizes.
- `CLOUDFLARE_ACCOUNT_ID` appears in dashboard URLs anyway. It is stored as a
  secret out of habit, not necessity.
- The whole simulation. Knowing the physics is not an advantage: the server
  re-runs your placements and the score either reproduces or it does not.

---

## GitHub Actions

The workflow token is scoped to **read**, and cannot approve pull requests. The
default is write, which means a compromised dependency in a workflow could push
to the repository. Nothing here needs to write, so nothing can.

Actions are pinned by tag rather than by commit SHA (`actions/checkout@v4`).
SHA pinning is stricter — a tag can be moved — and is the next step up if this
ever handles anything more valuable than a puzzle leaderboard.

### Pull requests from forks

A fork's pull request runs `verify` but **cannot deploy**: the deploy job is
gated on `github.ref == 'refs/heads/main'`, and GitHub does not expose secrets
to workflows triggered from forks. A hostile PR can therefore run tests and
nothing else.

---

## What an attacker gets from the source

Worth being clear-eyed, since it is all readable now.

They can see exactly how scoring works, how tokens are signed, and how the
attempt limit is enforced. None of that is a weakness, because none of it
depends on being secret:

- **Forging a score** needs the server to reproduce it, which needs the actual
  placements, which is just playing the game.
- **Forging a token** needs `TOKEN_SECRET`, which is not here.
- **Farming attempts** by minting identities is possible and always was —
  it wins nothing, because there are no prizes and the limit is per player.

The one thing that would genuinely hurt is a **clone on a store**, and that is
what the licence addresses rather than a technical control.

---

## Licence

[PolyForm Noncommercial 1.0.0](../LICENSE.md). Reading, forking, running and
patching are permitted; publishing to an app store or selling it is not.

Google Play prohibits clones by policy, but a policy is something to report a
violation against — a licence is something to enforce.
