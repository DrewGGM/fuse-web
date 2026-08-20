/**
 * Adversarial tests against the Worker.
 *
 * Written as attacks rather than features: each test tries to get something it
 * should not have — a forged score, someone else's attempt budget, a rejected
 * row into the database, an unbounded amount of server CPU. A passing test here
 * means the attack failed.
 *
 * Nothing is deployed yet, so this is the closest thing to a penetration test
 * that can honestly be run: the real handler, the real schema, real SQLite.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { INVENTORY_SIZE, Piece, run as runSim } from '../../core/sim/index.js';
import { CURATION_BUDGET, dailyBoard, solve, utcDate } from '../../core/gen/index.js';
import worker, { type Env } from '../src/index.js';
import { issueToken } from '../src/auth.js';
import { createTestDb, type TestDb } from './d1-sqlite.js';

const SECRET = 'test-secret-not-a-real-one';
const TODAY = utcDate();

let db: TestDb;
let env: Env;

beforeEach(() => {
  db = createTestDb();
  env = { DB: db as unknown as Env['DB'], TOKEN_SECRET: SECRET };
});

afterEach(() => db.close());

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; rawBody?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: any; text: string }> {
  const headers = new Headers(opts.headers ?? {});
  if (opts.body !== undefined || opts.rawBody !== undefined) {
    headers.set('content-type', 'application/json');
  }
  if (opts.token) headers.set('authorization', `Bearer ${opts.token}`);

  const res = await worker.fetch(
    new Request(`https://api.test${path}`, {
      method,
      headers,
      body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    }),
    env
  );
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

async function newPlayer(): Promise<{ id: string; token: string }> {
  return (await call('POST', '/v1/players')).body;
}

function bestRun(date: string): { placements: any[]; score: number } {
  const board = dailyBoard(date);
  const best = solve(board, CURATION_BUDGET).best;
  return { placements: best, score: runSim(board, best).score };
}

async function rowCount(table: 'run' | 'player'): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------

describe('score forgery', () => {
  it('cannot claim a score the placements do not produce', async () => {
    const player = await newPlayer();
    const { placements } = bestRun(TODAY);

    for (const claimed of [999_999, 1, 0, 123_456]) {
      const res = await call('POST', '/v1/runs', {
        token: player.token,
        body: { date: TODAY, placements, clientScore: claimed },
      });
      expect(res.status, `claimed ${claimed}`).toBe(422);
      expect(res.body.error.code).toBe('SCORE_MISMATCH');
    }
    expect(await rowCount('run'), 'no forged row may be stored').toBe(0);
  });

  it('cannot smuggle a piece the daily inventory never dealt', async () => {
    const player = await newPlayer();
    const board = dailyBoard(TODAY);

    // A board full of bombs would light everything. The inventory decides, not the payload.
    const greedy = Array.from({ length: INVENTORY_SIZE }, (_, i) => ({
      x: (i * 2) % board.w,
      y: 6 + i,
      piece: Piece.Bomb,
    }));

    const res = await call('POST', '/v1/runs', {
      token: player.token,
      body: { date: TODAY, placements: greedy, clientScore: 100_000 },
    });
    expect([400, 422]).toContain(res.status);
    expect(await rowCount('run')).toBe(0);
  });

  it('cannot stack pieces on one cell to multiply effects', async () => {
    const player = await newPlayer();
    const board = dailyBoard(TODAY);
    const cell = { x: board.originX === 0 ? 4 : 0, y: 6 };
    const stacked = Array.from({ length: 3 }, () => ({ ...cell, piece: board.inventory[0] }));

    const res = await call('POST', '/v1/runs', {
      token: player.token,
      body: { date: TODAY, placements: stacked, clientScore: 5000 },
    });
    expect([400, 422]).toContain(res.status);
  });

  it('cannot replay another day’s winning board against today', async () => {
    const player = await newPlayer();
    // Placements that score well on a *different* board, submitted for today.
    const other = bestRun('2026-01-05');
    const res = await call('POST', '/v1/runs', {
      token: player.token,
      body: { date: TODAY, placements: other.placements, clientScore: other.score },
    });
    // Either the pieces are not in today's inventory, or the score does not replay.
    expect([400, 422]).toContain(res.status);
  });
});

describe('authentication', () => {
  it('rejects an unsigned, self-made token', async () => {
    const { placements, score } = bestRun(TODAY);
    const forged = `${btoa('attacker.99999999999999').replace(/=+$/, '')}.${btoa('nope').replace(/=+$/, '')}`;

    const res = await call('POST', '/v1/runs', {
      token: forged,
      body: { date: TODAY, placements, clientScore: score },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with a different secret', async () => {
    const stolen = await issueToken('victim-id', 'the-wrong-secret');
    const { placements, score } = bestRun(TODAY);
    const res = await call('POST', '/v1/runs', {
      token: stolen,
      body: { date: TODAY, placements, clientScore: score },
    });
    expect(res.status).toBe(401);
  });

  it('rejects an expired token even though the signature is valid', async () => {
    const expired = await issueToken('someone', SECRET, Date.now() - 40 * 24 * 3600_000);
    const { placements, score } = bestRun(TODAY);
    const res = await call('POST', '/v1/runs', {
      token: expired,
      body: { date: TODAY, placements, clientScore: score },
    });
    expect(res.status).toBe(401);
  });

  it('survives malformed authorization headers without leaking a stack trace', async () => {
    const { placements, score } = bestRun(TODAY);

    // The Headers constructor rejects some of these itself (trailing whitespace,
    // control characters), which is the platform doing its job. To exercise the
    // Worker's own parsing, the header is injected past that validation.
    const nasty = [
      'Bearer',
      'Bearer ',
      'Bearer ....',
      'Basic YWRtaW46YWRtaW4=',
      `Bearer ${'A'.repeat(20_000)}`,
      'Bearer ../../etc/passwd',
      'Bearer null',
      'Bearer {"alg":"none"}',
    ];

    for (const value of nasty) {
      const req = new Request('https://api.test/v1/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ date: TODAY, placements, clientScore: score }),
      });
      Object.defineProperty(req, 'headers', {
        value: {
          get: (name: string) => (name.toLowerCase() === 'authorization' ? value : null),
        },
      });

      const res = await worker.fetch(req, env);
      const text = await res.text();
      expect([400, 401], value.slice(0, 24)).toContain(res.status);
      expect(text, 'no stack trace may reach the client').not.toMatch(/\.ts:\d+/);
      expect(text).not.toMatch(/TypeError|ReferenceError/);
    }
    expect(await rowCount('run')).toBe(0);
  });
});

describe('attempt budget', () => {
  it('cannot be reset by minting a new token for the same player id', async () => {
    const player = await newPlayer();
    const { placements, score } = bestRun(TODAY);
    const body = { date: TODAY, placements, clientScore: score };

    for (let i = 0; i < MAX_ATTEMPTS_LOCAL; i++) {
      expect((await call('POST', '/v1/runs', { token: player.token, body })).status).toBe(200);
    }

    // A fresh token for the same identity must inherit the same spent budget,
    // because the limit is keyed on the player row rather than on the token.
    const reissued = await issueToken(player.id, SECRET);
    const res = await call('POST', '/v1/runs', { token: reissued, body });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ATTEMPTS_EXHAUSTED');
  });

  it('cannot be exceeded by firing submissions concurrently', async () => {
    const player = await newPlayer();
    const { placements, score } = bestRun(TODAY);
    const body = { date: TODAY, placements, clientScore: score };

    // Ten at once. The unique index on (player, date, attempt_no) is the backstop.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => call('POST', '/v1/runs', { token: player.token, body }))
    );
    const accepted = results.filter((r) => r.status === 200).length;

    expect(accepted).toBeLessThanOrEqual(MAX_ATTEMPTS_LOCAL);
    expect(await rowCount('run')).toBeLessThanOrEqual(MAX_ATTEMPTS_LOCAL);
  });
});

const MAX_ATTEMPTS_LOCAL = 3;

describe('injection', () => {
  it('cannot inject SQL through the date path segment', async () => {
    const payloads = [
      "2026-08-17'; DROP TABLE run;--",
      '2026-08-17 OR 1=1',
      "' UNION SELECT id, handle FROM player--",
      '2026-08-17%27%20OR%20%271%27%3D%271',
    ];
    for (const p of payloads) {
      const res = await call('GET', `/v1/leaderboard/${encodeURIComponent(p)}`);
      expect([400, 404], p).toContain(res.status);
    }
    // The tables are still there.
    expect(await rowCount('player')).toBe(0);
    await call('POST', '/v1/players');
    expect(await rowCount('player')).toBe(1);
  });

  it('cannot inject SQL through the submitted date field', async () => {
    const player = await newPlayer();
    const { placements, score } = bestRun(TODAY);
    const res = await call('POST', '/v1/runs', {
      token: player.token,
      body: { date: "2026-08-17'; DELETE FROM run;--", placements, clientScore: score },
    });
    expect(res.status).toBe(400);
  });

  it('stores placements as data, never as anything executable', async () => {
    const player = await newPlayer();
    const { placements, score } = bestRun(TODAY);
    await call('POST', '/v1/runs', {
      token: player.token,
      body: { date: TODAY, placements, clientScore: score },
    });
    const row = await db.prepare('SELECT placements FROM run LIMIT 1').first<{ placements: string }>();
    expect(() => JSON.parse(row!.placements)).not.toThrow();
    expect(row!.placements).not.toMatch(/<script|javascript:|DROP |SELECT /i);
  });
});

describe('denial of service', () => {
  it('rejects an oversized placement array before doing any work', async () => {
    const player = await newPlayer();
    const huge = Array.from({ length: 5000 }, (_, i) => ({ x: i % 9, y: i % 13, piece: 1 }));
    const started = Date.now();
    const res = await call('POST', '/v1/runs', {
      token: player.token,
      body: { date: TODAY, placements: huge, clientScore: 0 },
    });
    expect(res.status).toBe(400);
    expect(Date.now() - started, 'must fail fast, not simulate').toBeLessThan(1000);
  });

  it('rejects absurd coordinates rather than allocating for them', async () => {
    const player = await newPlayer();
    for (const coord of [1e9, Number.MAX_SAFE_INTEGER, -1, 2 ** 31]) {
      const res = await call('POST', '/v1/runs', {
        token: player.token,
        body: {
          date: TODAY,
          placements: [{ x: coord, y: 0, piece: 1 }],
          clientScore: 0,
        },
      });
      expect([400, 422], String(coord)).toContain(res.status);
    }
  });

  it('caps the work a single legal submission can cause', async () => {
    const player = await newPlayer();
    const board = dailyBoard(TODAY);
    // Splitters multiply sparks; the sim caps both sparks and ticks.
    const splitters = board.inventory
      .map((piece, i) => ({ x: 1 + i, y: 11, piece }))
      .filter((p) => p.x < board.w);

    const started = Date.now();
    await call('POST', '/v1/runs', {
      token: player.token,
      body: { date: TODAY, placements: splitters, clientScore: 0 },
    });
    expect(Date.now() - started, 'bounded by MAX_TICKS and MAX_SPARKS').toBeLessThan(1500);
  });

  it('survives malformed and hostile JSON bodies', async () => {
    const player = await newPlayer();
    const bodies = [
      '',
      'null',
      '[]',
      '"just a string"',
      '{"date":',
      `{"date":"${TODAY}","placements":null,"clientScore":0}`,
      `{"__proto__":{"admin":true},"date":"${TODAY}","placements":[],"clientScore":0}`,
      `{"date":"${TODAY}","placements":[],"clientScore":1e309}`,
    ];
    for (const rawBody of bodies) {
      const res = await call('POST', '/v1/runs', { token: player.token, rawBody });
      expect([400, 422], rawBody.slice(0, 30)).toContain(res.status);
      expect(res.status).not.toBe(500);
    }
  });

  it('does not let a prototype-pollution payload reach Object.prototype', async () => {
    const player = await newPlayer();
    await call('POST', '/v1/runs', {
      token: player.token,
      rawBody: `{"date":"${TODAY}","placements":[],"clientScore":0,"constructor":{"prototype":{"polluted":true}}}`,
    });
    expect(({} as any).polluted).toBeUndefined();
    expect(({} as any).admin).toBeUndefined();
  });
});

describe('player creation rate limit', () => {
  it('throttles a single IP after the limit, and the pentest scenario', async () => {
    // The live pentest created 30 players from one address with no resistance.
    // The header carries the client IP; the handler counts recent rows for it.
    const create = (ip: string) =>
      worker.fetch(
        new Request('https://api.test/v1/players', {
          method: 'POST',
          headers: { 'cf-connecting-ip': ip },
        }),
        env
      );

    let created = 0;
    let limited = 0;
    for (let i = 0; i < 30; i++) {
      const res = await create('203.0.113.7');
      if (res.status === 201) created++;
      else if (res.status === 429) limited++;
    }
    expect(created).toBe(20);
    expect(limited).toBe(10);

    // A different address is unaffected — the limit is per IP, not global.
    expect((await create('203.0.113.8')).status).toBe(201);
  });
});

describe('response headers', () => {
  it('sets the security headers a JSON API needs', async () => {
    // Found missing on the live Worker by a pentest: the static site had them,
    // the API did not, because a header set does not carry across services.
    const res = await worker.fetch(
      new Request('https://api.test/v1/daily/2026-08-20', { method: 'GET' }),
      env
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('information disclosure', () => {
  it('never returns another player’s identifiers on the leaderboard', async () => {
    const player = await newPlayer();
    const { placements, score } = bestRun(TODAY);
    await call('POST', '/v1/runs', {
      token: player.token,
      body: { date: TODAY, placements, clientScore: score },
    });

    const res = await call('GET', `/v1/leaderboard/${TODAY}`);
    expect(res.text).not.toContain(player.id);
    expect(res.text).not.toContain(player.token);
    for (const entry of res.body.top) {
      expect(Object.keys(entry).sort()).toEqual(['handle', 'rank', 'score']);
    }
  });

  it('does not reveal today’s winning placements while the day is open', async () => {
    const player = await newPlayer();
    const { placements, score } = bestRun(TODAY);
    await call('POST', '/v1/runs', {
      token: player.token,
      body: { date: TODAY, placements, clientScore: score },
    });

    const res = await call('GET', `/v1/replays/${TODAY}/top`);
    expect(res.status).toBe(409);
    expect(res.text).not.toMatch(/"x":\s*\d/);
  });

  it('returns a generic message for unexpected failures', async () => {
    // A database that always throws stands in for any internal fault.
    const broken: Env = {
      DB: {
        prepare() {
          throw new Error('connection string postgres://user:hunter2@internal-host/db');
        },
      } as unknown as Env['DB'],
      TOKEN_SECRET: SECRET,
    };
    const res = await worker.fetch(
      new Request('https://api.test/v1/players', { method: 'POST' }),
      broken
    );
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('internal-host');
    expect(JSON.parse(text).error.code).toBe('INTERNAL');
  });
});
