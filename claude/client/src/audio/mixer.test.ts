import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  Mixer,
  attenuation,
  panFor,
  VOICE_CAP,
  DEFAULT_VOICE_CAP,
  type Cue,
  type VoiceSink,
} from './mixer'

/** Records every start/stop so a test can assert on effects, not on intentions. */
class FakeSink implements VoiceSink {
  started: Array<{ handle: number; file: string; gain: number; pan: number; rate: number; loop: boolean }> = []
  stopped: number[] = []
  private next = 1
  /** Set to make the sink report "sample not loaded", like a 404 would. */
  refuse = false

  start(file: string, gain: number, pan: number, rate: number, loop: boolean): number | null {
    if (this.refuse) return null
    const handle = this.next++
    this.started.push({ handle, file, gain, pan, rate, loop })
    return handle
  }
  stop(handle: number): void {
    this.stopped.push(handle)
  }
  get live(): number {
    return this.started.length - this.stopped.length
  }
}

const CUES: Partial<Record<Cue, string[]>> = {
  explode: ['audio/explode_0.ogg', 'audio/explode_1.ogg', 'audio/explode_2.ogg'],
  fire_smg: ['audio/fire_smg_0.ogg', 'audio/fire_smg_1.ogg', 'audio/fire_smg_2.ogg'],
  hit: ['audio/hit.ogg'],
  jetpack: ['audio/jetpack.ogg'],
  pickup: ['audio/pickup.ogg'],
}

function mixer(sink = new FakeSink(), extra = {}): { m: Mixer; sink: FakeSink } {
  const m = new Mixer({ cues: CUES, sustained: ['jetpack'], sink, falloff: 640, panHalfWidth: 320, ...extra })
  return { m, sink }
}

describe('attenuation', () => {
  it('is 1 at the listener and 0 at the falloff distance', () => {
    expect(attenuation(0, 640)).toBe(1)
    expect(attenuation(640, 640)).toBe(0)
  })

  it('is 0 beyond the cutoff rather than negative', () => {
    for (const d of [641, 1000, 1e6]) expect(attenuation(d, 640)).toBe(0)
  })

  it('falls monotonically across the whole range', () => {
    let prev = Infinity
    for (let d = 0; d <= 700; d += 7) {
      const g = attenuation(d, 640)
      expect(g).toBeLessThanOrEqual(prev)
      prev = g
    }
  })

  it('drops most of its volume in the near half, which is the point of squaring', () => {
    // A linear falloff would read exactly 0.5 at the midpoint. Asserting it is
    // materially below that is what distinguishes the curve from a ramp — the
    // test would pass against a linear implementation without it.
    expect(attenuation(320, 640)).toBeCloseTo(0.25, 5)
    expect(attenuation(320, 640)).toBeLessThan(0.4)
  })

  it('survives a zero or negative falloff without dividing by it', () => {
    expect(attenuation(10, 0)).toBe(0)
    expect(attenuation(10, -5)).toBe(0)
  })
})

describe('panFor', () => {
  it('is 0 at the listener and signed by side', () => {
    expect(panFor(100, 100)).toBe(0)
    expect(panFor(200, 100)).toBeGreaterThan(0)
    expect(panFor(0, 100)).toBeLessThan(0)
  })

  it('clamps to hard left and hard right', () => {
    expect(panFor(100_000, 0, 320)).toBe(1)
    expect(panFor(-100_000, 0, 320)).toBe(-1)
  })

  it('reaches the extremes exactly at the half width', () => {
    expect(panFor(320, 0, 320)).toBe(1)
    expect(panFor(-320, 0, 320)).toBe(-1)
  })
})

describe('Mixer.play', () => {
  it('starts a voice and reports the gain it applied', () => {
    const { m, sink } = mixer()
    const gain = m.play('hit')
    expect(gain).toBe(1)
    expect(sink.started).toHaveLength(1)
    expect(sink.started[0]?.file).toBe('audio/hit.ogg')
  })

  it('rotates through a cue’s variants instead of repeating one sample', () => {
    const { m, sink } = mixer()
    for (let i = 0; i < 3; i++) m.play('explode')
    expect(sink.started.map((s) => s.file)).toEqual([
      'audio/explode_0.ogg',
      'audio/explode_1.ogg',
      'audio/explode_2.ogg',
    ])
  })

  it('jitters the playback rate, so ten shots a second are not one loop', () => {
    const { m, sink } = mixer()
    for (let i = 0; i < 6; i++) m.play('fire_smg')
    const rates = sink.started.map((s) => s.rate)
    expect(new Set(rates).size).toBeGreaterThan(1)
    for (const r of rates) expect(Math.abs(r - 1)).toBeLessThanOrEqual(0.12 + 1e-9)
  })

  it('is deterministic: two mixers given the same calls produce the same rates', () => {
    // Reproducibility is a project-wide property (docs/01), and a mixer reaching
    // for Math.random would quietly break a replay's audio.
    const a = mixer()
    const b = mixer()
    for (let i = 0; i < 5; i++) {
      a.m.play('fire_smg')
      b.m.play('fire_smg')
    }
    expect(a.sink.started.map((s) => s.rate)).toEqual(b.sink.started.map((s) => s.rate))
  })
})

describe('the voice cap', () => {
  it('never exceeds the cap, and drops the oldest to make room', () => {
    const { m, sink } = mixer()
    const cap = VOICE_CAP.explode ?? DEFAULT_VOICE_CAP
    for (let i = 0; i < cap + 3; i++) m.play('explode')
    expect(m.voicesFor('explode')).toBeLessThanOrEqual(cap)
    // The first started handles are the ones stopped — oldest first.
    expect(sink.stopped).toEqual([1, 2, 3])
  })

  it('caps each cue independently', () => {
    const { m } = mixer()
    for (let i = 0; i < 10; i++) {
      m.play('explode')
      m.play('hit')
    }
    expect(m.voicesFor('explode')).toBeLessThanOrEqual(VOICE_CAP.explode ?? DEFAULT_VOICE_CAP)
    expect(m.voicesFor('hit')).toBeLessThanOrEqual(VOICE_CAP.hit ?? DEFAULT_VOICE_CAP)
  })

  it('frees the slot when a voice ends on its own', () => {
    const { m, sink } = mixer()
    m.play('hit')
    const h = sink.started[0]?.handle ?? -1
    expect(m.voicesFor('hit')).toBe(1)
    m.onVoiceEnded(h)
    expect(m.voicesFor('hit')).toBe(0)
  })
})

describe('spatial', () => {
  const listener = { x: 1000, y: 500 }

  it('is silent beyond the falloff and audible at the listener', () => {
    const { m } = mixer()
    expect(m.spatial('explode', 1000, 500, listener)).toBe(1)
    expect(m.spatial('explode', 1000 + 700, 500, listener)).toBe(0)
  })

  it('does not start a voice at all when it would be inaudible', () => {
    const { m, sink } = mixer()
    m.spatial('explode', 99_999, 99_999, listener)
    expect(sink.started).toHaveLength(0)
  })

  it('pans toward the side the sound came from', () => {
    const { m, sink } = mixer()
    m.spatial('explode', listener.x + 200, listener.y, listener)
    m.spatial('explode', listener.x - 200, listener.y, listener)
    expect(sink.started[0]?.pan).toBeGreaterThan(0)
    expect(sink.started[1]?.pan).toBeLessThan(0)
  })

  it('attenuates by true distance, not by horizontal offset alone', () => {
    // A sound directly above must be quieter than one at the listener; using dx
    // only would report both at full gain.
    const { m } = mixer()
    const above = m.spatial('explode', listener.x, listener.y - 400, listener)
    expect(above).toBeGreaterThan(0)
    expect(above).toBeLessThan(1)
  })
})

describe('master volume', () => {
  it('scales every voice', () => {
    const { m, sink } = mixer()
    m.setMasterVolume(0.5)
    m.play('hit')
    expect(sink.started[0]?.gain).toBeCloseTo(0.5, 6)
  })

  it('clamps to [0,1] and treats a non-finite value as silence', () => {
    const { m } = mixer()
    m.setMasterVolume(5)
    expect(m.masterVolume).toBe(1)
    m.setMasterVolume(-2)
    expect(m.masterVolume).toBe(0)
    m.setMasterVolume(Number.NaN)
    expect(m.masterVolume).toBe(0)
  })

  it('at zero, starts nothing at all rather than a silent voice', () => {
    const { m, sink } = mixer()
    m.setMasterVolume(0)
    expect(m.play('hit')).toBe(0)
    expect(sink.started).toHaveLength(0)
  })
})

describe('hold, for sustained cues', () => {
  it('starts one looping voice and is idempotent', () => {
    const { m, sink } = mixer()
    m.hold('jetpack', true)
    m.hold('jetpack', true)
    m.hold('jetpack', true)
    expect(sink.started).toHaveLength(1)
    expect(sink.started[0]?.loop).toBe(true)
    expect(m.isHeld('jetpack')).toBe(true)
  })

  it('stops it, and stopping twice is harmless', () => {
    const { m, sink } = mixer()
    m.hold('jetpack', true)
    m.hold('jetpack', false)
    m.hold('jetpack', false)
    expect(sink.stopped).toHaveLength(1)
    expect(m.isHeld('jetpack')).toBe(false)
  })

  it('does not count against the one-shot cap', () => {
    const { m } = mixer()
    m.hold('jetpack', true)
    expect(m.activeVoices).toBe(0)
  })
})

describe('silence is a supported configuration', () => {
  let info: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    info = vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => info.mockRestore())

  it('an unknown cue is a no-op and logs exactly once', () => {
    const { m, sink } = mixer()
    for (let i = 0; i < 5; i++) expect(m.play('lava')).toBe(0)
    expect(sink.started).toHaveLength(0)
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('a mixer with no cues and no sink still runs every entry point', () => {
    const bare = new Mixer()
    expect(() => {
      bare.play('explode')
      bare.spatial('explode', 0, 0, { x: 0, y: 0 })
      bare.hold('jetpack', true)
      bare.hold('jetpack', false)
      bare.stopAll()
    }).not.toThrow()
  })

  it('a sink that refuses to start leaves no phantom voice behind', () => {
    // The control for the cap: if a refused start still counted, the cap would
    // silently strangle a cue whose samples never loaded.
    const sink = new FakeSink()
    sink.refuse = true
    const { m } = mixer(sink)
    for (let i = 0; i < 10; i++) m.play('explode')
    expect(m.voicesFor('explode')).toBe(0)
  })
})

describe('stopAll', () => {
  it('stops one-shots and held loops alike', () => {
    const { m, sink } = mixer()
    m.play('hit')
    m.play('explode')
    m.hold('jetpack', true)
    m.stopAll()
    expect(sink.live).toBe(0)
    expect(m.activeVoices).toBe(0)
    expect(m.isHeld('jetpack')).toBe(false)
  })
})
