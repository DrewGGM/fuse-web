/**
 * First-run tutorial.
 *
 * Written after watching someone open the game and ask how to "solve" the first
 * level. Fuse has no win condition — you place pieces, you get a score — but
 * nothing on screen said so, and a grid of dots reads like a puzzle with one
 * right answer. This teaches three things in about twenty seconds:
 *
 *   1. where the spark comes from and that it travels in straight lines
 *   2. that nodes light on contact, and chaining them is worth more
 *   3. that pieces are optional tools, not slots to fill
 *
 * It uses a hand-built board rather than a real daily, so the outcome is known
 * and the wording can be specific about what is going to happen.
 */
import { Cell, Dir, Piece, type Board, type Placement } from '../core/sim/index.js';
import { BoardView, drawPieceGlyph } from './board-view.js';

const W = 7;
// Sized to the lesson and nothing more. It was 9 rows deep, which left four
// empty ones under the action and shrank everything that mattered.
const H = 6;

/**
 * A board with exactly one obvious move.
 *
 *      0 1 2 3 4 5 6
 *   0  . . . o . . .
 *   1  . . . o . . .
 *   2  . . . o . . .
 *   3  . . . o . . .
 *   4  > . . _ . . .     mirror goes here; the spark turns up the column
 */
export function tutorialBoard(): Board {
  const cells = new Uint8Array(W * H);
  for (let y = 0; y <= 3; y++) cells[y * W + 3] = Cell.Node;

  return {
    w: W,
    h: H,
    cells,
    originX: 0,
    originY: 4,
    originDir: Dir.Right,
    energy: 60,
    // One mirror is all the tutorial deals. Handing over five would teach
    // exactly the wrong lesson on the very first screen.
    inventory: [Piece.MirrorA],
  };
}

export const TARGET: Placement = { x: 3, y: 4, piece: Piece.MirrorA };

export interface TutorialStep {
  readonly text: string;
  /** Show the piece card under the text. */
  readonly showPiece?: boolean;
  /** Wait for the player to tap the target cell instead of pressing Next. */
  readonly awaitPlacement?: boolean;
  /** Run the simulation when entering this step. */
  readonly play?: boolean;
  readonly nextLabel?: string;
}

export const STEPS: readonly TutorialStep[] = [
  {
    text: 'La chispa sale de aquí y viaja en línea recta hasta que se queda sin energía.',
    nextLabel: 'Entendido',
  },
  {
    text: 'Estos son los nodos. Se encienden cuando la chispa pasa por encima, y cada uno seguido vale más que el anterior.',
    nextLabel: 'Vale',
  },
  {
    text: 'Tienes un espejo. Colócalo en la casilla que parpadea para desviar la chispa hacia la columna.',
    showPiece: true,
    awaitPlacement: true,
    nextLabel: 'Coloca el espejo',
  },
  {
    text: 'Ahora enciéndela.',
    nextLabel: 'Encender',
  },
  {
    text: 'Eso es todo. No hay una solución correcta que encontrar: colocas lo que quieras y persigues la puntuación más alta. No hace falta usar todas las piezas.',
    play: true,
    nextLabel: 'Jugar el reto de hoy',
  },
];

export interface TutorialHandlers {
  onFinish(): void;
  onIgnite?(): void;
  onScore?(score: number): void;
}

/**
 * Drives the tutorial. Owns its own BoardView so it cannot disturb the real
 * game's render state.
 */
export class Tutorial {
  private view: BoardView;
  private board = tutorialBoard();
  private placed: Placement[] = [];
  private index = 0;

  constructor(
    canvas: HTMLCanvasElement,
    private els: {
      step: HTMLElement;
      text: HTMLElement;
      piece: HTMLElement;
      pieceCanvas: HTMLCanvasElement;
      pieceName: HTMLElement;
      next: HTMLButtonElement;
      skip: HTMLElement;
    },
    private handlers: TutorialHandlers
  ) {
    this.view = new BoardView(canvas);
    this.view.setBoard(this.board);

    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.onTap(e.clientX, e.clientY);
    });
  }

  get current(): TutorialStep {
    return STEPS[this.index];
  }

  start(): void {
    this.index = 0;
    this.placed = [];
    this.view.setBoard(this.board);
    this.view.setPlacements([]);
    this.render();
  }

  resize(): void {
    this.view.resize();
    this.highlight();
  }

  next(): void {
    if (this.index >= STEPS.length - 1) {
      this.handlers.onFinish();
      return;
    }
    this.index++;
    this.render();

    if (this.current.play) {
      this.view.play(this.placed, {
        onIgnite: () => this.handlers.onIgnite?.(),
        onScore: (score) => this.handlers.onScore?.(score),
      });
    }
  }

  private onTap(clientX: number, clientY: number): void {
    if (!this.current.awaitPlacement) return;
    const cell = this.view.cellAt(clientX, clientY);
    if (!cell) return;

    if (cell.x !== TARGET.x || cell.y !== TARGET.y) {
      // Deliberately forgiving: nudge rather than scold, and never block progress.
      this.els.text.textContent = 'Casi. Colócalo en la casilla que parpadea, justo debajo de la columna de nodos.';
      return;
    }

    this.placed = [TARGET];
    this.view.setPlacements(this.placed);
    this.view.setHighlight(null);
    this.next();
  }

  private render(): void {
    const step = this.current;
    this.els.step.textContent = `${this.index + 1} / ${STEPS.length}`;
    this.els.text.textContent = step.text;
    this.els.next.textContent = step.nextLabel ?? 'Siguiente';
    this.els.next.hidden = step.awaitPlacement === true;
    // Skipping is only meaningful while there is something left to skip.
    this.els.skip.hidden = this.index === STEPS.length - 1;

    this.els.piece.hidden = step.showPiece !== true;
    if (step.showPiece) {
      const ctx = this.els.pieceCanvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, 80, 80);
        drawPieceGlyph(ctx, Piece.MirrorA, 40, 40, 50, '#d6e6ea');
      }
      this.els.pieceName.textContent = 'Espejo';
    }

    this.highlight();
  }

  /** Points the player at whatever the current step is talking about. */
  private highlight(): void {
    const step = this.current;
    if (this.index === 0) {
      this.view.setHighlight({ cells: [{ x: this.board.originX, y: this.board.originY }], tone: 'spark' });
    } else if (this.index === 1) {
      const nodes: { x: number; y: number }[] = [];
      for (let i = 0; i < this.board.cells.length; i++) {
        if (this.board.cells[i] === Cell.Node) {
          nodes.push({ x: i % this.board.w, y: Math.floor(i / this.board.w) });
        }
      }
      this.view.setHighlight({ cells: nodes, tone: 'cool' });
    } else if (step.awaitPlacement) {
      this.view.setHighlight({ cells: [{ x: TARGET.x, y: TARGET.y }], tone: 'spark' });
    } else {
      this.view.setHighlight(null);
    }
  }

  stop(): void {
    this.view.reset();
  }
}
