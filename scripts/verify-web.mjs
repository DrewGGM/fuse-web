/**
 * Loads the built site in a clean browser and reports what a real user's browser
 * would say about it.
 *
 * The developer machine has an antivirus that rewrites CSP meta tags in every
 * page it sees, inventing violations that have nothing to do with the app. A
 * Playwright-launched Chromium has no extensions, so this is the only place the
 * policy can honestly be judged.
 */
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://localhost:8788/';
const browser = await chromium.launch();
const page = await browser.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(url, { waitUntil: 'networkidle' });

const report = await page.evaluate(async () => {
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  await document.fonts.ready;
  const link = document.querySelector('link[rel="manifest"]');
  let manifest = null;
  try {
    manifest = await (await fetch(link.href)).json();
  } catch (e) {
    manifest = { error: String(e) };
  }
  const canvas = document.getElementById('tut-canvas') || document.getElementById('preview-canvas');
  let painted = 0;
  if (canvas) {
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 30 || d[i + 1] > 30 || d[i + 2] > 30) painted++;
  }
  return {
    policyRewritten: (meta?.getAttribute('content') ?? '').includes('kaspersky'),
    manifestName: manifest?.name ?? manifest?.error,
    manifestIcons: manifest?.icons?.length ?? 0,
    fontReady: document.fonts.check('16px "Chakra Petch"'),
    canvasPainted: painted,
    swSupported: 'serviceWorker' in navigator,
  };
});

// The service worker registers on load; give it a moment to take control.
await page.waitForTimeout(1500);
const swState = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? { scope: reg.scope, active: !!reg.active } : null;
});

const cspErrors = errors.filter((e) => /Content.Security|Refused|violates/i.test(e));
const other = errors.filter((e) => !/Content.Security|Refused|violates|favicon/i.test(e));

console.log(`policy intact   : ${report.policyRewritten ? 'NO — rewritten by an extension' : 'yes'}`);
console.log(`csp violations  : ${cspErrors.length}`);
console.log(`other errors    : ${other.length}`);
console.log(`manifest        : ${report.manifestName} (${report.manifestIcons} icons)`);
console.log(`font loaded     : ${report.fontReady}`);
console.log(`canvas painted  : ${report.canvasPainted} px`);
console.log(`service worker  : ${swState ? `active=${swState.active}` : 'not registered'}`);

if (cspErrors.length || other.length) {
  console.log('\nerrors:');
  for (const e of [...cspErrors, ...other]) console.log(`  ${e}`);
}

await browser.close();
process.exitCode = cspErrors.length + other.length > 0 ? 1 : 0;
