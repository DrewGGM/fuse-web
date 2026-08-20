/**
 * Proves the deployed system works, without appearing on the leaderboard.
 *
 * Everything else proves the pieces work in isolation. This exercises real DNS,
 * real TLS, the real Worker and real D1 — but it must not leave a player behind,
 * because it runs on every deploy and the board it would land on is the one
 * actual players compete on. An earlier version played a genuine ranked run and
 * put two invented names at the top of the live board.
 *
 * The trick is that a *rejected* submission proves just as much. Before the
 * Worker can decide a claimed score is wrong it has to verify the token,
 * validate the payload, check the date, query D1 for the attempt count, derive
 * today's board and re-run the whole simulation. A SCORE_MISMATCH is therefore a
 * receipt for the entire path — and it writes nothing.
 *
 *   node scripts/verify-production.mjs [site] [api]
 */
import { chromium } from '@playwright/test';

const SITE = process.argv[2] ?? 'https://fuse.andrewgarcia.dev';
const API = process.argv[3] ?? 'https://api-fuse.andrewgarcia.dev';
const today = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// The site: does a real browser get a playable game?
// ---------------------------------------------------------------------------

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 393, height: 851 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(SITE, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  const raw = localStorage.getItem('fuse.save.v1');
  const d = raw ? JSON.parse(raw) : {};
  d.tutorialDone = true;
  localStorage.setItem('fuse.save.v1', JSON.stringify(d));
});
await page.reload({ waitUntil: 'networkidle' });

console.log(`site         : ${await page.textContent('#daily-no')}, target ${await page.textContent('#meta-par')}`);

// Play locally only — the run is never launched, so nothing is submitted.
await page.click('#btn-play');
await page.waitForSelector('#screen-game:not([hidden])');
const cell = await page.evaluate(() => {
  const b = window.__fuse.session.board;
  for (let i = 0; i < b.cells.length; i++) {
    const x = i % b.w;
    const y = Math.floor(i / b.w);
    if (b.cells[i] === 0 && !(x === b.originX && y === b.originY)) return { x, y };
  }
  throw new Error('no free cell');
});
const box = await page.locator('#board-canvas').boundingBox();
const dims = await page.evaluate(() => {
  const b = window.__fuse.session.board;
  return { w: b.w, h: b.h };
});
await page.mouse.click(
  box.x + 10 + (cell.x + 0.5) * ((box.width - 20) / dims.w),
  box.y + 10 + (cell.y + 0.5) * ((box.height - 20) / dims.h)
);
const canLaunch = await page.evaluate(() => !document.getElementById('btn-launch').disabled);
console.log(`playable     : ${canLaunch ? 'yes' : 'NO — launch stayed disabled'}`);
console.log(`page errors  : ${errors.length}`);
for (const e of errors) console.log(`  ${e}`);

await browser.close();

// ---------------------------------------------------------------------------
// The API: the whole request path, with nothing written to the board.
// ---------------------------------------------------------------------------

const playerRes = await fetch(`${API}/v1/players`, { method: 'POST' });
const player = await playerRes.json();
console.log(`api player   : ${playerRes.status} ${player.handle ?? '(none)'}`);

const daily = await (await fetch(`${API}/v1/daily/${today}`)).json();
console.log(`api board    : puzzle #${daily.puzzle}, ${daily.inventory?.length ?? 0} pieces`);

const probe = await fetch(`${API}/v1/runs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${player.token}` },
  body: JSON.stringify({
    date: today,
    placements: [{ x: 1, y: 1, piece: 1 }],
    clientScore: 999999,
  }),
});
const body = await probe.json();
const replayVerified = probe.status === 422 && body?.error?.code === 'SCORE_MISMATCH';
console.log(
  `api replay   : ${probe.status} ${body?.error?.code ?? ''} ` +
    (replayVerified ? '(token, validation, D1 and simulation all reached)' : '(UNEXPECTED)')
);

const board = await (await fetch(`${API}/v1/leaderboard/${today}`)).json();
console.log(`leaderboard  : ${board.top.length} player(s) — unchanged by this check`);

const failed = !canLaunch || !replayVerified || errors.length > 0 || playerRes.status !== 201;
console.log(`\n${failed ? 'FAILED' : 'ok'}`);
process.exitCode = failed ? 1 : 0;
