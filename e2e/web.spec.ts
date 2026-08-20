/**
 * What the web build adds over the Android one.
 *
 * The game itself is the same code and is covered by the tests it came with.
 * These cover the parts that only exist here: being installable, working with
 * the network switched off, and the sharing surface a link gets when someone
 * posts their result.
 */
import { expect, test, type Page } from '@playwright/test';

const BOARD_PAD = 10;

async function skipTutorial(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const raw = localStorage.getItem('fuse.save.v1');
    const data = raw ? JSON.parse(raw) : {};
    data.tutorialDone = true;
    localStorage.setItem('fuse.save.v1', JSON.stringify(data));
  });
}

/**
 * Waits until the worker has finished activating, not merely appeared.
 *
 * `registration.active` is set the moment the worker enters *activating*, which
 * is before `activate` has run and therefore before `clients.claim()`. Reloading
 * in that window races the claim: under load the navigation can land first and
 * the new page comes up uncontrolled, which reads as "the service worker never
 * took control" when what really happened is that the test asked too early.
 * Waiting for the `activated` state is the state machine's own answer to "is it
 * ready", and it is what every wait here always meant.
 */
async function waitForActivated(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg?.active?.state === 'activated';
    },
    null,
    // Interval, not the default requestAnimationFrame: a throttled or
    // backgrounded page stops getting frames, and the wait then times out
    // because nothing asked the question, not because the answer was no.
    { timeout: 20_000, polling: 250 }
  );
}

/**
 * Waits until the worker is controlling the page, allowing one more navigation.
 *
 * A reload issued while activation is still settling can come up uncontrolled —
 * rare, load-dependent, and entirely legal: the browser only promises that a
 * navigation *starting after* activation is controlled, and under load the
 * navigation and the tail of activation interleave. Nothing a player would
 * notice, because the next navigation is controlled and `clients.claim()` picks
 * up open pages anyway.
 *
 * So this asserts the guarantee that exists — the worker takes control — rather
 * than one that does not, that it does so in exactly one reload. A second
 * failure is a real one and is left to fail.
 */
async function waitForControlled(page: Page): Promise<void> {
  const controlled = (timeout: number) =>
    page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout, polling: 250 });
  try {
    await controlled(10_000);
  } catch {
    await page.reload();
    await controlled(10_000);
  }
}

/** Plays one run with a single piece, which is always enough to score. */
async function playOneRun(page: Page): Promise<void> {
  await page.locator('#btn-play').click();
  await expect(page.locator('#screen-game')).toBeVisible();

  const cell = await page.evaluate(() => {
    const b = (window as any).__fuse.session.board;
    for (let i = 0; i < b.cells.length; i++) {
      const x = i % b.w;
      const y = Math.floor(i / b.w);
      if (b.cells[i] === 0 && !(x === b.originX && y === b.originY)) return { x, y };
    }
    throw new Error('no free cell');
  });
  const box = await page.locator('#board-canvas').boundingBox();
  const dims = await page.evaluate(() => {
    const b = (window as any).__fuse.session.board;
    return { w: b.w, h: b.h };
  });
  await page.mouse.click(
    box!.x + BOARD_PAD + (cell.x + 0.5) * ((box!.width - BOARD_PAD * 2) / dims.w),
    box!.y + BOARD_PAD + (cell.y + 0.5) * ((box!.height - BOARD_PAD * 2) / dims.h)
  );
  await page.locator('#btn-launch').click();
  await expect(page.locator('#screen-result')).toBeVisible({ timeout: 20_000 });
}

test.describe('progressive web app', () => {
  test('serves a manifest the browser will accept', async ({ page }) => {
    await page.goto('/');
    const href = await page.getAttribute('link[rel="manifest"]', 'href');
    expect(href).toBeTruthy();

    // Fetched through the page so a CSP that forbids it fails here, which is
    // exactly how this was caught: default-src 'none' blocks manifest-src.
    const manifest = await page.evaluate(async (url) => {
      const res = await fetch(url!);
      return { status: res.status, body: await res.json() };
    }, href);

    expect(manifest.status).toBe(200);
    expect(manifest.body.name).toContain('Fuse');
    expect(manifest.body.display).toBe('standalone');
    expect(manifest.body.icons.length).toBeGreaterThan(0);
    expect(manifest.body.start_url).toBeTruthy();
  });

  test('registers a service worker that takes control', async ({ page }) => {
    await page.goto('/');
    await waitForActivated(page);

    // Active is not controlling: the first load predates the worker.
    await page.reload();
    await waitForControlled(page);
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  });

  test('carries the metadata a shared link needs', async ({ page }) => {
    await page.goto('/');
    // The growth plan is people posting their result, so the link has to look
    // like something worth tapping.
    for (const property of ['og:title', 'og:description', 'og:image']) {
      const content = await page.getAttribute(`meta[property="${property}"]`, 'content');
      expect(content, property).toBeTruthy();
    }
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#070B0D');
  });

  test('logs no policy violations', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && /Content.Security|violates|Refused/i.test(m.text())) {
        violations.push(m.text());
      }
    });
    await page.goto('/', { waitUntil: 'networkidle' });
    expect(violations).toEqual([]);
  });
});

test.describe('offline', () => {
  test('plays a full run with the network switched off', async ({ page, context }) => {
    await skipTutorial(page);
    await page.goto('/');
    await waitForActivated(page);
    await page.reload();
    await waitForControlled(page);

    await context.setOffline(true);
    await page.reload();

    // The whole promise of this build: install it, play it on the underground.
    await expect(page.locator('#screen-home')).toBeVisible();
    await expect(page.locator('#daily-no')).toHaveText(/^#\d+$/);

    await playOneRun(page);
    await expect(page.locator('#result-score')).not.toHaveText('0');
    await expect(page.locator('#result-share')).toContainText('Fuse #');

    // The run is kept, not lost, and the player is told.
    await expect(page.locator('#sync-note')).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate(() => (window as any).__fuse.sync.pendingCount())).toBe(1);

    await context.setOffline(false);
  });

  test('a queued run survives a reload while still offline', async ({ page, context }) => {
    await skipTutorial(page);
    await page.goto('/');
    await waitForActivated(page);
    await page.reload();
    await waitForControlled(page);

    await context.setOffline(true);
    await page.reload();
    await playOneRun(page);
    await expect(page.locator('#sync-note')).toBeVisible({ timeout: 15_000 });

    await page.reload();
    // The app has to boot before its state can be read: evaluating straight
    // after reload races module initialisation and reads undefined.
    await expect(page.locator('#screen-home')).toBeVisible();
    await page.waitForFunction(() => !!(window as any).__fuse?.sync);
    expect(await page.evaluate(() => (window as any).__fuse.sync.pendingCount())).toBe(1);

    await context.setOffline(false);
  });
});

test.describe('sound', () => {
  test('the policy lets the cues through and the worker keeps them', async ({ page, context }) => {
    const refused: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) refused.push(m.text());
    });

    await skipTutorial(page);
    await page.goto('/');
    await waitForActivated(page);

    // The CSP has to allow the cues and the precache has to have taken them.
    // Both are easy to get wrong in a way nothing else notices: a blocked or
    // missing file is not an error here, it is a game that plays its fallback
    // tones and sounds like it did before any of this.
    expect(refused).toEqual([]);

    // Active is not controlling. The first load happens before the worker
    // exists, so going offline here without the reload below means the next
    // navigation goes straight to a network that is no longer there.
    await page.reload();
    await waitForControlled(page);

    await context.setOffline(true);
    await page.reload();
    const cached = await page.evaluate(async () => {
      const cues = ['select', 'place', 'pickup', 'invalid', 'launch', 'ignite', 'bomb', 'result'];
      const found: string[] = [];
      for (const c of cues) {
        const res = await fetch(`./sfx/${c}.m4a`).catch(() => null);
        if (res?.ok && (await res.arrayBuffer()).byteLength > 1000) found.push(c);
      }
      return found;
    });
    expect(cached).toHaveLength(8);

    await context.setOffline(false);
  });
});

test.describe('the game itself', () => {
  test('is the same game: derives the daily board and scores locally', async ({ page }) => {
    await skipTutorial(page);
    await page.goto('/');

    const { puzzle, target, record } = await page.evaluate(() => {
      const f = (window as any).__fuse;
      const date = f.utcDate();
      return {
        puzzle: f.dailyBoard(date).inventory.length,
        target: f.dailyTarget(date),
        record: f.dailyPar(date),
      };
    });
    expect(puzzle).toBe(5);
    expect(target).toBeGreaterThan(0);
    expect(record).toBeGreaterThanOrEqual(target);

    await playOneRun(page);
    await expect(page.locator('#result-detail')).toContainText('nodos encendidos');
  });

  test('shows the tutorial to a first-time visitor', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#screen-tutorial')).toBeVisible();
    await expect(page.locator('#tut-step')).toHaveText('1 / 5');
  });
});
