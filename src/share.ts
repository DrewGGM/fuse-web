/**
 * Share text and clip export.
 *
 * The share card is the growth engine, so it gets the same care as the game.
 * Two hard rules:
 *   - It must never reveal the solution. A share that spoils the puzzle stops
 *     the person who receives it from playing, which is the opposite of the point.
 *   - It must be legible as plain text in any chat app, with no image required.
 */
import { NODE_VALUE, type Board } from '../core/sim/index.js';
import { puzzleNumber } from '../core/gen/index.js';
import { formatScore } from './format.js';

export interface ShareInput {
  readonly date: string;
  readonly score: number;
  readonly ignited: number;
  readonly totalNodes: number;
  readonly attempts: number;
  readonly maxAttempts: number;
}

/**
 * Builds the spoiler-free summary.
 *
 * The bar encodes how much of the board was lit, not where — you can see someone
 * did well without learning a single placement.
 */
export function shareText(input: ShareInput): string {
  const n = puzzleNumber(input.date);
  const filled = input.totalNodes > 0 ? Math.round((input.ignited / input.totalNodes) * 10) : 0;
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const tries = '◆'.repeat(input.attempts) + '◇'.repeat(Math.max(0, input.maxAttempts - input.attempts));

  return [
    `Fuse #${n}`,
    `${bar}  ${input.ignited}/${input.totalNodes}`,
    `${formatScore(input.score)} pts  ${tries}`,
  ].join('\n');
}

/** A short line for the result screen, phrased by how well it went. */
export function verdict(score: number, ignited: number, totalNodes: number): string {
  if (ignited === 0) return 'La chispa no llegó a nada.';
  if (ignited === totalNodes) return 'Tablero limpio. Todos los nodos.';
  const share = ignited / totalNodes;
  if (share >= 0.85) return 'Casi entero.';
  if (share >= 0.6) return 'Buena línea.';
  if (share >= 0.35) return 'Hay más ahí dentro.';
  if (score <= NODE_VALUE) return 'Un nodo. Se puede mucho más.';
  return 'Prueba otra ruta.';
}

/**
 * Offers the share sheet, falling back to the clipboard.
 *
 * Returns what actually happened so the caller can tell the player the truth
 * rather than always claiming success.
 */
export async function shareSummary(text: string): Promise<'shared' | 'copied' | 'failed'> {
  const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };

  if (typeof nav.share === 'function') {
    try {
      await nav.share({ text });
      return 'shared';
    } catch (err) {
      // A user who dismisses the sheet is not an error, and must not trigger a
      // clipboard fallback they did not ask for.
      if (err instanceof DOMException && err.name === 'AbortError') return 'failed';
    }
  }

  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/**
 * Records the canvas to a webm clip.
 *
 * Every run is fully described by five placements and a seed, so the clip is
 * generated rather than screen-captured. Not all WebViews expose MediaRecorder
 * with a canvas stream, hence the capability check and the honest null return.
 */
export function canRecordClip(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function'
  );
}

export interface ClipRecorder {
  stop(): Promise<Blob | null>;
}

export function recordClip(canvas: HTMLCanvasElement, fps = 30): ClipRecorder | null {
  if (!canRecordClip()) return null;

  const mimeCandidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m));
  if (!mimeType) return null;

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(canvas.captureStream(fps), { mimeType, videoBitsPerSecond: 4_000_000 });
  } catch {
    return null;
  }

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.start();

  return {
    stop() {
      return new Promise<Blob | null>((resolve) => {
        if (recorder.state === 'inactive') {
          resolve(null);
          return;
        }
        recorder.onstop = () => resolve(chunks.length ? new Blob(chunks, { type: mimeType }) : null);
        recorder.stop();
      });
    },
  };
}

/** Describes today's board in one line, for accessibility and for the archive. */
export function describeBoard(board: Board, date: string): string {
  let nodes = 0;
  for (let i = 0; i < board.cells.length; i++) if (board.cells[i] === 2) nodes++;
  return `Reto ${puzzleNumber(date)}: ${nodes} nodos en un tablero de ${board.w} por ${board.h}.`;
}
