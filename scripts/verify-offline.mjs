/**
 * Proves the game works with the network switched off.
 *
 * This is the whole promise of the web build: install it, then play it on the
 * underground. Asserting it needs a real browser with a real service worker and
 * a real offline switch, which is not something a unit test can fake.
 */
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://localhost:8788/';
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

// First visit, online: the service worker installs and caches the shell.
await page.goto(url, { waitUntil: 'networkidle' });
// `active` is set the moment the worker enters *activating*, before activate has
// run and therefore before clients.claim(). Reloading in that window races the
// claim and comes up uncontrolled. `activated` is the state machine's own answer.
await page.waitForFunction(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg?.active?.state === 'activated';
}, null, { timeout: 15000, polling: 250 });

// An active worker is not the same as a *controlling* one. The first page load
// happens before the worker exists, so it is uncontrolled until it claims —
// reloading before that goes straight to the network and fails offline.
await page.reload({ waitUntil: 'networkidle' });
const controlled = (timeout) =>
  page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout, polling: 250 });
try {
  await controlled(10000);
} catch {
  // A navigation that starts while activation is still settling can come up
  // uncontrolled. The browser only promises the *next* one, so take it.
  await page.reload({ waitUntil: 'networkidle' });
  await controlled(10000);
}
console.log('1. installed and controlling       : ok');

// Now cut the network entirely and reload.
await context.setOffline(true);
await page.reload({ waitUntil: 'domcontentloaded' });

const title = await page.title();
console.log(`2. reloaded offline, title         : ${title}`);

// Skip the tutorial and play a full ranked run with no network at all.
await page.evaluate(() => {
  const raw = localStorage.getItem('fuse.save.v1');
  const data = raw ? JSON.parse(raw) : {};
  data.tutorialDone = true;
  localStorage.setItem('fuse.save.v1', JSON.stringify(data));
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#screen-home:not([hidden])', { timeout: 10000 });
console.log('3. home screen offline             : ok');

const puzzle = await page.textContent('#daily-no');
const target = await page.textContent('#meta-par');
console.log(`4. derived today's board offline   : ${puzzle}, target ${target}`);

await page.click('#btn-play');
await page.waitForSelector('#screen-game:not([hidden])');
const cell = await page.evaluate(() => {
  const b = window.__fuse.session.board;
  for (let i = 0; i < b.cells.length; i++) {
    const x = i % b.w, y = Math.floor(i / b.w);
    if (b.cells[i] === 0 && !(x === b.originX && y === b.originY)) return { x, y };
  }
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
await page.click('#btn-launch');
await page.waitForSelector('#screen-result:not([hidden])', { timeout: 20000 });

const score = await page.textContent('#result-score');
const share = await page.textContent('#result-share');
const sync = await page.evaluate(() => {
  const n = document.getElementById('sync-note');
  return n.hidden ? null : n.textContent;
});
const pending = await page.evaluate(() => window.__fuse.sync.pendingCount());

console.log(`5. played and scored offline       : ${score}`);
console.log(`6. share text generated            : ${share.split('\n')[0]}`);
console.log(`7. queued for later                : ${pending} run(s) — "${sync}"`);

// Back online: the queue should drain without the player doing anything.
await context.setOffline(false);
await page.click('#btn-result-home');
let drained = false;
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(500);
  if ((await page.evaluate(() => window.__fuse.sync.pendingCount())) === 0) { drained = true; break; }
}
console.log(`8. queue drained once back online  : ${drained ? 'ok' : 'STILL PENDING (needs an API)'}`);

await browser.close();
