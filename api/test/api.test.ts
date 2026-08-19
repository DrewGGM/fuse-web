/**
 * Worker integration tests.
 *
 * These run the real handler against a real SQLite database with the real
 * migrations applied. The only thing stubbed is the clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVENTORY_SIZE, Piece, run as runSim } from '../../core/sim/index.js';
import { dailyBoard, utcDate } from '../../core/gen/index.js';
import { CURATION_BUDGET, solve } from '../../core/gen/index.js';
import worker, { isSubmittableToday, type Env } from '../src/index.js';
import { issueToken, verifyToken } from '../src/auth.js';
import { parseDateParam } from '../src/contract.js';
import { createTestDb, type TestDb } from './d1-sqlite.js';

const SECRET = 'test-secret-not-a-real-one';
const TODAY = utcDate();

let db: TestDb;
let env: Env;

beforeEach(() => {
  db = createTestDb();
  env = { DB: db as unknown as Env['DB'], TOKEN_SECRET: SECRET };
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {}
): Promise<{ status: number; body: any }> {
  const headers = new Headers();
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  if (opts.token) headers.set('authorization', `Bearer ${opts.token}`);

  const res = await worker.fetch(
    new Request(`https://api.test${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    env
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function newPlayer(): Promise<{ id: string; token: string; handle: string }> {
  const res = await call('POST', '/v1/players');
  expect(res.status).toBe(201);
  return res.body;
}

/** A legal, decent-scoring set of placements for a date. */
function goodRun(date: string): { placements: any[]; score: number } {
  const board = dailyBoard(date);
  const best = solve(board, CURATION_BUDGET).best;
  return { placements: best, score: runSim(board, best).score };
}

// ---------------------------------------------------------------------------

describe('tokens', () => {
  it('round-trips a player id', async () => {
    const token = await issueToken('player-1', SECRET);
    expect(await verifyToken(token, SECRET)).toBe('player-1');
  });

  it('rejects a token signed with another secret', async () => {
    const token = await issueToken('player-1', SECRET);
    expect(await verifyToken(token, 'different-secret')).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const token = await issueToken('player-1', SECRET);
    const [payload, sig] = token.split('.');
    const forged = `${btoa('player-2.99999999999999').replace(/=+$/, '')}.${sig}`;
    expect(await verifyToken(forged, SECRET)).toBeNull();
    expect(payload).toBeTruthy();
  });

  it('rejects an expired token', async () => {
    const token = await issueToken('player-1', SECRET, Date.now() - 40 * 24 * 3600_000);
    expect(await verifyToken(token, SECRET)).toBeNull();
  });

  it('rejects garbage without throwing', async () => {
    for (const junk of ['', '.', 'nope', 'a.b.c', '!!!.???']) {
      expect(await verifyToken(junk, SECRET), junk).toBeNull();
    }
  });
});

describe('parseDateParam', () => {
  it('accepts real dates and rejects impossible ones', () => {
    expect(parseDateParam('2026-08-17')).toBe('2026-08-17');
    expect(parseDateParam('2026-02-31')).toBeNull();
    expect(parseDateParam('2026-13-01')).toBeNull();
    expect(parseDateParam('17-08-2026')).toBeNull();
    expect(parseDateParam("2026-08-17'; DROP TABLE run;--")).toBeNull();
  });
});

describe('POST /v1/players', () => {
  it('creates an anonymous player with a usable token', async () => {
    const player = await newPlayer();
    expect(player.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(player.handle).toBeTruthy();
    expect(await verifyToken(player.token, SECRET)).toBe(player.id);
  });

  it('stores no personal data', async () => {
    const player = await newPlayer();
    const row = await db.prepare('SELECT * FROM player WHERE id = ?').bind(player.id).first();
    expect(Object.keys(row!).sort()).toEqual(['created_at', 'handle', 'id']);
  });
});

describe('GET /v1/daily/:date', () => {
  it('returns the same board the client would derive', async () => {
    const res = await call('GET', `/v1/daily/${TODAY}`);
    expect(res.status).toBe(200);
    const local = dailyBoard(TODAY);
    expect(res.body.cells).toEqual(Array.from(local.cells));
    expect(res.body.inventory).toEqual(Array.from(local.inventory));
    expect(res.body.origin).toEqual({ x: local.originX, y: local.originY, dir: local.originDir });
  });

  it('rejects a malformed date', async () => {
    const res = await call('GET', '/v1/daily/not-a-date');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_DATE');
  });
});

describe('POST /v1/runs', () => {
  it('accepts a run whose score reproduces', async () => {
    const player = await newPlayer();
    const { placements, score } = goodRun(TODAY);

    const res = await call('POST', '/v1/runs', {
      token: player.token,
      body: { date: TODAY, placements, clientScore: score },
    });

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(res.body.score).toBe(score);
    expect(res.body.rank).toBe(1);
    expect(res.body.attemptsLeft).toBe(2);
  });

  it('rejects a score the replay does not produce', async () => {
    const player = await newPlayer();
    const { placements, score } = goodRun(TODAY);

    const res = await call('POST', '/v1/runs', {
      token: player.token,
      body: { date: TODAY, placements, clientScore: score + 10_000 },
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SCORE_MISMATCH');
  });

  it('rejects placements that are not legal for the board', async () => {
    const player = await newPlayer();
    const board = dailyBoard(TODAY);
    // Five mirrors stacked on one cell: right shape, illegal content.
    const placements = Array.from({ length: INVENTORY_SIZE }, () => ({
      x: 0,
      y: 0,
      piece: Piece.MirrorA,
    }));

    const res = await call('POST', '/v1/runs', {
      token: player.token,
      body: { date: TODAY, placements, clientScore: 0 },
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ILLEGAL_PLACEMENTS');
    expect(board).toBeTruthy();
  });

  it('rejects a submission with no token', async () => {
    const { placements, score } = goodRun(TODAY);
    const res = await call('POST', '/v1/runs', {
      body: { date: TODAY, placements, clientScore: score },
    });
    expect(res.status).toBe(401);
  });

  it('accepts a run that uses fewer pieces than the inventory', async () => {
    const player = await newPlayer();
    const board = dailyBoard(TODAY);
    const partial = solve(board, CURATION_BUDGET).best.slice(0, 1);
    const score = runSim(board, partial).score;

    const res = await call('POST', '/v1/runs', {
      token: player.token,
      body: { date: TODAY, placements: partial, clientScore: score },
    });
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(score);
  });

  it('rejects a body that fails the schema', async () => {
    const player = await newPlayer();
    for (const body of [
      { date: TODAY, placements: [], clientScore: 0 },
      { date: TODAY, placements: Array.from({ length: 6 }, () => ({ x: 0, y: 0, piece: 1 })), clientScore: 0 },
      { date: 'yesterday', placements: [], clientScore: 0 },
      { date: TODAY, placements: [{ x: -1, y: 0, piece: 1 }], clientScore: 0 },
      { date: TODAY, placements: goodRun(TODAY).placements, clientScore: -5 },
    ]) {
      const res = await call('POST', '/v1/runs', { token: player.token, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('enforces three ranked attempts per day', async () => {
    const player = await newPlayer();
    const { placements, score } = goodRun(TODAY);

    for (let i = 0; i < 3; i++) {
      const res = await call('POST', '/v1/runs', {
        token: player.token,
        body: { date: TODAY, placements, clientScore: score },
      });
      expect(res.status, `attempt ${i + 1}`).toBe(200);
      expect(res.body.attemptsLeft).toBe(2 - i);
    }

    const fourth = await call('POST', '/v1/runs', {
      token: player.token,
      body: { date: TODAY, placements, clientScore: score },
    });
    expect(fourth.status).toBe(409);
    expect(fourth.body.error.code).toBe('ATTEMPTS_EXHAUSTED');
  });

  it('refuses a run submitted for another day', async () => {
    const player = await newPlayer();
    const other = '2026-01-05';
    const { placements, score } = goodRun(other);

    const res = await call('POST', '/v1/runs', {
      token: player.token,
      body: { date: other, placements, clientScore: score },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DATE_NOT_TODAY');
  });

  it('counts attempts per player, not globally', async () => {
    const a = await newPlayer();
    const b = await newPlayer();
    const { placements, score } = goodRun(TODAY);

    for (let i = 0; i < 3; i++) {
      await call('POST', '/v1/runs', {
        token: a.token,
        body: { date: TODAY, placements, clientScore: score },
      });
    }
    const res = await call('POST', '/v1/runs', {
      token: b.token,
      body: { date: TODAY, placements, clientScore: score },
    });
    expect(res.status).toBe(200);
  });
});

describe('isSubmittableToday', () => {
  it('accepts today', () => {
    const now = Date.parse('2026-08-17T12:00:00Z');
    expect(isSubmittableToday('2026-08-17', now)).toBe(true);
  });

  it('accepts yesterday inside the grace window just after midnight', () => {
    const now = Date.parse('2026-08-18T00:03:00Z');
    expect(isSubmittableToday('2026-08-17', now)).toBe(true);
  });

  it('rejects yesterday once the grace window has passed', () => {
    const now = Date.parse('2026-08-18T00:30:00Z');
    expect(isSubmittableToday('2026-08-17', now)).toBe(false);
  });

  it('rejects tomorrow', () => {
    const now = Date.parse('2026-08-17T12:00:00Z');
    expect(isSubmittableToday('2026-08-18', now)).toBe(false);
  });
});

describe('GET /v1/leaderboard/:date', () => {
  it('ranks players by their best score', async () => {
    const board = dailyBoard(TODAY);
    const strong = solve(board, CURATION_BUDGET).best;
    const strongScore = runSim(board, strong).score;

    const a = await newPlayer();
    await call('POST', '/v1/runs', {
      token: a.token,
      body: { date: TODAY, placements: strong, clientScore: strongScore },
    });

    const b = await newPlayer();
    const weak = weakRun(TODAY);
    await call('POST', '/v1/runs', {
      token: b.token,
      body: { date: TODAY, placements: weak.placements, clientScore: weak.score },
    });

    const res = await call('GET', `/v1/leaderboard/${TODAY}`);
    expect(res.status).toBe(200);
    expect(res.body.top).toHaveLength(2);
    expect(res.body.top[0].score).toBeGreaterThanOrEqual(res.body.top[1].score);
    expect(res.body.top[0].rank).toBe(1);
  });

  it('shows one entry per player, not one per attempt', async () => {
    const player = await newPlayer();
    const { placements, score } = goodRun(TODAY);
    for (let i = 0; i < 3; i++) {
      await call('POST', '/v1/runs', {
        token: player.token,
        body: { date: TODAY, placements, clientScore: score },
      });
    }
    const res = await call('GET', `/v1/leaderboard/${TODAY}`);
    expect(res.body.top).toHaveLength(1);
  });

  it('gives tied players the same position, matching what submit reported', async () => {
    // The submit endpoint counts how many players are strictly above you, so
    // ties share a rank. A board that numbered rows 1,2,3 contradicted it.
    const board = dailyBoard(TODAY);
    const best = solve(board, CURATION_BUDGET).best;
    const score = runSim(board, best).score;

    const ranks: number[] = [];
    for (let i = 0; i < 3; i++) {
      const player = await newPlayer();
      const res = await call('POST', '/v1/runs', {
        token: player.token,
        body: { date: TODAY, placements: best, clientScore: score },
      });
      ranks.push(res.body.rank);
    }
    expect(ranks).toEqual([1, 1, 1]);

    const board_ = await call('GET', `/v1/leaderboard/${TODAY}`);
    expect(board_.body.top.map((e: any) => e.rank)).toEqual([1, 1, 1]);
  });

  it('skips positions after a tie', async () => {
    const strongPlayer = await newPlayer();
    const board = dailyBoard(TODAY);
    const best = solve(board, CURATION_BUDGET).best;
    const high = runSim(board, best).score;

    for (let i = 0; i < 2; i++) {
      const p = i === 0 ? strongPlayer : await newPlayer();
      await call('POST', '/v1/runs', {
        token: p.token,
        body: { date: TODAY, placements: best, clientScore: high },
      });
    }

    const weakPlayer = await newPlayer();
    const weak = weakRun(TODAY);
    await call('POST', '/v1/runs', {
      token: weakPlayer.token,
      body: { date: TODAY, placements: weak.placements, clientScore: weak.score },
    });

    const res = await call('GET', `/v1/leaderboard/${TODAY}`);
    const ranks = res.body.top.map((e: any) => e.rank);
    // Two tied at the top, so the third player is third — not second.
    expect(ranks).toEqual([1, 1, 3]);
  });

  it('is empty for a day nobody played', async () => {
    const res = await call('GET', '/v1/leaderboard/2026-03-03');
    expect(res.status).toBe(200);
    expect(res.body.top).toEqual([]);
  });
});

describe('GET /v1/replays/:date/top', () => {
  it('refuses to reveal the answer while the day is still open', async () => {
    const res = await call('GET', `/v1/replays/${TODAY}/top`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DAY_STILL_OPEN');
  });

  it('returns the winning run once the day has closed', async () => {
    // Submit for today, then move the clock forward so today is in the past.
    const player = await newPlayer();
    const { placements, score } = goodRun(TODAY);
    await call('POST', '/v1/runs', {
      token: player.token,
      body: { date: TODAY, placements, clientScore: score },
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(`${TODAY}T00:00:00Z`) + 2 * 86400000));

    const res = await call('GET', `/v1/replays/${TODAY}/top`);
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(score);
    expect(res.body.placements.length).toBeGreaterThanOrEqual(1);
    expect(res.body.placements.length).toBeLessThanOrEqual(INVENTORY_SIZE);
    // The replay must reproduce the score it claims.
    expect(runSim(dailyBoard(TODAY), res.body.placements).score).toBe(score);
  });

  it('reports honestly when nobody played that day', async () => {
    const res = await call('GET', '/v1/replays/2026-02-02/top');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NO_RUNS');
  });
});

describe('routing', () => {
  it('404s an unknown path with the standard envelope', async () => {
    const res = await call('GET', '/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('answers CORS preflight', async () => {
    const res = await worker.fetch(new Request('https://api.test/v1/runs', { method: 'OPTIONS' }), env);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

/** A legal but poor placement set, for ranking tests. */
function weakRun(date: string): { placements: any[]; score: number } {
  const board = dailyBoard(date);
  const originIndex = board.originY * board.w + board.originX;
  const cells: number[] = [];
  for (let i = board.cells.length - 1; i >= 0 && cells.length < INVENTORY_SIZE; i--) {
    if (board.cells[i] === 0 && i !== originIndex) cells.push(i);
  }
  const placements = cells.map((at, i) => ({
    x: at % board.w,
    y: Math.floor(at / board.w),
    piece: board.inventory[i],
  }));
  return { placements, score: runSim(board, placements).score };
}
