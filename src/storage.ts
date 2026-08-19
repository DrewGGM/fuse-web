/**
 * Local persistence.
 *
 * Everything a player owns lives on the device: there are no accounts (ADR-004),
 * so this file is the whole save game. It is written defensively — a corrupt or
 * half-written record must degrade to "new player", never to a crash on launch.
 */

const KEY = 'fuse.save.v1';

export interface DayResult {
  /** `YYYY-MM-DD` in UTC. */
  readonly date: string;
  readonly best: number;
  readonly ignited: number;
  readonly totalNodes: number;
  readonly attempts: number;
}

export interface Settings {
  reminder: boolean;
  sound: boolean;
  reducedMotion: boolean;
  palette: string;
}

/** Minimal shape of the identity; the full type lives in api.ts. */
export interface StoredIdentity {
  readonly id: string;
  readonly handle: string;
  readonly token: string;
}

/** A run recorded locally and not yet acknowledged by the server. */
export interface StoredPendingRun {
  readonly id: string;
  readonly date: string;
  readonly placements: { x: number; y: number; piece: number }[];
  readonly score: number;
  readonly queuedAt: number;
  attempts: number;
  lastError?: string;
}

export interface SaveData {
  version: 1;
  results: Record<string, DayResult>;
  settings: Settings;
  /** Palette ids the player has unlocked, by watching a rewarded ad or buying. */
  unlockedPalettes: string[];
  /** True once the ad-free purchase is verified. */
  adFree: boolean;
  /** Cosmetic currency earned by playing. */
  sparks: number;
  /** Last date a reward was granted, so doubling can't be farmed. */
  lastRewardDate: string | null;
  rewardsUsedToday: number;
  /** True once the first-run tutorial has been seen or skipped. */
  tutorialDone: boolean;
  /** Anonymous server identity, created on first successful contact. */
  identity: StoredIdentity | null;
  /** Runs waiting to reach the server. Survives a reload and a reinstall-free crash. */
  pendingRuns: StoredPendingRun[];
  /** Best-known rank per date, so the home card can show it offline. */
  ranks: Record<string, { rank: number; players: number; percentile: number }>;
}

const DEFAULTS: SaveData = {
  version: 1,
  results: {},
  settings: { reminder: false, sound: true, reducedMotion: false, palette: 'ember' },
  unlockedPalettes: ['ember', 'plasma'],
  adFree: false,
  sparks: 0,
  lastRewardDate: null,
  rewardsUsedToday: 0,
  tutorialDone: false,
  identity: null,
  pendingRuns: [],
  ranks: {},
};

function clone(data: SaveData): SaveData {
  return JSON.parse(JSON.stringify(data)) as SaveData;
}

let cache: SaveData | null = null;

export function load(): SaveData {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      cache = clone(DEFAULTS);
      return cache;
    }
    const parsed = JSON.parse(raw) as Partial<SaveData>;
    cache = {
      ...clone(DEFAULTS),
      ...parsed,
      settings: { ...DEFAULTS.settings, ...(parsed.settings ?? {}) },
      results: parsed.results ?? {},
      unlockedPalettes: parsed.unlockedPalettes ?? [...DEFAULTS.unlockedPalettes],
      // A save written by an older build has none of these; defaulting here
      // rather than at every use site keeps the rest of the app from guarding.
      pendingRuns: parsed.pendingRuns ?? [],
      ranks: parsed.ranks ?? {},
      identity: parsed.identity ?? null,
    };
    return cache;
  } catch {
    // A broken save must not brick the app. Start clean and move on.
    cache = clone(DEFAULTS);
    return cache;
  }
}

export function save(): void {
  if (!cache) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Private mode or a full quota. The session still works; nothing to tell the player.
  }
}

export function update(fn: (data: SaveData) => void): SaveData {
  const data = load();
  fn(data);
  save();
  return data;
}

export function getResult(date: string): DayResult | null {
  return load().results[date] ?? null;
}

export function attemptsLeft(date: string, maxAttempts: number): number {
  const r = getResult(date);
  return Math.max(0, maxAttempts - (r?.attempts ?? 0));
}

/** Records an attempt, keeping the best score of the day. Returns the stored result. */
export function recordAttempt(
  date: string,
  score: number,
  ignited: number,
  totalNodes: number
): DayResult {
  const data = update((d) => {
    const prev = d.results[date];
    const better = !prev || score > prev.best;
    d.results[date] = {
      date,
      best: better ? score : prev.best,
      ignited: better ? ignited : prev.ignited,
      totalNodes,
      attempts: (prev?.attempts ?? 0) + 1,
    };
    // Playing pays a small amount of cosmetic currency; watching an ad can double it.
    d.sparks += 10;
  });
  return data.results[date];
}

/**
 * Consecutive days played, counting back from today.
 *
 * Deliberately forgiving in one direction only: a streak survives if the player
 * has already played today OR played yesterday and today is still open. It does
 * not survive a missed day, because a streak that cannot break is not a streak.
 */
export function currentStreak(today: string): number {
  const { results } = load();
  let streak = 0;
  let cursor = Date.parse(`${today}T00:00:00Z`);

  // If today has not been played yet, the streak is still whatever ended yesterday.
  if (!results[today]) cursor -= 86400000;

  for (;;) {
    const key = new Date(cursor).toISOString().slice(0, 10);
    if (!results[key]) break;
    streak++;
    cursor -= 86400000;
  }
  return streak;
}

/** Rewarded offers are capped per day. Rolls over automatically on a new date. */
export function rewardsLeft(today: string, cap: number): number {
  const data = load();
  if (data.lastRewardDate !== today) return cap;
  return Math.max(0, cap - data.rewardsUsedToday);
}

export function consumeReward(today: string): void {
  update((d) => {
    if (d.lastRewardDate !== today) {
      d.lastRewardDate = today;
      d.rewardsUsedToday = 0;
    }
    d.rewardsUsedToday++;
  });
}

/** Remembers where a run placed, so the home screen can show it without a network call. */
export function recordRank(
  date: string,
  rank: number,
  players: number,
  percentile: number
): void {
  update((d) => {
    d.ranks[date] = { rank, players, percentile };
  });
}

export function getRank(date: string): { rank: number; players: number; percentile: number } | null {
  return load().ranks[date] ?? null;
}

/** Test seam: drops the in-memory cache so a test can re-read storage. */
export function __resetCacheForTests(): void {
  cache = null;
}
