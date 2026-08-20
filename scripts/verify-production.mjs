/**
 * Plays a full ranked run against the live site and its live API.
 *
 * Everything before this proved the pieces work. This proves the deployed
 * system works: real DNS, real TLS, real Worker, real D1.
 */
import { chromium } from '@playwright/test';

const SITE = 'https://fuse.andrewgarcia.dev';
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

const puzzle = await page.textContent('#daily-no');
const target = await page.textContent('#meta-par');
console.log(`board        : ${puzzle}, target ${target}`);

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
await page.waitForSelector('#screen-result:not([hidden])', { timeout: 25000 });

console.log(`score        : ${await page.textContent('#result-score')}`);
console.log(`verdict      : ${(await page.textContent('#result-gap')).trim()}`);

// The rank only appears if the run reached the live API and came back.
await page.waitForSelector('#rank-card:not([hidden])', { timeout: 25000 }).catch(() => {});
const rankVisible = await page.evaluate(() => !document.getElementById('rank-card').hidden);
console.log(`rank card    : ${rankVisible ? 'shown' : 'NOT SHOWN'}`);
if (rankVisible) {
  console.log(`rank         : ${await page.textContent('#rank-pos')} ${(await page.textContent('#rank-of')).trim()}`);
}
console.log(`identity     : ${await page.evaluate(() => window.__fuse.store.load().identity?.handle ?? 'none')}`);
console.log(`queue        : ${await page.evaluate(() => window.__fuse.sync.pendingCount())} pending`);
console.log(`page errors  : ${errors.length}`);

// And the leaderboard the server serves back.
await page.click('#btn-full-board');
await page.waitForTimeout(2500);
const rows = await page.locator('.board-row').count();
console.log(`leaderboard  : ${rows} player(s)`);

await browser.close();
