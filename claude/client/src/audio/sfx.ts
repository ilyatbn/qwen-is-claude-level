/**
 * The Web Audio half: decoding samples and actually making noise.
 *
 * The mixer (`mixer.ts`) decides *what* plays and how loud; this file is a
 * `VoiceSink` and knows nothing about gameplay. Splitting them is §A8 — the
 * decisions are testable under vitest, and this file is verified by listening
 * and by the e2e check counting live voices.
 *
 * Everything here is best-effort. `docs/50` §8 requires the game to start with
 * no assets at all, so a failed fetch, a browser that blocks audio, or a machine
 * with no output device all degrade to silence and never to an exception.
 */

import type { Cue, VoiceSink } from './mixer'

interface AudioIndex {
  sustained: string[]
  cues: Record<string, string[]>
}

/** What `loadAudio` hands back, ready to give to a `Mixer`. */
export interface LoadedAudio {
  cues: Partial<Record<Cue, string[]>>
  sustained: Cue[]
  sink: WebAudioSink | null
}

/**
 * Fetch `audio.json`, then decode every sample it names.
 *
 * Decoding is done up front rather than lazily: a bazooka whose sample decodes
 * on first fire arrives after the explosion, which is worse than silence. The
 * whole set is ~700 kB and decodes in well under a second.
 */
export async function loadAudio(): Promise<LoadedAudio> {
  const empty: LoadedAudio = { cues: {}, sustained: [], sink: null }

  let index: AudioIndex | null = null
  try {
    const res = await fetch('/audio.json')
    if (!res.ok) {
      console.info(`[audio] no audio.json (${res.status}) — the game runs silent`)
      return empty
    }
    index = (await res.json()) as AudioIndex
  } catch (e) {
    console.info('[audio] could not fetch audio.json — the game runs silent', e)
    return empty
  }

  const Ctor: typeof AudioContext | undefined =
    typeof AudioContext !== 'undefined'
      ? AudioContext
      : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) {
    console.info('[audio] no Web Audio in this browser — the game runs silent')
    return empty
  }

  const sink = new WebAudioSink(new Ctor())
  const files = [...new Set(Object.values(index.cues ?? {}).flat())]
  const decoded = await Promise.all(files.map((f) => sink.load(f)))
  const ok = decoded.filter(Boolean).length
  if (ok === 0) {
    console.info(`[audio] no samples decoded (${files.length} attempted) — silent`)
    return empty
  }
  if (ok < files.length) {
    console.warn(`[audio] ${files.length - ok} of ${files.length} samples failed to decode`)
  }

  return {
    cues: index.cues as Partial<Record<Cue, string[]>>,
    sustained: (index.sustained ?? []) as Cue[],
    sink,
  }
}

export class WebAudioSink implements VoiceSink {
  private ctx: AudioContext
  private master: GainNode
  private buffers = new Map<string, AudioBuffer>()
  private live = new Map<number, { src: AudioBufferSourceNode; gain: GainNode }>()
  private next = 1
  private unlocked = false
  /** Called when a one-shot finishes, so the mixer's cap stays honest. */
  onEnded: ((handle: number) => void) | null = null

  constructor(ctx: AudioContext) {
    this.ctx = ctx
    this.master = ctx.createGain()
    this.master.connect(ctx.destination)
  }

  get context(): AudioContext {
    return this.ctx
  }

  /** Live voices, for the e2e check — a count of nodes, not of intentions. */
  get liveVoices(): number {
    return this.live.size
  }

  get sampleCount(): number {
    return this.buffers.size
  }

  async load(url: string): Promise<boolean> {
    try {
      const res = await fetch(`/${url}`)
      if (!res.ok) return false
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer())
      this.buffers.set(url, buf)
      return true
    } catch {
      // One failed sample is one silent cue, never a broken boot.
      return false
    }
  }

  /**
   * Browsers refuse to start an `AudioContext` without a user gesture, and
   * calling `resume()` before one produces a console warning per attempt. Wire
   * this to the first real input and call it once.
   */
  unlock(): void {
    if (this.unlocked) return
    this.unlocked = true
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
  }

  get isUnlocked(): boolean {
    return this.unlocked && this.ctx.state === 'running'
  }

  start(file: string, gain: number, pan: number, rate: number, loop: boolean): number | null {
    const buf = this.buffers.get(file)
    if (!buf || !this.unlocked) return null

    try {
      const src = this.ctx.createBufferSource()
      src.buffer = buf
      src.loop = loop
      src.playbackRate.value = Math.max(0.25, Math.min(4, rate))

      const g = this.ctx.createGain()
      g.gain.value = Math.max(0, Math.min(1, gain))

      // StereoPannerNode is not universal; a missing panner costs the stereo
      // image, not the sound.
      let tail: AudioNode = g
      if (typeof this.ctx.createStereoPanner === 'function') {
        const p = this.ctx.createStereoPanner()
        p.pan.value = Math.max(-1, Math.min(1, pan))
        g.connect(p)
        tail = p
      }
      src.connect(g)
      tail.connect(this.master)

      const handle = this.next++
      this.live.set(handle, { src, gain: g })
      src.onended = () => {
        this.live.delete(handle)
        this.onEnded?.(handle)
      }
      src.start()
      return handle
    } catch {
      return null
    }
  }

  stop(handle: number): void {
    const v = this.live.get(handle)
    if (!v) return
    this.live.delete(handle)
    try {
      // A short ramp rather than a hard stop: cutting a waveform mid-cycle is an
      // audible click, and a held jetpack loop stops constantly.
      const t = this.ctx.currentTime
      v.gain.gain.setValueAtTime(v.gain.gain.value, t)
      v.gain.gain.linearRampToValueAtTime(0, t + 0.03)
      v.src.stop(t + 0.04)
    } catch {
      /* already stopped */
    }
  }

  dispose(): void {
    for (const h of [...this.live.keys()]) this.stop(h)
    void this.ctx.close().catch(() => {})
  }
}
