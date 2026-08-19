/**
 * The vendored core must not drift.
 *
 * `core/sim` and `core/gen` are copies of the packages in the Android
 * repository. They are duplicated because the two apps ship separately, and
 * duplication is the price of that — but a copy that quietly diverges is far
 * worse than no copy at all: both builds submit to the *same* leaderboard, so a
 * simulation that disagrees by one tick produces scores the server refuses, or
 * worse, accepts against a different board.
 *
 * This suite makes drift impossible to miss. The fingerprint is a hash over
 * 2,000 complete runs; any behavioural change moves it. If this fails, the two
 * repositories have diverged and one of them is wrong.
 *
 * The value is pinned rather than computed from the other repo on purpose: CI
 * has no access to a sibling checkout, and a test that silently skips when it
 * cannot find its comparison is not a test.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { INVENTORY_SIZE, run } from '../core/sim/index.js';
import {
  CURATED_COUNT,
  createRng,
  dailyBoard,
  dailyPar,
  dailyTarget,
  generateBoard,
  puzzleNumber,
} from '../core/gen/index.js';

/**
 * Behaviour of the shared simulation, as one number.
 *
 * Produced by `npm run fingerprint` in the Android repository. Changing the
 * simulation in either place changes this, and the mismatch is the alarm.
 */
const EXPECTED_FINGERPRINT = 712307039;
const EXPECTED_SCORING_RUNS = 1876;

function fingerprint(): { value: number; scored: number } {
  let acc = 0x811c9dc5 | 0;
  let scored = 0;

  for (let i = 1; i <= 2000; i++) {
    const board = generateBoard((i * 0x9e3779b1) >>> 0);
    const rng = createRng((i * 7919) >>> 0);
    const originIndex = board.originY * board.w + board.originX;

    const open: number[] = [];
    for (let c = 0; c < board.cells.length; c++) {
      if (board.cells[c] === 0 && c !== originIndex) open.push(c);
    }

    const chosen: number[] = [];
    let guard = 0;
    while (chosen.length < INVENTORY_SIZE && guard < 400) {
      guard++;
      const at = open[rng.int(open.length)];
      if (!chosen.includes(at)) chosen.push(at);
    }
    if (chosen.length < INVENTORY_SIZE) continue;

    const result = run(
      board,
      chosen.map((at, k) => ({
        x: at % board.w,
        y: Math.floor(at / board.w),
        piece: board.inventory[k],
      }))
    );
    if (result.score > 0) scored++;
    for (const v of [result.score, result.ignited, result.ticks, result.checksum]) {
      acc = Math.imul(acc ^ v, 0x01000193) | 0;
    }
  }
  return { value: acc >>> 0, scored };
}

describe('vendored core', () => {
  it('behaves identically to the Android build', () => {
    const actual = fingerprint();
    expect(
      actual.value,
      'The simulation has diverged from the Android repository. Both builds submit ' +
        'to the same leaderboard, so one of them is now producing scores the other ' +
        'cannot reproduce. Re-run `npm run core:sync`, or if the change was ' +
        'deliberate, update it in both repositories and re-pin this value.'
    ).toBe(EXPECTED_FINGERPRINT);
    expect(actual.scored).toBe(EXPECTED_SCORING_RUNS);
  });

  it('ships the same curated boards', () => {
    // A different seed table means a different puzzle on the same date, which
    // makes the shared leaderboard meaningless even with an identical simulation.
    expect(CURATED_COUNT).toBe(800);

    const seeds = JSON.parse(read('../core/gen/seeds.json'));
    const pars = JSON.parse(read('../core/gen/pars.json'));
    const targets = JSON.parse(read('../core/gen/targets.json'));
    expect(seeds).toHaveLength(800);
    expect(pars).toHaveLength(800);
    expect(targets).toHaveLength(800);
  });

  it('derives the same board and numbers for a known date', () => {
    // A spot check that reads like the game: puzzle #231 is 19 August 2026.
    const date = '2026-08-19';
    expect(puzzleNumber(date)).toBe(231);
    expect(dailyPar(date)).toBe(9000);
    expect(dailyTarget(date)).toBe(3600);

    const board = dailyBoard(date);
    expect(board.w).toBe(9);
    expect(board.h).toBe(13);
    expect(Array.from(board.inventory)).toEqual([2, 5, 3, 2, 1]);
  });

  it('keeps every target at or below its record', () => {
    const pars: number[] = JSON.parse(read('../core/gen/pars.json'));
    const targets: number[] = JSON.parse(read('../core/gen/targets.json'));
    for (let i = 0; i < pars.length; i++) {
      expect(targets[i], `puzzle #${i + 1}`).toBeLessThanOrEqual(pars[i]);
      expect(targets[i], `puzzle #${i + 1}`).toBeGreaterThan(0);
    }
  });

  it('has no runtime dependency in the vendored core', () => {
    // The core is pure by contract; anything imported here would have to be
    // vendored too, and would be a second thing to keep in step.
    for (const file of ['../core/sim/index.ts', '../core/gen/index.ts']) {
      const code = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      for (const specifier of imports) {
        expect(specifier.startsWith('.'), `${file} imports ${specifier}`).toBe(true);
      }
    }
  });
});

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}
