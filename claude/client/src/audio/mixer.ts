/**
 * The mixer: which cue plays, how loud, how far left or right, and how many at
 * once. Pure arithmetic and bookkeeping — no Web Audio in this file (§A8), so it
 * is testable under vitest's `node` environment like every other `-math` module.
 *
 * The actual noise is made by a `VoiceSink`; `sfx.ts` implements one over Web
 * Audio. Nothing here knows what an `AudioContext` is.
 *
 * **Silence is a supported configuration.** `docs/50` §8 requires the game to
 * start with no assets at all. A cue with no samples is a no-op that logs once,
 * never a throw — a missing sound must never take a frame down with it.
 */

export type Cue =
  | 'fire_bazooka'
  | 'fire_smg'
  | 'fire_grenade'
  | 'explode'
  | 'hit'
  | 'death'
  | 'pickup'
  | 'crate_land'
  | 'jetpack'
  | 'walk'
  | 'land'
  | 'ui_click'
  | 'phase_change'
  | 'effect_telegraph'
  | 'meteor'
  | 'lava'
  | 'toxic'

/** What the mixer needs from whatever actually makes sound. */
export interface VoiceSink {
  /**
   * Begin playing `file`. Returns a handle for `stop`, or null if the sample is
   * not loaded — the mixer treats that exactly like a missing cue.
   */
  start(file: string, gain: number, pan: number, rate: number, loop: boolean): number | null
  stop(handle: number): void
}

export interface MixerOptions {
  /** cue → sample files, from `assets/audio.json`. */
  cues?: Partial<Record<Cue, string[]>>
  /** Cues played as a held loop rather than a one-shot. */
  sustained?: Cue[]
  sink?: VoiceSink | null
  /**
   * Distance at which a sound is fully attenuated, in world px. `FOV_DAY` is the
   * natural scale: you hear roughly as far as you can see in daylight.
   */
  falloff?: number
  /** Half the visible world width, for panning. `VIEWPORT_W / CAMERA_ZOOM / 2`. */
  panHalfWidth?: number
}

/** Simultaneous voices allowed per cue. A meteor shower must not be 40 impacts. */
export const VOICE_CAP: Partial<Record<Cue, number>> = {
  explode: 4,
  meteor: 3,
  fire_smg: 3,
  hit: 3,
  walk: 2,
}
export const DEFAULT_VOICE_CAP = 2

/** Playback-rate jitter, ± this fraction. Stops repeats sounding like a loop. */
export const RATE_JITTER = 0.12

const DEFAULT_FALLOFF = 640
const DEFAULT_PAN_HALF_WIDTH = 320

/**
 * Gain from distance: 1 at the listener, 0 at `falloff` and beyond.
 *
 * Quadratic rather than linear because linear falloff sounds like a wall — the
 * far half of the range stays audible and then stops. Squaring puts the drop
 * where the ear expects it.
 */
export function attenuation(distance: number, falloff = DEFAULT_FALLOFF): number {
  if (!(falloff > 0)) return 0
  if (!Number.isFinite(distance) || distance < 0) return 1
  if (distance >= falloff) return 0
  const t = 1 - distance / falloff
  return t * t
}

/** −1 hard left, +1 hard right, 0 at the listener, clamped at the edges. */
export function panFor(worldX: number, listenerX: number, halfWidth = DEFAULT_PAN_HALF_WIDTH): number {
  if (!(halfWidth > 0)) return 0
  const p = (worldX - listenerX) / halfWidth
  return Math.max(-1, Math.min(1, p))
}

interface Voice {
  handle: number
  cue: Cue
  /** Monotonic counter, so "oldest" is unambiguous without a clock. */
  seq: number
}

export class Mixer {
  private cues: Partial<Record<Cue, string[]>>
  private sustained: Set<Cue>
  private sink: VoiceSink | null
  private falloff: number
  private panHalfWidth: number

  private master = 1
  private voices: Voice[] = []
  private held = new Map<Cue, number>()
  private seq = 0
  private variant = new Map<Cue, number>()
  private warned = new Set<string>()
  /** Deterministic jitter: a fixed stream keeps tests and replays reproducible. */
  private rngState = 0x9e3779b9

  constructor(opts: MixerOptions = {}) {
    this.cues = opts.cues ?? {}
    this.sustained = new Set(opts.sustained ?? [])
    this.sink = opts.sink ?? null
    this.falloff = opts.falloff ?? DEFAULT_FALLOFF
    this.panHalfWidth = opts.panHalfWidth ?? DEFAULT_PAN_HALF_WIDTH
  }

  /** Replace the sample table once `audio.json` has loaded. */
  setCues(cues: Partial<Record<Cue, string[]>>, sustained: Cue[] = []): void {
    this.cues = cues
    this.sustained = new Set(sustained)
  }

  setSink(sink: VoiceSink | null): void {
    this.sink = sink
  }

  setMasterVolume(v: number): void {
    this.master = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0
  }

  get masterVolume(): number {
    return this.master
  }

  /** Live one-shot voices. Held loops are counted separately. */
  get activeVoices(): number {
    return this.voices.length
  }

  voicesFor(cue: Cue): number {
    return this.voices.filter((v) => v.cue === cue).length
  }

  /**
   * Play a cue. Returns the gain actually applied, so a caller (and a test) can
   * see that a sound was audible rather than merely requested — asserting on
   * "we called play" is the §A15 mistake.
   */
  play(cue: Cue, opts: { pan?: number; volume?: number; rate?: number } = {}): number {
    const file = this.pickVariant(cue)
    if (file === null) return 0

    const gain = this.master * clamp01(opts.volume ?? 1)
    if (gain <= 0) return 0

    const pan = Math.max(-1, Math.min(1, opts.pan ?? 0))
    const rate = (opts.rate ?? 1) * (1 + (this.rand() * 2 - 1) * RATE_JITTER)

    this.enforceCap(cue)
    const handle = this.sink?.start(file, gain, pan, rate, false) ?? null
    if (handle !== null) this.voices.push({ handle, cue, seq: ++this.seq })
    return gain
  }

  /**
   * Play a cue positioned in the world. Returns the applied gain — 0 means it
   * was inaudible, which is a real outcome and not a failure.
   */
  spatial(
    cue: Cue,
    worldX: number,
    worldY: number,
    listener: { x: number; y: number },
    volume = 1,
  ): number {
    const dx = worldX - listener.x
    const dy = worldY - listener.y
    const dist = Math.hypot(dx, dy)
    const g = attenuation(dist, this.falloff)
    if (g <= 0) return 0
    return this.play(cue, { pan: panFor(worldX, listener.x, this.panHalfWidth), volume: g * volume })
  }

  /**
   * Start or stop a sustained cue (the jetpack, a lava jet). Idempotent: calling
   * `hold(cue, true)` twice does not stack a second copy, which is the whole
   * reason a held loop exists rather than a one-shot fired every tick.
   */
  hold(cue: Cue, on: boolean, volume = 1): void {
    const isOn = this.held.has(cue)
    if (on === isOn) return
    if (!on) {
      const h = this.held.get(cue)
      if (h !== undefined) this.sink?.stop(h)
      this.held.delete(cue)
      return
    }
    const file = this.pickVariant(cue)
    if (file === null) return
    const gain = this.master * clamp01(volume)
    if (gain <= 0) return
    const handle = this.sink?.start(file, gain, 0, 1, this.sustained.has(cue)) ?? null
    if (handle !== null) this.held.set(cue, handle)
  }

  isHeld(cue: Cue): boolean {
    return this.held.has(cue)
  }

  /** A voice finished on its own; the sink reports it so the cap stays honest. */
  onVoiceEnded(handle: number): void {
    this.voices = this.voices.filter((v) => v.handle !== handle)
  }

  /** Stop everything. Used on scene shutdown and on round end. */
  stopAll(): void {
    for (const v of this.voices) this.sink?.stop(v.handle)
    for (const h of this.held.values()) this.sink?.stop(h)
    this.voices = []
    this.held.clear()
  }

  // -------------------------------------------------------------------------

  /**
   * Next sample for a cue, rotating through its variants. Null when the cue has
   * no samples at all — logged once, then silent forever after.
   */
  private pickVariant(cue: Cue): string | null {
    const files = this.cues[cue]
    if (!files || files.length === 0) {
      if (!this.warned.has(cue)) {
        this.warned.add(cue)
        console.info(`[audio] no sample for "${cue}" — silent`)
      }
      return null
    }
    const i = (this.variant.get(cue) ?? 0) % files.length
    this.variant.set(cue, i + 1)
    return files[i] ?? null
  }

  /** Free a slot if this cue is at its cap, oldest first. */
  private enforceCap(cue: Cue): void {
    const cap = VOICE_CAP[cue] ?? DEFAULT_VOICE_CAP
    const mine = this.voices.filter((v) => v.cue === cue)
    if (mine.length < cap) return
    // Enforcing a cap and freeing a slot are different operations — drop enough
    // that the *new* voice fits, not merely enough to satisfy the bound.
    const excess = mine.length - cap + 1
    const doomed = mine.sort((a, b) => a.seq - b.seq).slice(0, excess)
    for (const v of doomed) this.sink?.stop(v.handle)
    const ids = new Set(doomed.map((v) => v.handle))
    this.voices = this.voices.filter((v) => !ids.has(v.handle))
  }

  /** Small deterministic LCG — reproducible jitter, no Math.random. */
  private rand(): number {
    this.rngState = (Math.imul(this.rngState, 1664525) + 1013904223) >>> 0
    return this.rngState / 0x1_0000_0000
  }
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0
}
