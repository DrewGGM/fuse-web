/**
 * Canvas renderer for the board and the run.
 *
 * Deliberately not a game framework. The board is a grid, the spark is a point
 * with a trail, and the only expensive effect is additive glow — none of which
 * needs a scene graph or a physics engine. Keeping this hand-written is what
 * lets the whole app stay small enough to stay smooth in a WebView on a cheap
 * phone, which is the project's biggest technical risk.
 *
 * Rendering never mutates game state: it drives @fuse/sim's stepper and draws
 * whatever the simulation says is true.
 */
import {
  Cell,
  Piece,
  createSim,
  run as runSim,
  step,
  type Board,
  type Placement,
  type SimState,
} from '../core/sim/index.js';

export interface Palette {
  readonly id: string;
  readonly name: string;
  /** Trail and glow. */
  readonly spark: string;
  /** The hot core of the spark and the flash when a node lights. */
  readonly hot: string;
  /** A lit node at rest. */
  readonly lit: string;
  /** True for palettes that have to be unlocked or bought. */
  readonly premium: boolean;
}

export const PALETTES: readonly Palette[] = [
  { id: 'ember', name: 'Ascua', spark: '#ffb020', hot: '#fff0c8', lit: '#ff9a1f', premium: false },
  { id: 'plasma', name: 'Plasma', spark: '#4fd0e8', hot: '#e8fbff', lit: '#3fb4c9', premium: false },
  { id: 'bloom', name: 'Floración', spark: '#ff5fa2', hot: '#ffe3f0', lit: '#e6478d', premium: true },
  { id: 'acid', name: 'Ácido', spark: '#9ef01a', hot: '#f2ffd6', lit: '#7cc70e', premium: true },
  { id: 'violet', name: 'Violeta', spark: '#a06bff', hot: '#efe4ff', lit: '#8b4dff', premium: true },
  { id: 'frost', name: 'Escarcha', spark: '#dbe9ff', hot: '#ffffff', lit: '#a9c6f0', premium: true },
];

export function paletteById(id: string): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}

const COLOR = {
  boardBg: '#05090b',
  grid: 'rgba(150, 200, 215, 0.07)',
  wall: '#1b2a30',
  wallEdge: '#243940',
  nodeIdle: '#2b5f6a',
  nodeIdleCore: 'rgba(63, 180, 201, 0.10)',
  origin: '#7d8f95',
  piece: '#d6e6ea',
  pieceGhost: 'rgba(214, 230, 234, 0.30)',
} as const;

interface TrailPoint {
  x: number;
  y: number;
  age: number;
}

interface Flash {
  at: number;
  t: number;
}

/** A set of cells the UI wants to point at, used by the tutorial. */
export interface Highlight {
  readonly cells: readonly { x: number; y: number }[];
  readonly tone: 'spark' | 'cool';
}

export interface PlayHandlers {
  onScore?(score: number, multiplier: number): void;
  onIgnite?(): void;
  onBomb?(): void;
  onDone?(score: number, ignited: number): void;
}

export class BoardView {
  private ctx: CanvasRenderingContext2D;
  private board: Board | null = null;
  private placements: Placement[] = [];
  private palette: Palette = PALETTES[0];

  private cell = 0;
  private ox = 0;
  private oy = 0;
  private dpr = 1;

  private sim: SimState | null = null;
  private trails = new Map<number, TrailPoint[]>();
  private flashes: Flash[] = [];
  private shake = 0;
  private highlight: Highlight | null = null;
  private pulse = 0;

  private raf = 0;
  private acc = 0;
  private lastFrame = 0;
  private tickMs = 40;
  private handlers: PlayHandlers = {};
  private lastScore = 0;

  /** Preview mode draws the board smaller and never animates. */
  private preview = false;
  private reducedMotion = false;

  constructor(private canvas: HTMLCanvasElement, opts: { preview?: boolean } = {}) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is unavailable');
    this.ctx = ctx;
    this.preview = opts.preview ?? false;
  }

  setPalette(p: Palette): void {
    this.palette = p;
    if (!this.isPlaying()) this.draw();
  }

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
  }

  /**
   * Marks cells with a slow pulse. Drives its own animation frame when the
   * simulation is not running, so a highlight is visible on a still board.
   */
  setHighlight(highlight: Highlight | null): void {
    this.highlight = highlight;
    if (highlight && !this.isPlaying()) this.startPulse();
    else if (!highlight && !this.isPlaying()) {
      this.stop();
      this.draw();
    }
  }

  private startPulse(): void {
    if (this.raf) return;
    const frame = (now: number): void => {
      this.pulse = now;
      this.draw();
      if (this.highlight && !this.sim) this.raf = requestAnimationFrame(frame);
      else this.raf = 0;
    };
    this.raf = requestAnimationFrame(frame);
  }

  setBoard(board: Board): void {
    this.board = board;
    this.placements = [];
    this.reset();
    this.resize();
  }

  setPlacements(placements: Placement[]): void {
    this.placements = placements;
    if (!this.isPlaying()) this.draw();
  }

  isPlaying(): boolean {
    return this.raf !== 0;
  }

  /** Recomputes cell size for the current CSS box. Call on resize and orientation change. */
  resize(): void {
    const board = this.board;
    if (!board) return;

    const parent = this.canvas.parentElement;
    const availW = parent?.clientWidth ?? this.canvas.clientWidth ?? 320;
    const availH = parent?.clientHeight ?? this.canvas.clientHeight ?? 480;
    if (availW <= 0 || availH <= 0) return;

    const pad = this.preview ? 6 : 10;
    const cell = Math.floor(Math.min((availW - pad * 2) / board.w, (availH - pad * 2) / board.h));
    this.cell = Math.max(cell, 6);

    const cssW = this.cell * board.w + pad * 2;
    const cssH = this.cell * board.h + pad * 2;
    this.ox = pad;
    this.oy = pad;

    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.draw();
  }

  /** Maps a pointer position to a board cell, or null if it missed. */
  cellAt(clientX: number, clientY: number): { x: number; y: number } | null {
    const board = this.board;
    if (!board || this.cell <= 0) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((clientX - rect.left - this.ox) / this.cell);
    const y = Math.floor((clientY - rect.top - this.oy) / this.cell);
    if (x < 0 || y < 0 || x >= board.w || y >= board.h) return null;
    return { x, y };
  }

  reset(): void {
    this.stop();
    this.sim = null;
    this.trails.clear();
    this.flashes = [];
    this.shake = 0;
    this.lastScore = 0;
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /**
   * Animates a run. The pace is chosen from the real tick count so that every
   * run lands in roughly the same wall-clock window — a five-second clip is
   * shareable, a forty-second one is not.
   */
  play(placements: Placement[], handlers: PlayHandlers = {}): void {
    const board = this.board;
    if (!board) return;

    this.reset();
    this.placements = placements;
    this.handlers = handlers;
    this.sim = createSim(board, placements);

    const total = runSim(board, placements).ticks;
    const targetSeconds = 4.2;
    this.tickMs = Math.min(Math.max((targetSeconds * 1000) / Math.max(total, 1), 9), 70);

    this.acc = 0;
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    const dt = Math.min(now - this.lastFrame, 120);
    this.lastFrame = now;
    this.acc += dt;

    const sim = this.sim;
    if (sim) {
      let guard = 0;
      while (this.acc >= this.tickMs && !sim.done && guard < 24) {
        this.acc -= this.tickMs;
        guard++;
        this.advance(sim);
      }
    }

    this.ageEffects(dt);
    this.draw();

    if (sim && sim.done && this.trailsEmpty() && this.flashes.length === 0) {
      this.stop();
      this.handlers.onDone?.(sim.score, sim.ignitedCount);
      return;
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  /** One simulation tick plus the presentation state that hangs off it. */
  private advance(sim: SimState): void {
    const before = sim.ignitedCount;
    const bombsBefore = this.countBombsHit(sim);

    step(sim);

    for (const s of sim.sparks) {
      if (!s.alive) continue;
      const trail = this.trails.get(s.id) ?? [];
      trail.push({ x: s.x, y: s.y, age: 0 });
      if (trail.length > 22) trail.shift();
      this.trails.set(s.id, trail);
    }

    const gained = sim.ignitedCount - before;
    if (gained > 0) {
      this.handlers.onIgnite?.();
      for (let i = 0; i < sim.ignited.length; i++) {
        if (sim.ignited[i] === 1 && !this.flashes.some((f) => f.at === i)) {
          this.flashes.push({ at: i, t: 1 });
        }
      }
    }

    if (sim.score !== this.lastScore) {
      this.lastScore = sim.score;
      this.handlers.onScore?.(sim.score, sim.multiplier);
    }

    if (this.countBombsHit(sim) > bombsBefore) {
      this.handlers.onBomb?.();
      if (!this.reducedMotion) this.shake = 1;
    }
  }

  /** Bombs consume their spark, so a dead spark standing on a bomb means it fired. */
  private countBombsHit(sim: SimState): number {
    const board = this.board;
    if (!board) return 0;
    let n = 0;
    for (const s of sim.sparks) {
      if (s.alive) continue;
      if (sim.pieces[s.y * board.w + s.x] === Piece.Bomb) n++;
    }
    return n;
  }

  private ageEffects(dt: number): void {
    const decay = dt / 260;
    for (const [id, trail] of this.trails) {
      for (const p of trail) p.age += decay;
      const kept = trail.filter((p) => p.age < 1);
      if (kept.length === 0) this.trails.delete(id);
      else this.trails.set(id, kept);
    }
    this.flashes = this.flashes.filter((f) => (f.t -= dt / 420) > 0);
    this.shake = Math.max(0, this.shake - dt / 260);
  }

  private trailsEmpty(): boolean {
    return this.trails.size === 0;
  }

  // ---------------------------------------------------------------- drawing

  private cx(x: number): number {
    return this.ox + x * this.cell + this.cell / 2;
  }
  private cy(y: number): number {
    return this.oy + y * this.cell + this.cell / 2;
  }

  draw(): void {
    const board = this.board;
    const ctx = this.ctx;
    if (!board || this.cell <= 0) return;

    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;

    ctx.save();
    if (this.shake > 0) {
      const s = this.shake * this.shake * 5;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }

    ctx.fillStyle = COLOR.boardBg;
    ctx.fillRect(-8, -8, w + 16, h + 16);

    this.drawGrid(board);
    this.drawWalls(board);
    this.drawNodes(board);
    this.drawOrigin(board);
    this.drawPieces();
    this.drawHighlight();
    this.drawTrails();
    this.drawSparks();

    ctx.restore();
  }

  private drawGrid(board: Board): void {
    const ctx = this.ctx;
    const r = Math.max(1, this.cell * 0.045);
    ctx.fillStyle = COLOR.grid;
    for (let y = 0; y < board.h; y++) {
      for (let x = 0; x < board.w; x++) {
        if (board.cells[y * board.w + x] !== Cell.Empty) continue;
        ctx.beginPath();
        ctx.arc(this.cx(x), this.cy(y), r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawWalls(board: Board): void {
    const ctx = this.ctx;
    const inset = this.cell * 0.08;
    const size = this.cell - inset * 2;
    const radius = Math.max(2, this.cell * 0.16);

    for (let y = 0; y < board.h; y++) {
      for (let x = 0; x < board.w; x++) {
        if (board.cells[y * board.w + x] !== Cell.Wall) continue;
        const px = this.ox + x * this.cell + inset;
        const py = this.oy + y * this.cell + inset;
        ctx.fillStyle = COLOR.wall;
        ctx.strokeStyle = COLOR.wallEdge;
        ctx.lineWidth = 1;
        this.roundRect(px, py, size, size, radius);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  private drawNodes(board: Board): void {
    const ctx = this.ctx;
    const sim = this.sim;
    const r = this.cell * 0.29;

    for (let y = 0; y < board.h; y++) {
      for (let x = 0; x < board.w; x++) {
        const at = y * board.w + x;
        if (board.cells[at] !== Cell.Node) continue;

        const px = this.cx(x);
        const py = this.cy(y);
        const lit = sim ? sim.ignited[at] === 1 : false;
        const flash = this.flashes.find((f) => f.at === at)?.t ?? 0;

        if (lit) {
          const glow = r * (2.6 + flash * 2.2);
          const grad = ctx.createRadialGradient(px, py, 0, px, py, glow);
          grad.addColorStop(0, this.alpha(this.palette.spark, 0.5 + flash * 0.45));
          grad.addColorStop(1, this.alpha(this.palette.spark, 0));
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(px, py, glow, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = flash > 0.5 ? this.palette.hot : this.palette.lit;
          ctx.beginPath();
          ctx.arc(px, py, r * (1 + flash * 0.5), 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = COLOR.nodeIdleCore;
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fill();

          ctx.strokeStyle = COLOR.nodeIdle;
          ctx.lineWidth = Math.max(1.2, this.cell * 0.055);
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
  }

  private drawOrigin(board: Board): void {
    const ctx = this.ctx;
    const px = this.cx(board.originX);
    const py = this.cy(board.originY);
    const s = this.cell * 0.3;
    const angle = [(-Math.PI) / 2, 0, Math.PI / 2, Math.PI][board.originDir];

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);
    ctx.strokeStyle = this.sim ? this.palette.spark : COLOR.origin;
    ctx.fillStyle = this.sim ? this.palette.spark : COLOR.origin;
    ctx.lineWidth = Math.max(1.4, this.cell * 0.07);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(-s * 0.75, -s * 0.7);
    ctx.lineTo(s * 0.7, 0);
    ctx.lineTo(-s * 0.75, s * 0.7);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  private drawPieces(): void {
    for (const p of this.placements) {
      drawPieceGlyph(this.ctx, p.piece, this.cx(p.x), this.cy(p.y), this.cell * 0.62, COLOR.piece);
    }
  }

  private drawHighlight(): void {
    const h = this.highlight;
    if (!h) return;
    const ctx = this.ctx;

    // A 1.6s breath. Slow enough to read as "look here" rather than an alarm.
    const phase = this.reducedMotion ? 0.6 : (Math.sin(this.pulse / 255) + 1) / 2;
    const color = h.tone === 'spark' ? this.palette.spark : COLOR.nodeIdle;

    ctx.save();
    ctx.lineWidth = Math.max(2, this.cell * 0.09);
    ctx.strokeStyle = this.alpha(color, 0.35 + phase * 0.55);
    const inset = this.cell * 0.1;
    const size = this.cell - inset * 2;
    for (const c of h.cells) {
      const px = this.ox + c.x * this.cell + inset;
      const py = this.oy + c.y * this.cell + inset;
      this.roundRect(px, py, size, size, Math.max(3, this.cell * 0.2));
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawTrails(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const trail of this.trails.values()) {
      for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1];
        const b = trail[i];
        const life = 1 - b.age;
        if (life <= 0) continue;
        ctx.strokeStyle = this.alpha(this.palette.spark, life * 0.5);
        ctx.lineWidth = this.cell * 0.3 * life;
        ctx.beginPath();
        ctx.moveTo(this.cx(a.x), this.cy(a.y));
        ctx.lineTo(this.cx(b.x), this.cy(b.y));
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawSparks(): void {
    const sim = this.sim;
    if (!sim) return;
    const ctx = this.ctx;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const s of sim.sparks) {
      if (!s.alive) continue;
      const px = this.cx(s.x);
      const py = this.cy(s.y);

      const glow = this.cell * 1.15;
      const grad = ctx.createRadialGradient(px, py, 0, px, py, glow);
      grad.addColorStop(0, this.alpha(this.palette.hot, 0.85));
      grad.addColorStop(0.35, this.alpha(this.palette.spark, 0.45));
      grad.addColorStop(1, this.alpha(this.palette.spark, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, glow, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = this.palette.hot;
      ctx.beginPath();
      ctx.arc(px, py, this.cell * 0.16, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** `#rrggbb` plus an alpha, without pulling in a colour library. */
  private alpha(hex: string, a: number): string {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, a))})`;
  }
}

/**
 * Draws a piece glyph. Shared by the board, the tray and the how-to-play guide
 * so a piece never looks like two different things in two places.
 */
export function drawPieceGlyph(
  ctx: CanvasRenderingContext2D,
  piece: number,
  cx: number,
  cy: number,
  size: number,
  color: string
): void {
  const h = size / 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.6, size * 0.13);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (piece) {
    case Piece.MirrorA: // '/'
      ctx.beginPath();
      ctx.moveTo(cx - h * 0.8, cy + h * 0.8);
      ctx.lineTo(cx + h * 0.8, cy - h * 0.8);
      ctx.stroke();
      break;

    case Piece.MirrorB: // '\'
      ctx.beginPath();
      ctx.moveTo(cx - h * 0.8, cy - h * 0.8);
      ctx.lineTo(cx + h * 0.8, cy + h * 0.8);
      ctx.stroke();
      break;

    case Piece.Splitter: {
      ctx.beginPath();
      ctx.moveTo(cx, cy + h * 0.85);
      ctx.lineTo(cx, cy);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx - h * 0.8, cy - h * 0.75);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + h * 0.8, cy - h * 0.75);
      ctx.stroke();
      break;
    }

    case Piece.Boost:
      ctx.beginPath();
      ctx.moveTo(cx - h * 0.8, cy);
      ctx.lineTo(cx + h * 0.8, cy);
      ctx.moveTo(cx, cy - h * 0.8);
      ctx.lineTo(cx, cy + h * 0.8);
      ctx.stroke();
      break;

    case Piece.Bomb: {
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * h * 0.28, cy + Math.sin(a) * h * 0.28);
        ctx.lineTo(cx + Math.cos(a) * h * 0.85, cy + Math.sin(a) * h * 0.85);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(cx, cy, h * 0.2, 0, Math.PI * 2);
      ctx.fill();
      break;
    }

    default:
      break;
  }
  ctx.restore();
}

export const PIECE_NAMES: Record<number, { name: string; blurb: string }> = {
  [Piece.MirrorA]: { name: 'Espejo /', blurb: 'Gira la chispa 90 grados.' },
  [Piece.MirrorB]: { name: 'Espejo \\', blurb: 'Gira la chispa 90 grados, al otro lado.' },
  [Piece.Splitter]: { name: 'Divisor', blurb: 'Parte la chispa en dos. Cada mitad se queda con la mitad de la energía.' },
  [Piece.Boost]: { name: 'Recarga', blurb: 'Devuelve la energía al máximo. Se gasta al primer uso.' },
  [Piece.Bomb]: { name: 'Carga', blurb: 'Enciende todo lo que tenga a dos casillas y apaga la chispa.' },
};
