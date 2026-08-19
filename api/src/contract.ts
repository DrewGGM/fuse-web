/**
 * Request/response contract for the API.
 *
 * Validation lives at the boundary and nowhere else: once a payload is past
 * `RunSubmission`, the rest of the Worker can treat it as trustworthy shape
 * (though never as a trustworthy *score* — only the replay decides that).
 */
import { z } from 'zod';
import { INVENTORY_SIZE, MIN_PLACEMENTS, type PieceValue, type Placement } from '../../core/sim/index.js';

/** Ranked attempts per player per UTC day. A game rule and a rate limit at once. */
export const MAX_ATTEMPTS = 3;

/** Generous ceilings that still bound how much work a crafted payload can cause. */
const MAX_COORD = 64;
const MAX_SCORE = 10_000_000;

const PlacementSchema = z.object({
  x: z.number().int().min(0).max(MAX_COORD),
  y: z.number().int().min(0).max(MAX_COORD),
  piece: z.number().int().min(1).max(5),
});

export const RunSubmission = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // A run may use fewer pieces than the inventory holds; the simulation checks
  // the rest. Bounding the array here still caps how much work a payload causes.
  placements: z.array(PlacementSchema).min(MIN_PLACEMENTS).max(INVENTORY_SIZE),
  clientScore: z.number().int().min(0).max(MAX_SCORE),
});

export type RunSubmissionInput = z.infer<typeof RunSubmission>;

export function toPlacements(raw: RunSubmissionInput['placements']): Placement[] {
  return raw.map((p) => ({ x: p.x, y: p.y, piece: p.piece as PieceValue }));
}

/** Accepts only a real calendar date, so `2026-02-31` cannot reach the generator. */
export function parseDateParam(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.toISOString().slice(0, 10) !== value) return null;
  return value;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** The one error envelope. Never a 200 with an error inside. */
export function errorResponse(
  code: string,
  message: string,
  status: number,
  details?: unknown
): Response {
  return json({ error: { code, message, ...(details ? { details } : {}) } }, status);
}
