/**
 * Fuse API — Cloudflare Worker.
 *
 * The one job that cannot live on the client: deciding whether a submitted score
 * is real. It does that by importing the very same simulation module the client
 * ran and executing the player's five placements again. Either the number
 * matches or the submission is rejected — no heuristics, no thresholds.
 *
 * Everything else here (players, leaderboard, replays) is bookkeeping around
 * that one guarantee.
 */
import { run, type Placement } from '../../core/sim/index.js';
import { dailyBoard, puzzleNumber, utcDate } from '../../core/gen/index.js';
import {
  MAX_ATTEMPTS,
  RunSubmission,
  errorResponse,
  json,
  parseDateParam,
  toPlacements,
} from './contract.js';
import { issueToken, verifyToken } from './auth.js';
import type { D1Database } from './d1.js';

export interface Env {
  DB: D1Database;
  /** HMAC secret for player tokens. Set with `wrangler secret put TOKEN_SECRET`. */
  TOKEN_SECRET: string;
}

/** Minutes of slack for a run that began just before the UTC rollover. */
const GRACE_MINUTES = 5;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      // Never leak internals to a client, but never swallow the cause either.
      console.error('[fuse-api] unhandled', {
        message: err instanceof Error ? err.message : String(err),
        url: request.url,
      });
      return errorResponse('INTERNAL', 'Something went wrong', 500);
    }
  },
};

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

  if (method === 'POST' && path === '/v1/players') return cors(await createPlayer(env));

  const daily = /^\/v1\/daily\/([^/]+)$/.exec(path);
  if (method === 'GET' && daily) return cors(getDaily(daily[1]));

  if (method === 'POST' && path === '/v1/runs') return cors(await submitRun(request, env));

  const board = /^\/v1\/leaderboard\/([^/]+)$/.exec(path);
  if (method === 'GET' && board) return cors(await getLeaderboard(board[1], url, env));

  const replay = /^\/v1\/replays\/([^/]+)\/top$/.exec(path);
  if (method === 'GET' && replay) return cors(await getTopReplay(replay[1], env));

  return cors(errorResponse('NOT_FOUND', `No route for ${method} ${path}`, 404));
}

function cors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-headers', 'content-type, authorization');
  headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  return new Response(res.body, { status: res.status, headers });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Anonymous identity. No email, no password, nothing to leak (ADR-004). */
async function createPlayer(env: Env): Promise<Response> {
  const id = crypto.randomUUID();
  const handle = generateHandle();
  const createdAt = Date.now();

  await env.DB.prepare('INSERT INTO player (id, handle, created_at) VALUES (?, ?, ?)')
    .bind(id, handle, createdAt)
    .run();

  return json({ id, handle, token: await issueToken(id, env.TOKEN_SECRET) }, 201);
}

/**
 * The board for a date.
 *
 * The client derives this itself and works offline; this endpoint exists so a
 * future web leaderboard or a bot can ask without bundling the generator.
 */
function getDaily(dateParam: string): Response {
  const date = parseDateParam(dateParam);
  if (!date) return errorResponse('BAD_DATE', 'Expected a YYYY-MM-DD date', 400);

  const board = dailyBoard(date);
  return json({
    date,
    puzzle: puzzleNumber(date),
    width: board.w,
    height: board.h,
    cells: Array.from(board.cells),
    origin: { x: board.originX, y: board.originY, dir: board.originDir },
    energy: board.energy,
    inventory: Array.from(board.inventory),
  });
}

async function submitRun(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('authorization') ?? '';
  const playerId = await verifyToken(auth.replace(/^Bearer\s+/i, ''), env.TOKEN_SECRET);
  if (!playerId) return errorResponse('UNAUTHORIZED', 'Missing or invalid token', 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('BAD_BODY', 'Body must be JSON', 400);
  }

  const parsed = RunSubmission.safeParse(body);
  if (!parsed.success) {
    return errorResponse('BAD_BODY', 'Submission failed validation', 400, parsed.error);
  }
  const submission = parsed.data;

  if (!isSubmittableToday(submission.date)) {
    return errorResponse('DATE_NOT_TODAY', 'Runs can only be submitted for the current UTC day', 409);
  }

  const attempts = await countAttempts(env, playerId, submission.date);
  if (attempts >= MAX_ATTEMPTS) {
    return errorResponse('ATTEMPTS_EXHAUSTED', `Only ${MAX_ATTEMPTS} ranked attempts per day`, 409);
  }

  const board = dailyBoard(submission.date);
  let placements: Placement[];
  let result: ReturnType<typeof run>;
  try {
    placements = toPlacements(submission.placements);
    // The authoritative moment: the server replays the run itself.
    result = run(board, placements);
  } catch (err) {
    return errorResponse(
      'ILLEGAL_PLACEMENTS',
      err instanceof Error ? err.message : 'Placements are not legal for this board',
      422
    );
  }

  if (result.score !== submission.clientScore) {
    console.warn('[fuse-api] score mismatch', {
      playerId,
      date: submission.date,
      claimed: submission.clientScore,
      actual: result.score,
    });
    return errorResponse('SCORE_MISMATCH', 'Reported score does not match the replay', 422);
  }

  const attemptNo = attempts + 1;
  await env.DB.prepare(
    `INSERT INTO run (id, player_id, date, score, placements, attempt_no, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(player_id, date, attempt_no) DO NOTHING`
  )
    .bind(
      crypto.randomUUID(),
      playerId,
      submission.date,
      result.score,
      JSON.stringify(submission.placements),
      attemptNo,
      Date.now()
    )
    .run();

  const rank = await rankOf(env, submission.date, result.score);
  const total = await countPlayers(env, submission.date);

  return json({
    accepted: true,
    score: result.score,
    ignited: result.ignited,
    totalNodes: result.totalNodes,
    rank,
    players: total,
    percentile: total > 0 ? Math.round(((total - rank + 1) / total) * 100) : 100,
    attemptsLeft: MAX_ATTEMPTS - attemptNo,
  });
}

async function getLeaderboard(dateParam: string, url: URL, env: Env): Promise<Response> {
  const date = parseDateParam(dateParam);
  if (!date) return errorResponse('BAD_DATE', 'Expected a YYYY-MM-DD date', 400);

  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100), 1), 100);
  const rows = await env.DB.prepare(
    `SELECT p.handle AS handle, MAX(r.score) AS score
     FROM run r JOIN player p ON p.id = r.player_id
     WHERE r.date = ?
     GROUP BY r.player_id
     ORDER BY score DESC
     LIMIT ?`
  )
    .bind(date, limit)
    .all<{ handle: string; score: number }>();

  // Competition ranking: everyone on the same score shares a position, and the
  // next distinct score skips ahead. Numbering rows sequentially instead made
  // the board disagree with the rank a submission was told it earned — two
  // players tied on 7200 were shown as first and second.
  let rank = 0;
  let seen = 0;
  let previousScore: number | null = null;

  return json({
    date,
    puzzle: puzzleNumber(date),
    top: (rows.results ?? []).map((row) => {
      seen++;
      if (row.score !== previousScore) {
        rank = seen;
        previousScore = row.score;
      }
      return { rank, handle: row.handle, score: row.score };
    }),
  });
}

/**
 * The winning run, released only once the day is over.
 *
 * Serving it while the board is still live would hand every player the answer,
 * so the date check here is a game rule, not a caching detail.
 */
async function getTopReplay(dateParam: string, env: Env): Promise<Response> {
  const date = parseDateParam(dateParam);
  if (!date) return errorResponse('BAD_DATE', 'Expected a YYYY-MM-DD date', 400);
  if (date >= utcDate()) {
    return errorResponse('DAY_STILL_OPEN', 'The winning run is revealed once the day closes', 409);
  }

  const row = await env.DB.prepare(
    `SELECT p.handle AS handle, r.score AS score, r.placements AS placements
     FROM run r JOIN player p ON p.id = r.player_id
     WHERE r.date = ?
     ORDER BY r.score DESC
     LIMIT 1`
  )
    .bind(date)
    .first<{ handle: string; score: number; placements: string }>();

  if (!row) return errorResponse('NO_RUNS', 'Nobody submitted a run that day', 404);

  return json({
    date,
    puzzle: puzzleNumber(date),
    handle: row.handle,
    score: row.score,
    placements: JSON.parse(row.placements),
  });
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

async function countAttempts(env: Env, playerId: string, date: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM run WHERE player_id = ? AND date = ?')
    .bind(playerId, date)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function rankOf(env: Env, date: string, score: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT MAX(score) AS best FROM run WHERE date = ? GROUP BY player_id
     ) WHERE best > ?`
  )
    .bind(date, score)
    .first<{ n: number }>();
  return (row?.n ?? 0) + 1;
}

async function countPlayers(env: Env, date: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(DISTINCT player_id) AS n FROM run WHERE date = ?'
  )
    .bind(date)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * A run started just before midnight must still be submittable just after it,
 * or players in the wrong timezone lose an attempt to the clock.
 */
export function isSubmittableToday(date: string, now: number = Date.now()): boolean {
  if (date === utcDate(now)) return true;
  return date === utcDate(now - GRACE_MINUTES * 60_000);
}

const HANDLE_HEADS = [
  'Chispa', 'Mecha', 'Cobre', 'Fusible', 'Arco', 'Brasa', 'Cable', 'Nodo',
  'Circuito', 'Destello', 'Filamento', 'Bobina', 'Relé', 'Diodo',
];

function generateHandle(): string {
  const head = HANDLE_HEADS[Math.floor(Math.random() * HANDLE_HEADS.length)];
  const n = 100 + Math.floor(Math.random() * 900);
  return `${head}${n}`;
}
