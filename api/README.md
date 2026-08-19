# The API

A Cloudflare Worker with one real job: **decide whether a submitted score is
real.**

Everything else the game does happens on the device. The board is derived from
the date, the run is simulated locally, the score is computed locally, and the
result is stored locally. Turn the network off and you still get the whole
single-player game. The server exists so that a score can be *compared with
other people's* — and a comparison is worthless if anyone can type in a number.

---

## Why it cannot just trust the client

The obvious design is: the phone says "I scored 7200", the server writes 7200.
That survives about a week. Anyone can open the developer tools, or decompile
the app, or send the request by hand:

```bash
curl -X POST https://api.example/v1/runs \
  -d '{"date":"2026-08-19","placements":[...],"clientScore":999999}'
```

The usual defence is heuristics — reject scores that look impossible, flag
players who improve too fast. That approach has a fatal property: its false
positives land on your best players, the ones who found the clever line, who are
exactly the people a leaderboard exists to reward.

## What it does instead

A run is completely described by up to five placements and a date. The board for
that date is derivable. So the server **replays the run**:

```
1. Derive the board for that date          (same generator as the client)
2. Re-execute the player's placements      (same simulation as the client)
3. Compare the result with what was claimed
4. Equal? store it. Different? reject it.
```

There is no threshold and no judgement call. Either the number reproduces
exactly or it does not.

This is only possible because the simulation is **deterministic** — integer
arithmetic, fixed timestep, no `Math.random`, no floating point, no reliance on
iteration order. That constraint is why `core/` exists and why a test hashes
2,000 complete runs to prove the copies have not drifted. If the client and the
server ever disagree by one tick, every honest player starts getting rejected.

---

## Everything it stores

Two tables. That is the whole schema.

```sql
player (id, handle, created_at)
run    (id, player_id, date, score, placements, attempt_no, submitted_at)
```

`handle` is generated — `Chispa384`, `Fusible211`. There is no email, no
password, no name, no advertising id, no analytics. A player is a UUID the
device made up and a token signed with an HMAC, which exists only so the
three-attempts-a-day rule has something to count against.

That is a deliberate design (see ADR-004 in the Android repository): with no
personal data, most of a security checklist becomes not-applicable rather than
carefully-handled, and there is nothing worth stealing.

---

## Endpoints

| | |
|---|---|
| `POST /v1/players` | Mint an anonymous identity. Called once per device. |
| `GET /v1/daily/:date` | The board for a date. The client derives this itself; this exists so a bot or a future web leaderboard need not bundle the generator. |
| `POST /v1/runs` | Submit a run. **This is the one that matters.** Replays it and accepts or rejects. |
| `GET /v1/leaderboard/:date` | Top 100, with tied players sharing a position. |
| `GET /v1/replays/:date/top` | The winning run — but only once the day has closed, or it would hand everyone the answer. |

Errors are always a proper status code with one envelope, never a `200` with a
problem inside:

```json
{ "error": { "code": "SCORE_MISMATCH", "message": "..." } }
```

`ATTEMPTS_EXHAUSTED`, `DATE_NOT_TODAY` and `SCORE_MISMATCH` are the three the
client reacts to specifically, because each means something different to a
player.

---

## What bounds it

- **Three ranked attempts per player per day**, counted on the player row rather
  than the token, so minting a new token does not reset it. A unique index on
  `(player, date, attempt_no)` is the backstop under concurrency.
- **A hard cap on simulation steps and sparks**, which bounds how much CPU one
  crafted submission can consume.
- **Zod validation at the boundary**, so an oversized or malformed payload is
  rejected before any work happens.
- Submissions are only accepted **for the current UTC day**, with five minutes
  of grace for a run that started just before midnight.

`test/security.test.ts` is written as attacks rather than features: forged
scores, pieces the inventory never dealt, stacked placements, replayed boards
from other days, forged and expired tokens, SQL injection through two paths,
prototype pollution, a 5,000-element payload, and ten concurrent submissions
racing the attempt limit. Each passing test means an attack failed.

---

## This is not the Android API

The two products keep **separate leaderboards**. This Worker (`fuse-web-api`,
database `fuse-web-db`) serves the web build; the Android app has its own in the
[fuse-game](https://github.com/DrewGGM/fuse-game) repository.

The code is identical and vendored from the same `core/`, so a run scores the
same on both. Only the deployment, the database, and therefore the community are
distinct.

To merge them later, point both clients at one Worker and delete the other.
Nothing in the code assumes which.

---

## Running it

```bash
npm run api:migrate:local     # create the local D1 schema
npm run api:dev               # http://localhost:8787

# build the site against it
FUSE_API_BASE=http://localhost:8787 npm run build && npm run preview
```

First deployment:

```bash
cd api
npx wrangler d1 create fuse-web-db      # paste the id into wrangler.toml
npx wrangler d1 migrations apply fuse-web-db --remote
npx wrangler secret put TOKEN_SECRET    # openssl rand -base64 32
npx wrangler deploy
```

After that, pushes to `main` deploy it automatically.

**`TOKEN_SECRET` must be a secret, never a `[vars]` entry.** A var in
`wrangler.toml` becomes the deployed value, so putting it there would publish
the signing key to a public repository.
