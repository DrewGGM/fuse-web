/**
 * Sound.
 *
 * Eight recorded one-shots, built from Kenney's CC0 packs by
 * `scripts/build-sfx.mjs` and trimmed there rather than here — the runtime
 * plays what it is given and never edits it.
 *
 * The oscillator tones the samples replaced are still in this file, and that is
 * deliberate: every cue keeps a synthesised twin, so a missing file, a codec the
 * device will not decode, or a fetch that never returns costs the game its
 * texture and nothing else. Silence is a bug the player would report as "the
 * sound stopped working"; a thinner beep is one they will never notice.
 *
 * Two things this has to survive that a naive `new Audio().play()` does not:
 *
 *   - **Autoplay policy.** An AudioContext starts suspended until a gesture, so
 *     it is created on the first cue — which is always a tap — and resumed then.
 *   - **Stacking.** `ignite` can fire every 9 ms on a dense board. A minimum gap
 *     per cue thins that out, and a compressor on the bus catches whatever gets
 *     through, so a hundred-node chain gets louder without ever clipping.
 */

export type Cue = 'select' | 'place' | 'pickup' | 'invalid' | 'launch' | 'ignite' | 'bomb' | 'result';

interface Spec {
  /** Level in the mix. The interface stays under the board on purpose. */
  gain: number;
  /** Shortest gap between two of the same cue, in milliseconds. */
  gap: number;
  /** The synthesised fallback: frequency, seconds, wave, gain. */
  tone: readonly [number, number, OscillatorType, number];
}

/**
 * The mix.
 *
 * Set by ear against the rule the visual design already follows: the interface
 * is quiet so that the board is loud. Taps sit low enough to disappear into the
 * gesture, `ignite` carries the run, and `bomb` is the only cue allowed to be
 * startling — it is the only one that means something went wrong.
 */
const SPECS: Record<Cue, Spec> = {
  select: { gain: 0.3, gap: 30, tone: [660, 0.03, 'square', 0.03] },
  place: { gain: 0.45, gap: 40, tone: [880, 0.04, 'square', 0.035] },
  pickup: { gain: 0.35, gap: 40, tone: [320, 0.05, 'triangle', 0.04] },
  invalid: { gain: 0.4, gap: 120, tone: [180, 0.08, 'sawtooth', 0.03] },
  launch: { gain: 0.55, gap: 200, tone: [140, 0.18, 'sawtooth', 0.06] },
  ignite: { gain: 0.4, gap: 28, tone: [520, 0.05, 'triangle', 0.045] },
  bomb: { gain: 0.85, gap: 120, tone: [90, 0.3, 'sawtooth', 0.09] },
  result: { gain: 0.5, gap: 300, tone: [520, 0.12, 'sine', 0.05] },
};

const CUES = Object.keys(SPECS) as Cue[];

let enabled: () => boolean = () => true;
let ctx: AudioContext | null = null;
let bus: GainNode | null = null;
const buffers = new Map<Cue, AudioBuffer>();
const encoded = new Map<Cue, ArrayBuffer>();
const lastPlayed = new Map<Cue, number>();
let fetched = false;

/**
 * Hands the module the sound setting instead of the settings store.
 *
 * A predicate rather than a boolean because the player can flip the switch mid
 * game, and an import of the store here would make this file impossible to
 * exercise without one.
 */
export function initSound(isEnabled: () => boolean): void {
  enabled = isEnabled;
  void fetchAll();
}

/**
 * Pulls the files down before anything asks to play them.
 *
 * Deliberately separate from decoding: fetching needs no AudioContext and so no
 * gesture, which means the bytes are usually already here by the time the first
 * tap arrives. A cue whose file fails simply never appears in `encoded` and
 * spends the session on its tone.
 */
async function fetchAll(): Promise<void> {
  if (fetched || typeof fetch !== 'function') return;
  fetched = true;
  await Promise.all(
    CUES.map(async (cue) => {
      try {
        const res = await fetch(`./sfx/${cue}.m4a`);
        if (res.ok) encoded.set(cue, await res.arrayBuffer());
      } catch {
        // Offline on a cold load. The tones cover it, and the service worker
        // will have the files by the next launch.
      }
    })
  );
  void decodePending();
}

async function decodePending(): Promise<void> {
  const audio = ctx;
  if (!audio) return;
  await Promise.all(
    [...encoded].map(async ([cue, bytes]) => {
      try {
        // decodeAudioData detaches the buffer, so hand it a copy — otherwise a
        // second decode after a context change finds an empty array.
        buffers.set(cue, await audio.decodeAudioData(bytes.slice(0)));
      } catch {
        encoded.delete(cue);
      }
    })
  );
}

/** Creates the graph on the first cue, which is always inside a gesture. */
function context(): AudioContext | null {
  if (ctx) return ctx;
  if (typeof AudioContext === 'undefined') return null;
  try {
    ctx = new AudioContext();

    // Master gain into a compressor. The compressor is not for polish: it is
    // what makes a long chain safe, absorbing overlapping ignites that would
    // otherwise sum past full scale and rasp.
    bus = ctx.createGain();
    bus.gain.value = 0.8;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    bus.connect(limiter).connect(ctx.destination);

    void decodePending();
    return ctx;
  } catch {
    // No audio device, or a WebView built without it.
    return null;
  }
}

/**
 * Plays a cue.
 *
 * `rate` retunes the sample — the combo multiplier rides it, so a chain climbs
 * in pitch the way the old synthesised version did. It is clamped because a
 * long enough chain would otherwise walk `ignite` up into a whistle.
 */
export function play(cue: Cue, rate = 1): void {
  if (!enabled()) return;

  const spec = SPECS[cue];
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  const last = lastPlayed.get(cue) ?? -Infinity;
  if (now - last < spec.gap) return;
  lastPlayed.set(cue, now);

  const audio = context();
  const out = bus;
  if (!audio || !out) return;
  if (audio.state === 'suspended') void audio.resume();

  const buffer = buffers.get(cue);
  try {
    if (buffer) {
      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = Math.min(Math.max(rate, 0.6), 2);
      const amp = audio.createGain();
      amp.gain.value = spec.gain;
      source.connect(amp).connect(out);
      source.start();
    } else {
      const [freq, seconds, type, gain] = spec.tone;
      const osc = audio.createOscillator();
      const amp = audio.createGain();
      osc.type = type;
      osc.frequency.value = freq * rate;
      amp.gain.setValueAtTime(gain, audio.currentTime);
      amp.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + seconds);
      osc.connect(amp).connect(out);
      osc.start();
      osc.stop(audio.currentTime + seconds);
    }
  } catch {
    // A cue failing to play is never worth interrupting a run for.
  }
}

/**
 * How far the combo bends `ignite`.
 *
 * A twelfth per step, so the first few nodes of a chain are clearly a rising
 * line rather than one note repeating, and the ceiling arrives before it starts
 * to sound like a kettle.
 */
export function comboRate(multiplier: number): number {
  return 1 + Math.min(multiplier - 1, 8) * 0.09;
}
