/**
 * The outbound queue.
 *
 * This is the only place in the client where a player's work can be lost, so
 * the tests are written from that angle: a run must survive a dead network, a
 * reload, a server that says no, and a server that says no forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Piece, type Placement } from '../core/sim/index.js';
import * as sync from '../src/sync.js';
import * as store from '../src/storage.js';

const IDENTITY = { id: 'p1', handle: 'Chispa100', token: 'tok' };
const PLACEMENTS: Placement[] = [{ x: 1, y: 2, piece: Piece.MirrorA }];

/** A localStorage good enough to be the real thing for these tests. */
function installStorage(): void {
  let data: Record<string, string> = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
    removeItem: (k: string) => {
      delete data[k];
    },
    clear: () => {
      data = {};
    },
  });
}

function mockFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (url: any, init: any) => responder(String(url), init));
  vi.stubGlobal('fetch', spy);
  return spy;
}

const accepted = (over: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      accepted: true,
      score: 1000,
      ignited: 3,
      totalNodes: 10,
      rank: 4,
      players: 20,
      percentile: 85,
      attemptsLeft: 2,
      ...over,
    }),
    { status: 200 }
  );

beforeEach(() => {
  installStorage();
  store.__resetCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('enqueue', () => {
  it('writes the run to storage before anything touches the network', () => {
    const fetchSpy = mockFetch(() => accepted());
    sync.enqueue('2026-08-19', PLACEMENTS, 1000);

    expect(sync.pendingCount()).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('survives a reload', () => {
    sync.enqueue('2026-08-19', PLACEMENTS, 1000);
    // A reload drops every module's memory but not localStorage.
    store.__resetCacheForTests();
    expect(sync.pendingCount()).toBe(1);
    expect(store.load().pendingRuns[0].score).toBe(1000);
  });

  it('keeps runs in the order they were played', () => {
    sync.enqueue('2026-08-19', PLACEMENTS, 100);
    sync.enqueue('2026-08-19', PLACEMENTS, 200);
    sync.enqueue('2026-08-19', PLACEMENTS, 300);
    expect(store.load().pendingRuns.map((r) => r.score)).toEqual([100, 200, 300]);
  });
});

describe('flushing', () => {
  it('sends the oldest run first and drops it once accepted', async () => {
    const seen: string[] = [];
    mockFetch((_url, init) => {
      seen.push(JSON.parse(String(init?.body)).clientScore);
      return accepted();
    });

    sync.enqueue('2026-08-19', PLACEMENTS, 100);
    sync.enqueue('2026-08-19', PLACEMENTS, 200);

    const first = await sync.flushOne(IDENTITY);
    expect(first.status).toBe('sent');
    expect(seen).toEqual([100]);
    expect(sync.pendingCount()).toBe(1);
  });

  it('keeps the run queued when the network is down', async () => {
    mockFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    sync.enqueue('2026-08-19', PLACEMENTS, 1000);

    const outcome = await sync.flushOne(IDENTITY);
    expect(outcome.status).toBe('offline');
    // The player's run must still be there when they surface.
    expect(sync.pendingCount()).toBe(1);
    expect(store.load().pendingRuns[0].attempts).toBe(1);
  });

  it('keeps the run queued when the server is broken', async () => {
    mockFetch(() => new Response('upstream exploded', { status: 502 }));
    sync.enqueue('2026-08-19', PLACEMENTS, 1000);

    expect((await sync.flushOne(IDENTITY)).status).toBe('offline');
    expect(sync.pendingCount()).toBe(1);
  });

  it('drops a run the server refuses, instead of retrying forever', async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: { code: 'ATTEMPTS_EXHAUSTED', message: 'no' } }), {
          status: 409,
        })
    );
    sync.enqueue('2026-08-19', PLACEMENTS, 1000);

    const outcome = await sync.flushOne(IDENTITY);
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.code).toBe('ATTEMPTS_EXHAUSTED');
    expect(sync.pendingCount()).toBe(0);
  });

  it('gives up on a run that has failed too many times', async () => {
    mockFetch(() => {
      throw new TypeError('offline');
    });
    sync.enqueue('2026-08-19', PLACEMENTS, 1000);

    // An unbounded queue that never drains is its own bug.
    for (let i = 0; i < 10; i++) await sync.flushOne(IDENTITY);
    expect(sync.pendingCount()).toBe(0);
  });

  it('does nothing without an identity, rather than losing the run', async () => {
    const fetchSpy = mockFetch(() => accepted());
    sync.enqueue('2026-08-19', PLACEMENTS, 1000);

    expect((await sync.flushOne(null)).status).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sync.pendingCount()).toBe(1);
  });

  it('drains the whole queue when the network is healthy', async () => {
    mockFetch(() => accepted());
    for (let i = 0; i < 3; i++) sync.enqueue('2026-08-19', PLACEMENTS, 100 * (i + 1));

    const outcome = await sync.flushAll(IDENTITY);
    expect(outcome.status).toBe('sent');
    expect(sync.pendingCount()).toBe(0);
  });

  it('stops draining at the first sign of no network', async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      throw new TypeError('offline');
    });
    for (let i = 0; i < 5; i++) sync.enqueue('2026-08-19', PLACEMENTS, 100);

    await sync.flushAll(IDENTITY);
    // One failure is enough to know; hammering a dead network wastes battery.
    expect(calls).toBe(1);
  });

  it('does not send the same run twice when flushed concurrently', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    mockFetch(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return accepted();
    });

    sync.enqueue('2026-08-19', PLACEMENTS, 1000);
    await Promise.all([sync.flushOne(IDENTITY), sync.flushOne(IDENTITY), sync.flushOne(IDENTITY)]);

    expect(maxConcurrent).toBe(1);
    expect(sync.pendingCount()).toBe(0);
  });
});

describe('identity', () => {
  it('creates one on first contact and reuses it after', async () => {
    const fetchSpy = mockFetch(
      () => new Response(JSON.stringify(IDENTITY), { status: 201 })
    );

    const first = await sync.ensureIdentity();
    expect(first).toEqual(IDENTITY);
    expect(store.load().identity).toEqual(IDENTITY);

    const second = await sync.ensureIdentity();
    expect(second).toEqual(IDENTITY);
    // The second call must not have gone to the network.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null offline so the game carries on without a leaderboard', async () => {
    mockFetch(() => {
      throw new TypeError('offline');
    });
    expect(await sync.ensureIdentity()).toBeNull();
    expect(store.load().identity).toBeNull();
  });
});
