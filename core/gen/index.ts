/**
 * @fuse/gen — daily board generation and the reference solver.
 *
 * Split into two halves on purpose:
 *
 *   - `dailyBoard(date)` is CHEAP and runs on the client. It must produce an
 *     identical board everywhere, so seed selection uses only fast structural
 *     checks — never the solver. If it depended on the solver, a client with
 *     different sampling would derive a different board and the whole daily
 *     comparison falls apart.
 *   - `solve(board)` is EXPENSIVE and runs on the server or in tooling. It
 *     estimates par and tells us whether a board is actually interesting.
 *     Board quality is verified in CI across months of future dates, not at runtime.
 *
 * Same rules as @fuse/sim: integers only, no ambient state, no dependencies.
 */

import {
  Cell,
  Dir,
  INVENTORY_SIZE,
  PLAYABLE_PIECES,
  Piece,
  run,
  type Board,
  type DirValue,
  type PieceValue,
  type Placement,
} from '../sim/index.js';
import CURATED_SEEDS from './seeds.json' with { type: 'json' };
import CURATED_PARS from './pars.json' with { type: 'json' };
import CURATED_TARGETS from './targets.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Board shape and tuning
// ---------------------------------------------------------------------------

export const BOARD_W = 9;
export const BOARD_H = 13;
export const START_ENERGY = 150;

const MIN_NODES = 12;
const MAX_NODES = 18;
const MIN_WALLS = 6;
const MAX_WALLS = 12;
/**
 * Nodes are laid in short straight runs along a traced route, not scattered.
 *
 * This is the load-bearing decision of the generator. Scattered nodes cannot be
 * reached by one spark and five pieces, so par lit a quarter of the board and
 * every day felt the same. In runs, one well-aimed mirror lights four nodes in
 * sequence — which is both the moment of skill and the two seconds of a clip
 * that make someone stop scrolling.
 */
/** Share of nodes laid along the traced route; the rest are off-route bonuses. */
const ON_PATH_SHARE = 0.7;
const MIN_RUN = 2;
const MAX_RUN = 5;
/** The unobstructed ray from the origin must travel at least this far, or the board is cramped. */
const MIN_CLEAR_RUN = 4;
/** Give up widening after this many seeds and take what we have, rather than loop forever. */
const MAX_SEED_ATTEMPTS = 512;

// ---------------------------------------------------------------------------
// PRNG — mulberry32. 32-bit integer state, identical in every JS engine.
// ---------------------------------------------------------------------------

export interface Rng {
  /** Next integer in [0, bound). */
  int(bound: number): number;
  /** Fisher-Yates, in place. */
  shuffle<T>(items: T[]): T[];
}

export function createRng(seed: number): Rng {
  let a = seed | 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const int = (bound: number): number => (bound <= 0 ? 0 : next() % bound);
  return {
    int,
    shuffle<T>(items: T[]): T[] {
      for (let i = items.length - 1; i > 0; i--) {
        const j = int(i + 1);
        const tmp = items[i];
        items[i] = items[j];
        items[j] = tmp;
      }
      return items;
    },
  };
}

/** `YYYY-MM-DD` → a 32-bit seed. Rejects anything that isn't a real calendar date. */
export function dateToSeed(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid date "${date}", expected YYYY-MM-DD`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) throw new Error(`Invalid date "${date}"`);
  // Mix the components so adjacent days produce unrelated boards.
  let h = 0x811c9dc5 | 0;
  for (const v of [y, mo, d]) {
    h = Math.imul(h ^ v, 0x01000193) | 0;
  }
  return h >>> 0;
}

/** The puzzle number shown in the share text. Day 1 is the launch date. */
export const EPOCH = '2026-01-01';

export function puzzleNumber(date: string): number {
  return Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${EPOCH}T00:00:00Z`)) / 86400000) + 1;
}

/** Today's date in UTC as `YYYY-MM-DD`. The one place the clock is read. */
export function utcDate(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function pickOrigin(rng: Rng): { x: number; y: number; dir: DirValue } {
  // Always start on an edge pointing inward, so the first move is always legal.
  const edge = rng.int(4);
  if (edge === 0) return { x: rng.int(BOARD_W), y: 0, dir: Dir.Down };
  if (edge === 1) return { x: BOARD_W - 1, y: rng.int(BOARD_H), dir: Dir.Left };
  if (edge === 2) return { x: rng.int(BOARD_W), y: BOARD_H - 1, dir: Dir.Up };
  return { x: 0, y: rng.int(BOARD_H), dir: Dir.Right };
}

function rollInventory(rng: Rng, required: readonly PieceValue[]): PieceValue[] {
  // The mirrors the traced route needs are dealt first — without them the
  // intended solution would be impossible to build. The rest are drawn freely
  // and are what let a player beat the intended route.
  const inv: PieceValue[] = required.slice(0, INVENTORY_SIZE);
  while (inv.length < INVENTORY_SIZE) {
    inv.push(PLAYABLE_PIECES[rng.int(PLAYABLE_PIECES.length)]);
  }
  return rng.shuffle(inv);
}

const DX = [0, 1, 0, -1] as const;
const DY = [-1, 0, 1, 0] as const;
const MIRROR_A_OUT = [Dir.Right, Dir.Up, Dir.Left, Dir.Down] as const;

interface GhostPath {
  /** Cells the spark passes through, in order, excluding the origin. */
  readonly cells: number[];
  /** Cells where a mirror has to go, with the mirror the player must use there. */
  readonly turns: { at: number; piece: PieceValue }[];
}

/**
 * Traces a plausible solution before any node exists, then the board is built
 * around it.
 *
 * Generating noise and testing whether it happens to be playable produced boards
 * where par lit a quarter of the nodes — the spark simply cannot reach cells
 * scattered at random. Tracing the answer first guarantees that a good route
 * exists and that most nodes sit on it. The player still has to find it.
 */
function traceGhost(rng: Rng, origin: { x: number; y: number; dir: DirValue }): GhostPath {
  const cells: number[] = [];
  const turns: { at: number; piece: PieceValue }[] = [];
  const wantTurns = 2 + rng.int(2); // 2 or 3 mirrors, leaving inventory room for extras

  let x = origin.x;
  let y = origin.y;
  let dir = origin.dir;
  let budget = START_ENERGY - 10; // leave slack so the real spark does not die early

  for (let leg = 0; leg <= wantTurns; leg++) {
    const isLast = leg === wantTurns;
    const wanted = 3 + rng.int(6);
    let walked = 0;

    while (walked < wanted && budget > 0) {
      const nx = x + DX[dir];
      const ny = y + DY[dir];
      if (nx < 0 || ny < 0 || nx >= BOARD_W || ny >= BOARD_H) break;
      x = nx;
      y = ny;
      cells.push(y * BOARD_W + x);
      walked++;
      budget--;
    }

    if (isLast || walked === 0) break;

    // Turn towards whichever side has more room, so the next leg is not stillborn.
    const left = ((dir + 3) & 3) as DirValue;
    const right = ((dir + 1) & 3) as DirValue;
    const room = (d: DirValue): number => {
      let n = 0;
      let cx = x;
      let cy = y;
      for (;;) {
        cx += DX[d];
        cy += DY[d];
        if (cx < 0 || cy < 0 || cx >= BOARD_W || cy >= BOARD_H) break;
        n++;
      }
      return n;
    };
    const roomLeft = room(left);
    const roomRight = room(right);
    const outDir = roomLeft === roomRight ? (rng.int(2) === 0 ? left : right) : roomLeft > roomRight ? left : right;
    if (room(outDir) < 2) break;

    const at = y * BOARD_W + x;
    turns.push({ at, piece: MIRROR_A_OUT[dir] === outDir ? Piece.MirrorA : Piece.MirrorB });
    dir = outDir;
  }

  return { cells, turns };
}

export function generateBoard(seed: number): Board {
  const rng = createRng(seed);
  const cells = new Uint8Array(BOARD_W * BOARD_H);
  const origin = pickOrigin(rng);
  const originIndex = origin.y * BOARD_W + origin.x;

  const ghost = traceGhost(rng, origin);
  // Mirror cells must stay empty — a piece can only be placed on an empty cell,
  // so putting a node there would make the intended solution illegal.
  const reserved = new Set<number>(ghost.turns.map((t) => t.at));
  reserved.add(originIndex);

  const onPath = ghost.cells.filter((at) => !reserved.has(at));
  /** Every cell the intended solution touches. A wall here would break it. */
  const routeCells = new Set<number>([...ghost.cells, ...reserved]);

  const nodeCount = MIN_NODES + rng.int(MAX_NODES - MIN_NODES + 1);
  const wallCount = MIN_WALLS + rng.int(MAX_WALLS - MIN_WALLS + 1);

  // Most nodes go on the traced route, in broken runs rather than a solid line
  // so the path reads as a puzzle and not as a drawn answer.
  const onPathTarget = Math.round(nodeCount * ON_PATH_SHARE);
  let nodes = 0;
  let cursor = rng.int(3);
  while (cursor < onPath.length && nodes < onPathTarget) {
    const runLength = MIN_RUN + rng.int(MAX_RUN - MIN_RUN + 1);
    for (let i = 0; i < runLength && cursor < onPath.length && nodes < onPathTarget; i++, cursor++) {
      const at = onPath[cursor];
      if (cells[at] !== Cell.Empty || reserved.has(at)) continue;
      cells[at] = Cell.Node;
      nodes++;
    }
    cursor += 1 + rng.int(3); // gap, so the route is not a dotted line to the answer
  }

  /** Lays a straight run of `value` cells, or gives up if it would collide. */
  const layRun = (value: number, length: number, avoid?: Set<number>): number => {
    const horizontal = rng.int(2) === 0;
    const maxX = horizontal ? BOARD_W - length : BOARD_W - 1;
    const maxY = horizontal ? BOARD_H - 1 : BOARD_H - length;
    if (maxX < 0 || maxY < 0) return 0;
    const x0 = rng.int(maxX + 1);
    const y0 = rng.int(maxY + 1);

    // All-or-nothing: a partially written run would leave stubs everywhere.
    for (let i = 0; i < length; i++) {
      const at = (y0 + (horizontal ? 0 : i)) * BOARD_W + (x0 + (horizontal ? i : 0));
      if (at === originIndex || cells[at] !== Cell.Empty) return 0;
      if (avoid?.has(at)) return 0;
    }
    for (let i = 0; i < length; i++) {
      const at = (y0 + (horizontal ? 0 : i)) * BOARD_W + (x0 + (horizontal ? i : 0));
      cells[at] = value;
    }
    return length;
  };

  // The rest go off-route as bonus targets: reachable with a splitter, a bomb,
  // or by giving up part of the main line. This is where the score spread comes from.
  for (let guard = 0; guard < 400 && nodes < nodeCount; guard++) {
    const length = Math.min(nodeCount - nodes, MIN_RUN + rng.int(MAX_RUN - MIN_RUN + 1));
    nodes += layRun(Cell.Node, Math.max(length, 1));
  }

  // Walls come in short runs so they read as structure instead of noise.
  let walls = 0;
  for (let guard = 0; guard < 300 && walls < wallCount; guard++) {
    const length = Math.min(wallCount - walls, 1 + rng.int(3));
    walls += layRun(Cell.Wall, Math.max(length, 1), routeCells);
  }

  return {
    w: BOARD_W,
    h: BOARD_H,
    cells,
    originX: origin.x,
    originY: origin.y,
    originDir: origin.dir,
    energy: START_ENERGY,
    inventory: rollInventory(rng, ghost.turns.map((t) => t.piece)),
  };
}

/**
 * Fast sanity checks used for seed selection. Deliberately cheap: this runs on
 * every client at app start, so it must never call the solver.
 */
/** Nodes must not all huddle in one half, or half the board is dead space. */
function nodesAreSpread(board: Board, nodes: number): boolean {
  let left = 0;
  let top = 0;
  for (let i = 0; i < board.cells.length; i++) {
    if (board.cells[i] !== Cell.Node) continue;
    if (i % board.w < board.w / 2) left++;
    if (Math.floor(i / board.w) < board.h / 2) top++;
  }
  return left > 0 && left < nodes && top > 0 && top < nodes;
}

/** How far the bare ray travels before something stops it. */
function clearRunLength(board: Board): number {
  const dx = DX[board.originDir];
  const dy = DY[board.originDir];
  let x = board.originX;
  let y = board.originY;
  let clear = 0;
  for (let i = 0; i < Math.max(BOARD_W, BOARD_H); i++) {
    x += dx;
    y += dy;
    if (x < 0 || y < 0 || x >= board.w || y >= board.h) break;
    if (board.cells[y * board.w + x] === Cell.Wall) break;
    clear++;
  }
  return clear;
}

function countBoardNodes(board: Board): number {
  let nodes = 0;
  for (let i = 0; i < board.cells.length; i++) {
    if (board.cells[i] === Cell.Node) nodes++;
  }
  return nodes;
}

/**
 * Fast sanity checks used for seed selection. Deliberately cheap: this runs on
 * every client at app start, so it must never call the solver.
 */
export function isStructurallyValid(board: Board): boolean {
  const nodes = countBoardNodes(board);
  if (nodes < MIN_NODES || nodes > MAX_NODES) return false;
  if (clearRunLength(board) < MIN_CLEAR_RUN) return false;
  return nodesAreSpread(board, nodes);
}

/** How many curated boards ship with the app. */
export const CURATED_COUNT: number = CURATED_SEEDS.length;

/**
 * Deterministic seed for a date.
 *
 * Days inside the curated range use a seed the reference solver has already
 * graded, so no player ever meets a flat or unreachable board. Past the end of
 * the table the game degrades to on-the-fly structural selection rather than
 * breaking — a slightly worse puzzle beats no puzzle if an update is missed.
 */
export function dailySeed(date: string): number {
  const n = puzzleNumber(date);
  if (n >= 1 && n <= CURATED_COUNT) {
    return CURATED_SEEDS[n - 1] >>> 0;
  }

  const base = dateToSeed(date);
  for (let i = 0; i < MAX_SEED_ATTEMPTS; i++) {
    const seed = (base + i * 0x9e3779b1) >>> 0;
    if (isStructurallyValid(generateBoard(seed))) return seed;
  }
  return base;
}

/** The board every player in the world sees on a given UTC date. */
export function dailyBoard(date: string): Board {
  return generateBoard(dailySeed(date));
}

/**
 * The best score the reference solver found for a date, or null outside the
 * curated range.
 *
 * Shipped as a table because the solver takes seconds and the phone has none to
 * spare. It is a target, not a proven maximum: a player who beats it has genuinely
 * beaten the machine, and the UI says so rather than pretending the number is a
 * ceiling.
 */
export function dailyPar(date: string): number | null {
  const n = puzzleNumber(date);
  if (n < 1 || n > CURATED_PARS.length) return null;
  return CURATED_PARS[n - 1];
}

/**
 * A score a thinking player can actually reach, unlike {@link dailyPar}.
 *
 * Simulating a population showed the solver's best is out of reach for almost
 * everyone — the median player got 31% of it and nobody matched it — so showing
 * only that number told nearly every player, every day, that they had fallen
 * short. This is measured with a sampling-only budget calibrated against what a
 * "thoughtful" simulated player achieves, and lands near 44% of the record.
 */
export function dailyTarget(date: string): number | null {
  const n = puzzleNumber(date);
  if (n < 1 || n > CURATED_TARGETS.length) return null;
  return CURATED_TARGETS[n - 1];
}

// ---------------------------------------------------------------------------
// Reference solver — server and tooling only
// ---------------------------------------------------------------------------

export interface SolveOptions {
  /** Random placement sets to evaluate per restart. */
  readonly samples?: number;
  /** Hill-climbing steps applied within each restart. */
  readonly climbs?: number;
  /** Independent searches from different random starts. */
  readonly restarts?: number;
  /** Seed for the search itself, so results are reproducible. */
  readonly seed?: number;
}

export interface SolveResult {
  readonly par: number;
  readonly best: Placement[];
  /** Median score of purely random play — the "no idea what I'm doing" baseline. */
  readonly median: number;
  readonly p90: number;
  readonly ignitedAtPar: number;
  readonly totalNodes: number;
  /**
   * How many independent searches landed within 80% of par. A board where only
   * one restart gets close has a single hidden answer; a board where most do
   * has several honest strategies. Percentiles of random sampling cannot measure
   * this — random play never finds a good solution, so its p90 says nothing.
   */
  readonly nearParRoutes: number;
  /**
   * Median score across independent searches — what a player who thinks but does
   * not find the optimum ends up with. The gap between this and par is the skill
   * gradient, and it is the honest measure of whether a board is worth playing.
   */
  readonly medianRoute: number;
  readonly restarts: number;
}

function emptyCells(board: Board): number[] {
  const out: number[] = [];
  const originIndex = board.originY * board.w + board.originX;
  for (let i = 0; i < board.cells.length; i++) {
    if (board.cells[i] === Cell.Empty && i !== originIndex) out.push(i);
  }
  return out;
}

function toPlacements(board: Board, cellIdx: number[], inventory: readonly PieceValue[]): Placement[] {
  return cellIdx.map((at, i) => ({
    x: at % board.w,
    y: Math.floor(at / board.w),
    piece: inventory[i],
  }));
}

function scoreOf(board: Board, placements: Placement[]): number {
  try {
    return run(board, placements).score;
  } catch {
    return -1;
  }
}

/**
 * Estimates par by random sampling plus hill climbing. Not exhaustive — the
 * placement space is far too large — but stable enough to grade a board.
 */
/** Candidate cells surveyed per piece slot on each steepest-ascent step. */
const CANDIDATES_PER_SLOT = 14;
/** Consecutive equal-scoring moves allowed before we call it a local optimum. */
const MAX_SIDEWAYS = 4;

interface Search {
  readonly board: Board;
  readonly cells: number[];
  readonly rng: Rng;
}

/** Draws a legal set of distinct cells for one candidate solution. */
function pickDistinct(search: Search): number[] {
  const chosen: number[] = [];
  let guard = 0;
  while (chosen.length < INVENTORY_SIZE && guard < 200) {
    guard++;
    const at = search.cells[search.rng.int(search.cells.length)];
    if (!chosen.includes(at)) chosen.push(at);
  }
  return chosen;
}

/**
 * Steepest ascent from a starting placement.
 *
 * A single random nudge per step gets stuck almost immediately on a board this
 * large, so each step surveys every slot against a batch of candidate cells and
 * takes the best move it finds. Sideways moves are accepted to cross plateaus,
 * which is where most of the good solutions were hiding.
 */
function climb(search: Search, start: number[], startScore: number, steps: number): { cells: number[]; score: number } {
  let cells = start;
  let score = startScore;
  let sideways = 0;

  for (let i = 0; i < steps && cells.length === INVENTORY_SIZE; i++) {
    const move = bestNeighbour(search, cells, score);

    if (move.better) {
      cells = move.better;
      score = move.betterScore;
      sideways = 0;
    } else if (move.equal && sideways < MAX_SIDEWAYS) {
      cells = move.equal;
      sideways++;
    } else {
      break; // a real local optimum
    }
  }
  return { cells, score };
}

/** Surveys single-piece moves and reports the best improvement and a sideways option. */
function bestNeighbour(
  search: Search,
  cells: number[],
  score: number
): { better: number[] | null; betterScore: number; equal: number[] | null } {
  let better: number[] | null = null;
  let betterScore = score;
  let equal: number[] | null = null;

  for (let slot = 0; slot < INVENTORY_SIZE; slot++) {
    for (let k = 0; k < CANDIDATES_PER_SLOT; k++) {
      const candidate = cells.slice();
      candidate[slot] = search.cells[search.rng.int(search.cells.length)];
      if (new Set(candidate).size !== INVENTORY_SIZE) continue;

      const s = scoreOf(search.board, toPlacements(search.board, candidate, search.board.inventory));
      if (s > betterScore) {
        betterScore = s;
        better = candidate;
      } else if (s === score && equal === null) {
        equal = candidate;
      }
    }
  }
  return { better, betterScore, equal };
}

/**
 * Removes pieces that do not earn their place.
 *
 * Now that a run may use fewer than the full inventory, a spare piece is not
 * free: parked in the spark's path it deflects the line and costs points. Any
 * search that always places five would therefore report a par below the real
 * best. Greedy removal is enough — dropping a piece never enables another piece
 * to become useful, so there is no local optimum to escape.
 */
export function prune(board: Board, placements: readonly Placement[]): Placement[] {
  let current = [...placements];
  let best = scoreOf(board, current);

  for (;;) {
    let bestDrop = -1;
    let bestDropScore = best;

    for (let i = 0; i < current.length; i++) {
      if (current.length <= 1) break;
      const candidate = current.filter((_, k) => k !== i);
      const s = scoreOf(board, candidate);
      if (s >= bestDropScore) {
        bestDropScore = s;
        bestDrop = i;
      }
    }

    if (bestDrop < 0) return current;
    current = current.filter((_, k) => k !== bestDrop);
    best = bestDropScore;
  }
}

export function solve(board: Board, opts: SolveOptions = {}): SolveResult {
  const samples = opts.samples ?? 250;
  const climbs = opts.climbs ?? 60;
  const restarts = opts.restarts ?? 10;
  const search: Search = {
    board,
    cells: emptyCells(board),
    rng: createRng(opts.seed ?? 0x5eed),
  };

  const randomScores: number[] = [];
  const routeBests: { score: number; cells: number[] }[] = [];

  for (let r = 0; r < restarts; r++) {
    let localCells: number[] = [];
    let localBest = -1;

    for (let i = 0; i < samples; i++) {
      const chosen = pickDistinct(search);
      if (chosen.length < INVENTORY_SIZE) continue;
      const s = scoreOf(board, toPlacements(board, chosen, board.inventory));
      if (s < 0) continue;
      randomScores.push(s);
      if (s > localBest) {
        localBest = s;
        localCells = chosen;
      }
    }

    const climbed = climb(search, localCells, localBest, climbs);
    if (climbed.cells.length === INVENTORY_SIZE) {
      routeBests.push({ score: climbed.score, cells: climbed.cells });
    }
  }

  routeBests.sort((a, b) => b.score - a.score);
  const par = routeBests.length > 0 ? routeBests[0].score : 0;
  const bestCells = routeBests.length > 0 ? routeBests[0].cells : [];
  const nearParRoutes = routeBests.filter((r) => par > 0 && r.score >= par * 0.8).length;
  const medianRoute = routeBests.length > 0 ? routeBests[Math.floor(routeBests.length / 2)].score : 0;

  randomScores.sort((a, b) => a - b);
  const at = (q: number): number =>
    randomScores.length === 0
      ? 0
      : randomScores[Math.min(randomScores.length - 1, Math.floor(randomScores.length * q))];

  // Drop pieces that cost points, so par reflects what a run can actually reach
  // now that fewer than five placements are legal.
  const best = bestCells.length > 0 ? prune(board, toPlacements(board, bestCells, board.inventory)) : [];
  const parScore = best.length > 0 ? run(board, best).score : 0;
  const ignitedAtPar = best.length > 0 ? run(board, best).ignited : 0;

  return {
    par: Math.max(parScore, 0),
    best,
    median: at(0.5),
    p90: at(0.9),
    ignitedAtPar,
    totalNodes: countBoardNodes(board),
    nearParRoutes,
    medianRoute,
    restarts,
  };
}

export interface BoardGrade {
  readonly good: boolean;
  readonly reasons: string[];
  readonly solution: SolveResult;
  /** What a deliberately weak, fixed-budget search scores. Stands in for a first attempt. */
  readonly casual: number;
}

/**
 * A fixed, small search budget standing in for a player's first honest idea.
 *
 * Grading has to be independent of how hard we searched for par, or the verdict
 * flips whenever the solver gets stronger — which is exactly the trap the earlier
 * "how many restarts reached par" metric fell into. These numbers are frozen; if
 * they change, every previously curated board silently changes meaning.
 */
const CASUAL_BUDGET = { samples: 60, climbs: 8, restarts: 1, seed: 0xca50a1 } as const;

/**
 * The canonical budget for estimating par.
 *
 * The search is stochastic and its variance is real: a different budget can find
 * a par 40% apart on the same board. "Good" therefore only means anything
 * relative to a fixed effort, so curation and the CI gate must use this exact
 * object. Changing it invalidates every curated seed.
 */
export const CURATION_BUDGET = { samples: 300, climbs: 60, restarts: 10, seed: 0x5eed } as const;

/**
 * Grades a board for playability. Used in CI over months of future dates —
 * never at runtime, because it is far too slow and would desync clients.
 */
export function gradeBoard(board: Board, opts: SolveOptions = {}): BoardGrade {
  const solution = solve(board, opts);
  const casual = solve(board, CASUAL_BUDGET).par;
  const reasons: string[] = [];

  if (solution.totalNodes === 0) {
    reasons.push('board has no nodes');
  } else if (solution.ignitedAtPar / solution.totalNodes < 0.4) {
    reasons.push(`par only lights ${solution.ignitedAtPar}/${solution.totalNodes} nodes`);
  }
  if (solution.par <= 0) {
    reasons.push('no scoring solution found');
  }
  // Skill has to matter: aimless play must score clearly worse than a good idea.
  if (solution.par > 0 && solution.median >= solution.par * 0.6) {
    reasons.push(
      `random play reaches ${solution.median} against par ${solution.par} — the board plays itself`
    );
  }
  // There must be a skill gradient: a first attempt should get somewhere, and
  // still leave a clear gap worth a second and third try.
  if (solution.par > 0 && casual < solution.par * 0.25) {
    reasons.push(`a first attempt reaches only ${casual} of par ${solution.par} — too punishing`);
  }
  if (solution.par > 0 && casual > solution.par * 0.85) {
    reasons.push(`a first attempt already reaches ${casual} of par ${solution.par} — no headroom`);
  }

  return { good: reasons.length === 0, reasons, solution, casual };
}
