/**
 * @fuse/sim — the deterministic chain-reaction simulation.
 *
 * This module is the single definition of what a valid run is. The client renders
 * it and the server re-runs it to validate submitted scores, so the two MUST agree
 * bit for bit. Everything here is integer arithmetic on typed arrays.
 *
 * Hard rules — breaking any of these breaks leaderboard integrity (see ADR-002):
 *   - No floating point anywhere in the step function.
 *   - No Math.random, Date, or any ambient state.
 *   - No Math.sin/cos/tan/pow — engine implementations may differ.
 *   - No iteration over Map/Set/object keys; ordering must come from arrays.
 *   - Zero runtime dependencies.
 */

// ---------------------------------------------------------------------------
// Domain constants
// ---------------------------------------------------------------------------

/** Cell contents of the static board. */
export const Cell = {
  Empty: 0,
  Wall: 1,
  Node: 2,
} as const;
export type CellValue = (typeof Cell)[keyof typeof Cell];

/** Pieces the player lays down before lighting the fuse. */
export const Piece = {
  None: 0,
  /** `/` — reflects a ray about the bottom-left/top-right diagonal. */
  MirrorA: 1,
  /** `\` — reflects a ray about the top-left/bottom-right diagonal. */
  MirrorB: 2,
  /** Splits one spark into two, turning left and right. Each keeps half the energy. */
  Splitter: 3,
  /** Refills a spark's energy to full. One shot: it burns out after the first use. */
  Boost: 4,
  /** Ignites every node within Chebyshev radius 2, then consumes the spark. */
  Bomb: 5,
} as const;
export type PieceValue = (typeof Piece)[keyof typeof Piece];

/** All pieces that can appear in a daily inventory, in canonical order. */
export const PLAYABLE_PIECES: readonly PieceValue[] = [
  Piece.MirrorA,
  Piece.MirrorB,
  Piece.Splitter,
  Piece.Boost,
  Piece.Bomb,
];

/** Direction indices. dx/dy tables below must stay in this order. */
export const Dir = { Up: 0, Right: 1, Down: 2, Left: 3 } as const;
export type DirValue = (typeof Dir)[keyof typeof Dir];

const DX = [0, 1, 0, -1] as const;
const DY = [-1, 0, 1, 0] as const;

/** `/` reflection table, indexed by incoming direction. */
const MIRROR_A_OUT = [Dir.Right, Dir.Up, Dir.Left, Dir.Down] as const;
/** `\` reflection table, indexed by incoming direction. */
const MIRROR_B_OUT = [Dir.Left, Dir.Down, Dir.Right, Dir.Up] as const;

/** Points awarded per node, before the combo multiplier. */
export const NODE_VALUE = 100;
/** The combo multiplier resets if this many ticks pass with no ignition. */
export const COMBO_WINDOW = 14;
/** Ceiling on the combo multiplier, so a lucky board can't run away with the score. */
export const MAX_MULTIPLIER = 9;
/** Blast radius of a Bomb, in Chebyshev distance. */
export const BOMB_RADIUS = 2;

/** Hard caps. These bound server CPU per submission and keep the sim total. */
export const MAX_TICKS = 1200;
export const MAX_SPARKS = 24;
/** How many pieces the daily inventory deals. */
export const INVENTORY_SIZE = 5;
/**
 * The smallest legal run.
 *
 * The rule used to be "place all five". That quietly told players there was a
 * single correct arrangement in which every piece mattered — and on most boards
 * two or three do all the work, so people hunted for a fit that did not exist.
 * A run now needs at least one piece and at most the whole inventory.
 */
export const MIN_PLACEMENTS = 1;

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

export interface Board {
  readonly w: number;
  readonly h: number;
  /** Length `w * h`, row-major, values from `Cell`. */
  readonly cells: Uint8Array;
  readonly originX: number;
  readonly originY: number;
  readonly originDir: DirValue;
  /** Starting energy of the first spark, in steps. */
  readonly energy: number;
  /** The five pieces the player may place today. */
  readonly inventory: readonly PieceValue[];
}

export interface Placement {
  readonly x: number;
  readonly y: number;
  readonly piece: PieceValue;
}

export interface Spark {
  x: number;
  y: number;
  dir: DirValue;
  energy: number;
  alive: boolean;
  /** Stable identity so the renderer can keep a trail per spark. */
  id: number;
}

export interface SimState {
  readonly board: Board;
  /** Piece overlay, length `w * h`, values from `Piece`. */
  readonly pieces: Uint8Array;
  /** 1 once a Boost cell has been spent. */
  readonly spent: Uint8Array;
  /** 1 once a node has been ignited. */
  readonly ignited: Uint8Array;
  readonly sparks: Spark[];
  tick: number;
  score: number;
  multiplier: number;
  ignitedCount: number;
  lastIgniteTick: number;
  nextSparkId: number;
  done: boolean;
  /** Rolling FNV-1a hash of every step. Two engines that agree produce the same value. */
  checksum: number;
}

export interface RunResult {
  readonly score: number;
  readonly ignited: number;
  readonly totalNodes: number;
  readonly ticks: number;
  readonly checksum: number;
}

// ---------------------------------------------------------------------------
// Errors — validation is part of the contract, not an afterthought
// ---------------------------------------------------------------------------

export class InvalidPlacementError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'WRONG_COUNT'
      | 'OUT_OF_BOUNDS'
      | 'NOT_EMPTY'
      | 'DUPLICATE_CELL'
      | 'INVENTORY_MISMATCH'
      | 'ON_ORIGIN'
  ) {
    super(message);
    this.name = 'InvalidPlacementError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function idx(board: Board, x: number, y: number): number {
  return y * board.w + x;
}

export function inBounds(board: Board, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < board.w && y < board.h;
}

export function countNodes(board: Board): number {
  let n = 0;
  for (let i = 0; i < board.cells.length; i++) {
    if (board.cells[i] === Cell.Node) n++;
  }
  return n;
}

/** FNV-1a, 32-bit. Pure integer maths, identical in every JS engine. */
function hashStep(h: number, v: number): number {
  h ^= v | 0;
  // h * 16777619 without overflowing into float territory
  h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) | 0;
  return h;
}

/**
 * Rejects a placement set that isn't legal, with a specific reason.
 * Called by both the client (to disable the launch button) and the server
 * (to reject a crafted submission) — same rules, one implementation.
 */
export function validatePlacements(board: Board, placements: readonly Placement[]): void {
  if (placements.length < MIN_PLACEMENTS || placements.length > board.inventory.length) {
    throw new InvalidPlacementError(
      `Expected between ${MIN_PLACEMENTS} and ${board.inventory.length} placements, received ${placements.length}`,
      'WRONG_COUNT'
    );
  }

  const seen = new Set<number>();
  for (const p of placements) {
    if (!Number.isInteger(p.x) || !Number.isInteger(p.y) || !inBounds(board, p.x, p.y)) {
      throw new InvalidPlacementError(`Placement (${p.x}, ${p.y}) is off the board`, 'OUT_OF_BOUNDS');
    }
    if (board.cells[idx(board, p.x, p.y)] !== Cell.Empty) {
      throw new InvalidPlacementError(
        `Cell (${p.x}, ${p.y}) is not empty`,
        'NOT_EMPTY'
      );
    }
    if (p.x === board.originX && p.y === board.originY) {
      throw new InvalidPlacementError('Cannot build on the spark origin', 'ON_ORIGIN');
    }
    const key = idx(board, p.x, p.y);
    if (seen.has(key)) {
      throw new InvalidPlacementError(`Two pieces on cell (${p.x}, ${p.y})`, 'DUPLICATE_CELL');
    }
    seen.add(key);
  }

  // Placed pieces must be drawn from today's inventory — a sub-multiset of it.
  // Using two mirrors is fine; conjuring a third one is not.
  const available = countByPiece(board.inventory);
  const used = countByPiece(placements.map((p) => p.piece));
  for (let i = 0; i < available.length; i++) {
    if (used[i] > available[i]) {
      throw new InvalidPlacementError(
        'Placed pieces are not available in the daily inventory',
        'INVENTORY_MISMATCH'
      );
    }
  }
}

function countByPiece(pieces: readonly PieceValue[]): number[] {
  const counts = [0, 0, 0, 0, 0, 0];
  for (const p of pieces) {
    if (p < 0 || p > 5) {
      throw new InvalidPlacementError(`Unknown piece ${p}`, 'INVENTORY_MISMATCH');
    }
    counts[p]++;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/**
 * Builds the initial state. Validates placements first — an invalid set throws
 * rather than producing a score, so no caller can accidentally accept one.
 */
export function createSim(board: Board, placements: readonly Placement[]): SimState {
  validatePlacements(board, placements);

  const size = board.w * board.h;
  const pieces = new Uint8Array(size);
  for (const p of placements) {
    pieces[idx(board, p.x, p.y)] = p.piece;
  }

  return {
    board,
    pieces,
    spent: new Uint8Array(size),
    ignited: new Uint8Array(size),
    sparks: [
      {
        x: board.originX,
        y: board.originY,
        dir: board.originDir,
        energy: board.energy,
        alive: true,
        id: 0,
      },
    ],
    tick: 0,
    score: 0,
    multiplier: 1,
    ignitedCount: 0,
    lastIgniteTick: 0,
    nextSparkId: 1,
    done: false,
    checksum: 0x811c9dc5 | 0,
  };
}

/** Ignites a node cell if it is not already lit, awarding score at the current multiplier. */
function ignite(state: SimState, cellIndex: number): void {
  if (state.board.cells[cellIndex] !== Cell.Node) return;
  if (state.ignited[cellIndex] === 1) return;

  state.ignited[cellIndex] = 1;
  state.ignitedCount++;
  state.score += NODE_VALUE * state.multiplier;
  state.lastIgniteTick = state.tick;
  if (state.multiplier < MAX_MULTIPLIER) state.multiplier++;
}

/** Detonates a bomb: lights every node within `BOMB_RADIUS`, scanned in row-major order. */
function detonate(state: SimState, cx: number, cy: number): void {
  const { board } = state;
  for (let y = cy - BOMB_RADIUS; y <= cy + BOMB_RADIUS; y++) {
    for (let x = cx - BOMB_RADIUS; x <= cx + BOMB_RADIUS; x++) {
      if (!inBounds(board, x, y)) continue;
      ignite(state, idx(board, x, y));
    }
  }
}

/**
 * Applies whatever piece the spark just landed on.
 *
 * Split out of `step` so the movement loop stays readable, but the ordering
 * contract is unchanged: the piece acts after ignition and before the checksum,
 * and a split appends to `sparks` so the new spark moves from the next tick on.
 */
function applyPiece(state: SimState, s: Spark, at: number): void {
  const { board, sparks } = state;

  switch (state.pieces[at]) {
    case Piece.MirrorA:
      s.dir = MIRROR_A_OUT[s.dir];
      return;

    case Piece.MirrorB:
      s.dir = MIRROR_B_OUT[s.dir];
      return;

    case Piece.Splitter: {
      const half = s.energy >> 1;
      // Not enough left to divide, or we're at the spark ceiling: pass straight through.
      if (half <= 0 || sparks.length >= MAX_SPARKS) return;

      const incoming = s.dir;
      s.energy = half;
      s.dir = ((incoming + 3) & 3) as DirValue; // turn left
      sparks.push({
        x: s.x,
        y: s.y,
        dir: ((incoming + 1) & 3) as DirValue, // turn right
        energy: half,
        alive: true,
        id: state.nextSparkId++,
      });
      return;
    }

    case Piece.Boost:
      if (state.spent[at] === 0) {
        state.spent[at] = 1;
        s.energy = board.energy;
      }
      return;

    case Piece.Bomb:
      detonate(state, s.x, s.y);
      s.alive = false;
      return;

    default:
      return;
  }
}

/**
 * Advances the simulation by exactly one tick.
 *
 * Sparks move in array order and newly split sparks are appended, so the
 * traversal order is fully determined by the input. That ordering is load-bearing:
 * change it and previously submitted scores stop reproducing.
 */
export function step(state: SimState): void {
  if (state.done) return;

  const { board, sparks } = state;
  state.tick++;

  // Combo decay. Checked once per tick, before any movement, so it cannot depend
  // on how many sparks happen to be alive.
  if (state.multiplier > 1 && state.tick - state.lastIgniteTick > COMBO_WINDOW) {
    state.multiplier = 1;
  }

  // Snapshot the length: sparks appended this tick move from the next tick on.
  const count = sparks.length;
  for (let i = 0; i < count; i++) {
    const s = sparks[i];
    if (!s.alive) continue;

    s.energy--;
    if (s.energy <= 0) {
      s.alive = false;
      state.checksum = hashStep(state.checksum, (state.tick << 8) ^ (s.id << 3) ^ 0x7f);
      continue;
    }

    const nx = s.x + DX[s.dir];
    const ny = s.y + DY[s.dir];

    if (!inBounds(board, nx, ny)) {
      s.alive = false;
      state.checksum = hashStep(state.checksum, (state.tick << 8) ^ (s.id << 3) ^ 0x3b);
      continue;
    }

    const at = idx(board, nx, ny);
    if (board.cells[at] === Cell.Wall) {
      s.alive = false;
      state.checksum = hashStep(state.checksum, (state.tick << 8) ^ (s.id << 3) ^ 0x1d);
      continue;
    }

    s.x = nx;
    s.y = ny;

    ignite(state, at);
    applyPiece(state, s, at);

    state.checksum = hashStep(
      state.checksum,
      (state.tick << 16) ^ (s.id << 12) ^ (s.x << 7) ^ (s.y << 2) ^ s.dir
    );
  }

  // Termination: no survivors, or the hard tick cap.
  let anyAlive = false;
  for (let i = 0; i < sparks.length; i++) {
    if (sparks[i].alive) {
      anyAlive = true;
      break;
    }
  }
  if (!anyAlive || state.tick >= MAX_TICKS) {
    state.done = true;
    state.checksum = hashStep(state.checksum, state.score);
    state.checksum = hashStep(state.checksum, state.ignitedCount);
  }
}

/** Runs a placement set to completion. This is what the server calls to validate. */
export function run(board: Board, placements: readonly Placement[]): RunResult {
  const state = createSim(board, placements);
  while (!state.done) step(state);
  return {
    score: state.score,
    ignited: state.ignitedCount,
    totalNodes: countNodes(board),
    ticks: state.tick,
    checksum: state.checksum >>> 0,
  };
}
