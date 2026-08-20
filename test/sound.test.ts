/**
 * Sound.
 *
 * Two things are worth testing here and they are not the obvious one. Nobody
 * can assert that a sample sounds good, but you can assert that the game never
 * goes quiet: the fallback has to fire when a file is missing, and the gap that
 * stops a hundred-node chain from stacking into a rasp has to actually stop it.
 *
 * The rest is a parity guard. The cue list lives in TypeScript and the files
 * live in `public/sfx`, built by a script that is not run in CI — so nothing but
 * a test connects the two, and a renamed cue would otherwise ship as silence
 * that only shows up on a device.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SFX = fileURLToPath(new URL('../public/sfx', import.meta.url));
const CUES = ['select', 'place', 'pickup', 'invalid', 'launch', 'ignite', 'bomb', 'result'];

// ---------------------------------------------------------------------------
// A Web Audio graph that records what was built instead of making a noise.
// ---------------------------------------------------------------------------

interface Log {
  sources: { rate: number; gain: number }[];
  oscillators: { freq: number; type: string }[];
}

function installAudio(log: Log, opts: { decodes?: boolean } = {}): void {
  const param = (v = 0) => ({
    value: v,
    setValueAtTime: () => undefined,
    exponentialRampToValueAtTime: () => undefined,
  });
  const node = () => ({ connect: (t: unknown) => t });

  class FakeAudioContext {
    state = 'running';
    currentTime = 0;
    destination = node();
    resume = (): void => undefined;

    createGain(): unknown {
      return { ...node(), gain: param(1) };
    }
    createDynamicsCompressor(): unknown {
      return { ...node(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() };
    }
    createOscillator(): unknown {
      const osc = {
        ...node(),
        type: 'sine',
        frequency: param(),
        start: () => log.oscillators.push({ freq: osc.frequency.value, type: osc.type }),
        stop: () => undefined,
      };
      return osc;
    }
    createBufferSource(): unknown {
      const src = {
        ...node(),
        buffer: null as unknown,
        playbackRate: param(1),
        start: () => log.sources.push({ rate: src.playbackRate.value, gain: 1 }),
      };
      return src;
    }
    decodeAudioData(): Promise<unknown> {
      return opts.decodes === false ? Promise.reject(new Error('bad codec')) : Promise.resolve({ duration: 0.1 });
    }
  }

  vi.stubGlobal('AudioContext', FakeAudioContext);
}

/** A network that serves every cue, or none of them. */
function installFetch(ok: boolean): void {
  vi.stubGlobal('fetch', () =>
    Promise.resolve({ ok, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) })
  );
}

async function load() {
  vi.resetModules();
  return import('../src/sound.js');
}

/** Runs every pending promise the module has in flight. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Lets each test decide how much time passed, so the gap can be exercised. */
function atTime(ms: number): void {
  vi.spyOn(performance, 'now').mockReturnValue(ms);
}

let log: Log;

beforeEach(() => {
  log = { sources: [], oscillators: [] };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the files', () => {
  it('ships one for every cue', () => {
    const present = readdirSync(SFX).filter((f) => f.endsWith('.m4a')).map((f) => f.replace('.m4a', ''));
    expect(present.sort()).toEqual([...CUES].sort());
  });

  it('keeps the whole set small enough to precache', () => {
    const total = readdirSync(SFX)
      .filter((f) => f.endsWith('.m4a'))
      .reduce((n, f) => n + statSync(`${SFX}/${f}`).size, 0);
    // 36 kB today. The budget is there so a future "let's use the uncompressed
    // one" cannot quietly double the offline install.
    expect(total).toBeLessThan(80 * 1024);
  });

  it('writes real AAC, not an empty container', () => {
    for (const cue of CUES) {
      const bytes = readFileSync(`${SFX}/${cue}.m4a`);
      expect(bytes.length).toBeGreaterThan(1000);
      expect(bytes.toString('latin1', 4, 8)).toBe('ftyp');
    }
  });

  it('is asked for by exactly the cues the module knows about', async () => {
    // Catches a cue added in code with no file behind it, which would play the
    // fallback tone forever and never fail anywhere else.
    const asked: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      asked.push(url);
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
    });
    const sound = await load();
    sound.initSound(() => true);
    await settle();

    expect(asked.map((u) => u.replace('./sfx/', '')).sort()).toEqual(
      CUES.map((c) => `${c}.m4a`).sort()
    );
  });
});

describe('playing', () => {
  it('uses the sample once it has decoded', async () => {
    installAudio(log);
    installFetch(true);
    const sound = await load();
    sound.initSound(() => true);
    await settle();

    // Decoding needs a context and a context needs a gesture, so the very first
    // cue of a session is a tone by construction. Everything after it is not.
    atTime(0);
    sound.play('place');
    expect(log.oscillators).toHaveLength(1);

    await settle();
    atTime(1000);
    sound.play('place');
    expect(log.sources).toHaveLength(1);
  });

  it('retunes the sample for the combo instead of repeating one note', async () => {
    installAudio(log);
    installFetch(true);
    const sound = await load();
    sound.initSound(() => true);
    await settle();
    atTime(0);
    sound.play('ignite');
    await settle();

    atTime(1000);
    sound.play('ignite', sound.comboRate(1));
    atTime(2000);
    sound.play('ignite', sound.comboRate(5));
    expect(log.sources[1].rate).toBeGreaterThan(log.sources[0].rate);
  });

  it('falls back to a tone when the files never arrive', async () => {
    installAudio(log);
    installFetch(false);
    const sound = await load();
    sound.initSound(() => true);

    atTime(0);
    sound.play('bomb');
    expect(log.oscillators).toHaveLength(1);
    expect(log.sources).toHaveLength(0);
  });

  it('falls back to a tone when the device cannot decode the codec', async () => {
    installAudio(log, { decodes: false });
    installFetch(true);
    const sound = await load();
    sound.initSound(() => true);

    atTime(0);
    sound.play('launch');
    atTime(5000);
    sound.play('launch');
    expect(log.sources).toHaveLength(0);
    expect(log.oscillators.length).toBeGreaterThan(0);
  });

  it('says nothing at all when the player turned sound off', async () => {
    installAudio(log);
    installFetch(true);
    const sound = await load();
    sound.initSound(() => false);

    atTime(0);
    sound.play('result');
    expect(log.oscillators).toHaveLength(0);
    expect(log.sources).toHaveLength(0);
  });

  it('reads the setting every time, so the switch takes effect at once', async () => {
    installAudio(log);
    installFetch(false);
    const sound = await load();
    let on = false;
    sound.initSound(() => on);

    atTime(0);
    sound.play('select');
    expect(log.oscillators).toHaveLength(0);

    on = true;
    atTime(1000);
    sound.play('select');
    expect(log.oscillators).toHaveLength(1);
  });

  it('thins out a cue that fires faster than its gap', async () => {
    installAudio(log);
    installFetch(false);
    const sound = await load();
    sound.initSound(() => true);

    // A dense board ticks every 9 ms. Eleven ignites arriving that fast must
    // not become eleven voices, or they sum past full scale and rasp.
    for (let i = 0; i < 11; i++) {
      atTime(i * 9);
      sound.play('ignite');
    }
    expect(log.oscillators.length).toBeLessThanOrEqual(5);
    expect(log.oscillators.length).toBeGreaterThan(0);
  });

  it('lets a different cue through inside another one’s gap', async () => {
    installAudio(log);
    installFetch(false);
    const sound = await load();
    sound.initSound(() => true);

    atTime(0);
    sound.play('ignite');
    atTime(1);
    sound.play('bomb');
    // A bomb landing during a chain is the whole point of the bomb.
    expect(log.oscillators).toHaveLength(2);
  });
});

describe('the combo', () => {
  it('climbs, then stops climbing', async () => {
    const { comboRate } = await load();
    expect(comboRate(1)).toBe(1);
    expect(comboRate(4)).toBeGreaterThan(comboRate(2));
    expect(comboRate(200)).toBe(comboRate(9));
    // A chain that walked the sample up an octave would end as a whistle.
    expect(comboRate(200)).toBeLessThan(2);
  });
});
