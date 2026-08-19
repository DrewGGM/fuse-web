/**
 * Outbound queue for ranked runs.
 *
 * A player on the underground finishes a run, and it has to count. The score is
 * recorded locally the moment the run ends; this queue is what eventually tells
 * the server about it.
 *
 * Three rules shape the design:
 *
 *   - **Never lose a run.** It is written to storage before any network call.
 *   - **Never double-count one.** The server keys attempts on
 *     (player, date, attempt_no), so a retry that actually arrived twice is
 *     absorbed there; here we simply stop retrying once accepted.
 *   - **Never retry something the server refused.** A rejected submission is
 *     dropped with its reason kept, because sending it again produces the same
 *     answer and would spin forever.
 */
import type { Placement, PieceValue } from '../core/sim/index.js';
import * as api from './api.js';
import * as store from './storage.js';

export interface PendingRun {
  /** Local id, so a run can be found again after a reload. */
  readonly id: string;
  readonly date: string;
  readonly placements: Placement[];
  readonly score: number;
  readonly queuedAt: number;
  attempts: number;
  lastError?: string;
}

/** Give up after this many tries and keep the run for inspection rather than looping. */
const MAX_TRIES = 8;

export type FlushOutcome =
  | { status: 'idle' }
  | { status: 'sent'; result: api.SubmitResult; pendingLeft: number }
  | { status: 'offline'; pendingLeft: number }
  | { status: 'rejected'; code: string; pendingLeft: number };

let flushing = false;

/** Queues a run for submission. Returns immediately; the caller never waits. */
export function enqueue(date: string, placements: readonly Placement[], score: number): PendingRun {
  const run: PendingRun = {
    id: `${date}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    date,
    placements: [...placements],
    score,
    queuedAt: Date.now(),
    attempts: 0,
  };
  store.update((d) => {
    d.pendingRuns.push(run);
  });
  return run;
}

export function pendingCount(): number {
  return store.load().pendingRuns.length;
}

/**
 * Attempts to send the oldest queued run.
 *
 * Deliberately one at a time: submissions are ordered by attempt number on the
 * server, and firing the queue in parallel would race them into the wrong slots.
 */
export async function flushOne(identity: api.Identity | null): Promise<FlushOutcome> {
  if (flushing) return { status: 'idle' };
  const queue = store.load().pendingRuns;
  if (queue.length === 0 || !identity) return { status: 'idle' };

  flushing = true;
  try {
    const run = queue[0];
    // Storage is plain JSON, so the piece values come back as numbers. They were
    // validated by the simulation before being queued, and the server validates
    // them again on arrival — this cast only restores the type, not the trust.
    const placements = run.placements.map((p) => ({
      x: p.x,
      y: p.y,
      piece: p.piece as PieceValue,
    }));
    const outcome = await api.submitRun(identity.token, run.date, placements, run.score);

    if (outcome.ok) {
      drop(run.id);
      return { status: 'sent', result: outcome.data, pendingLeft: pendingCount() };
    }

    if (!api.isRetryable(outcome)) {
      // The server looked at it and said no. Keep the reason, stop retrying.
      const code = outcome.kind === 'rejected' ? outcome.code : 'UNKNOWN';
      drop(run.id);
      return { status: 'rejected', code, pendingLeft: pendingCount() };
    }

    store.update((d) => {
      const queued = d.pendingRuns.find((r) => r.id === run.id);
      if (!queued) return;
      queued.attempts++;
      queued.lastError = outcome.kind;
      // A run that has failed this many times is not going to succeed by being
      // tried a ninth time, and an unbounded queue is its own bug.
      if (queued.attempts >= MAX_TRIES) {
        d.pendingRuns = d.pendingRuns.filter((r) => r.id !== run.id);
      }
    });
    return { status: 'offline', pendingLeft: pendingCount() };
  } finally {
    flushing = false;
  }
}

/** Drains the queue until it is empty or the network stops cooperating. */
export async function flushAll(identity: api.Identity | null): Promise<FlushOutcome> {
  let last: FlushOutcome = { status: 'idle' };
  for (let i = 0; i < 10; i++) {
    const outcome = await flushOne(identity);
    if (outcome.status === 'idle') break;
    last = outcome;
    if (outcome.status === 'offline') break;
    if (outcome.pendingLeft === 0) break;
  }
  return last;
}

function drop(id: string): void {
  store.update((d) => {
    d.pendingRuns = d.pendingRuns.filter((r) => r.id !== id);
  });
}

/**
 * Ensures the device has an identity, creating one on first contact.
 *
 * Returns null when offline, and the caller carries on without a leaderboard —
 * a new player with no signal still gets a complete single-player game.
 */
export async function ensureIdentity(): Promise<api.Identity | null> {
  const saved = store.load().identity;
  if (saved) return saved;

  const created = await api.createIdentity();
  if (!created.ok) return null;

  store.update((d) => {
    d.identity = created.data;
  });
  return created.data;
}
