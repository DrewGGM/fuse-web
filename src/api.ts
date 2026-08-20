/**
 * Client for the Fuse API.
 *
 * Every method here is optional to the game: the board is derived locally and a
 * run scores locally, so the network only ever *adds* the shared leaderboard.
 * Nothing in this file may throw into a render path or block a player from
 * playing — an offline player must have exactly the same game, minus the
 * comparison with everyone else.
 *
 * That is why every call returns a discriminated result instead of throwing,
 * and why the caller is expected to carry on when one fails.
 */
import type { Placement } from '../core/sim/index.js';

/**
 * Where the API lives. Overridden at build time for local development.
 *
 * Exported so a verification script can ask the page which API it is really
 * talking to rather than infer it from the URL it was pointed at. Those are not
 * the same question: a local preview built without FUSE_API_BASE submits to
 * production, which is how a check meant for localhost put two invented names
 * on the live leaderboard.
 */
export const BASE_URL: string =
  typeof __API_BASE__ === 'string' && __API_BASE__ ? __API_BASE__ : 'https://api-fuse.andrewgarcia.dev';

/** A slow network must not hold the result screen hostage. */
const TIMEOUT_MS = 6000;

export interface Identity {
  readonly id: string;
  readonly handle: string;
  readonly token: string;
}

export interface SubmitResult {
  readonly accepted: true;
  readonly score: number;
  readonly ignited: number;
  readonly totalNodes: number;
  readonly rank: number;
  readonly players: number;
  readonly percentile: number;
  readonly attemptsLeft: number;
}

export interface LeaderboardEntry {
  readonly rank: number;
  readonly handle: string;
  readonly score: number;
}

export interface Leaderboard {
  readonly date: string;
  readonly puzzle: number;
  readonly top: LeaderboardEntry[];
}

export interface TopReplay {
  readonly date: string;
  readonly puzzle: number;
  readonly handle: string;
  readonly score: number;
  readonly placements: Placement[];
}

/**
 * Why a call did not succeed.
 *
 * `offline` and `server` are worth retrying later; `rejected` is not — the
 * server has looked at the submission and said no, and sending it again will
 * produce the same answer.
 */
export type ApiFailure =
  | { ok: false; kind: 'offline' }
  | { ok: false; kind: 'server'; status: number }
  | { ok: false; kind: 'rejected'; status: number; code: string; message: string };

export type ApiResult<T> = ({ ok: true } & T) | ApiFailure;

export function isRetryable(failure: ApiFailure): boolean {
  return failure.kind !== 'rejected';
}

async function request<T>(
  path: string,
  init: RequestInit & { token?: string } = {}
): Promise<ApiResult<{ data: T }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const headers = new Headers(init.headers);
    if (init.body) headers.set('content-type', 'application/json');
    if (init.token) headers.set('authorization', `Bearer ${init.token}`);

    const res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });

    const text = await res.text();
    const body = text ? safeParse(text) : null;

    if (res.ok) return { ok: true, data: body as T };

    // 4xx means the server understood and refused. Retrying changes nothing.
    if (res.status >= 400 && res.status < 500) {
      return {
        ok: false,
        kind: 'rejected',
        status: res.status,
        code: body?.error?.code ?? 'UNKNOWN',
        message: body?.error?.message ?? 'Rejected',
      };
    }
    return { ok: false, kind: 'server', status: res.status };
  } catch {
    // Abort, DNS failure, no route, CORS — all indistinguishable from here, and
    // all mean the same thing to a player: try again later.
    return { ok: false, kind: 'offline' };
  } finally {
    clearTimeout(timer);
  }
}

function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function createIdentity(): Promise<ApiResult<{ data: Identity }>> {
  return request<Identity>('/v1/players', { method: 'POST' });
}

export async function submitRun(
  token: string,
  date: string,
  placements: readonly Placement[],
  clientScore: number
): Promise<ApiResult<{ data: SubmitResult }>> {
  return request<SubmitResult>('/v1/runs', {
    method: 'POST',
    token,
    body: JSON.stringify({ date, placements, clientScore }),
  });
}

export async function fetchLeaderboard(date: string): Promise<ApiResult<{ data: Leaderboard }>> {
  return request<Leaderboard>(`/v1/leaderboard/${date}`);
}

export async function fetchTopReplay(date: string): Promise<ApiResult<{ data: TopReplay }>> {
  return request<TopReplay>(`/v1/replays/${date}/top`);
}

declare global {
  const __API_BASE__: string;
}
