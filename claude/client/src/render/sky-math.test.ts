import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { C, Core } from '../core'

const here = dirname(fileURLToPath(import.meta.url))
import {
  bodyPositions,
  cloudField,
  cloudTint,
  cloudTwinX,
  cloudX,
  darknessAt,
  CYCLE_LENGTH,
  cycleU,
  mountainProfile,
  skyColors,
  skyPhase,
  starAlpha,
  starField,
  type SkyPhase,
} from './sky-math'

describe('cycleU', () => {
  it('wraps every CYCLE_LENGTH seconds', () => {
    expect(cycleU(0)).toBe(0)
    expect(cycleU(CYCLE_LENGTH)).toBe(0)
    expect(cycleU(CYCLE_LENGTH * 1.5)).toBeCloseTo(0.5, 9)
    expect(cycleU(CYCLE_LENGTH * 3)).toBeCloseTo(0, 9)
  })

  it('handles negative times without returning a negative u', () => {
    expect(cycleU(-CYCLE_LENGTH * 0.25)).toBeCloseTo(0.75, 9)
  })
})

describe('skyPhase', () => {
  it('produces all six names across the day', () => {
    const seen = new Set<SkyPhase>()
    for (let i = 0; i < 1000; i++) seen.add(skyPhase(i / 1000))
    expect(seen).toEqual(
      new Set(['morning', 'day', 'afternoon', 'evening', 'night', 'dawn'] as SkyPhase[]),
    )
  })

  it('matches the §A4 boundaries exactly', () => {
    expect(skyPhase(0.0)).toBe('morning')
    expect(skyPhase(0.149)).toBe('morning')
    expect(skyPhase(0.15)).toBe('day')
    expect(skyPhase(0.399)).toBe('day')
    expect(skyPhase(0.4)).toBe('afternoon')
    expect(skyPhase(0.5)).toBe('evening')
    expect(skyPhase(0.62)).toBe('night')
    expect(skyPhase(0.9)).toBe('dawn')
    expect(skyPhase(0.999)).toBe('dawn')
  })
})

describe('skyColors', () => {
  const channels = (c: number) => [(c >> 16) & 255, (c >> 8) & 255, c & 255]

  it('returns each keyframe exactly at its own u', () => {
    // If interpolation drifts, the authored palette is not what anyone sees.
    expect(skyColors(0.0)).toEqual({ top: 0x1b2a5e, bottom: 0xf2a15c })
    expect(skyColors(0.3)).toEqual({ top: 0x2f7fd8, bottom: 0xa8d8f0 })
    expect(skyColors(0.78)).toEqual({ top: 0x030616, bottom: 0x0d1a3a })
  })

  it('is continuous across the whole day, including the 1.0 -> 0.0 wrap', () => {
    // A discontinuity here is a visible snap in the sky, and the wrap is where a
    // keyframe table is most likely to have one.
    let worst = 0
    let prev = skyColors(0)
    for (let i = 1; i <= 1000; i++) {
      const cur = skyColors(i / 1000)
      for (const key of ['top', 'bottom'] as const) {
        const a = channels(prev[key])
        const b = channels(cur[key])
        for (let ch = 0; ch < 3; ch++) worst = Math.max(worst, Math.abs(a[ch]! - b[ch]!))
      }
      prev = cur
    }
    expect(worst).toBeLessThanOrEqual(12)
  })

  it('is actually dark at night and bright in the day', () => {
    // Guards against a table that interpolates smoothly between wrong colours.
    const lum = (c: number) => {
      const [r, g, b] = channels(c)
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
    }
    expect(lum(skyColors(0.3).top)).toBeGreaterThan(lum(skyColors(0.78).top) + 60)
  })
})

describe('bodyPositions', () => {
  const W = 1280
  const HORIZON = 500
  const ARC = 300

  it('shows the sun only over its own arc', () => {
    expect(bodyPositions(0.0, W, HORIZON, ARC).sun).not.toBeNull()
    expect(bodyPositions(0.3, W, HORIZON, ARC).sun).not.toBeNull()
    expect(bodyPositions(0.55, W, HORIZON, ARC).sun).not.toBeNull()
    expect(bodyPositions(0.6, W, HORIZON, ARC).sun).toBeNull()
    expect(bodyPositions(0.9, W, HORIZON, ARC).sun).toBeNull()
  })

  it('shows the moon only over its own arc', () => {
    expect(bodyPositions(0.4, W, HORIZON, ARC).moon).toBeNull()
    expect(bodyPositions(0.5, W, HORIZON, ARC).moon).not.toBeNull()
    expect(bodyPositions(0.99, W, HORIZON, ARC).moon).not.toBeNull()
  })

  it('puts both at their peak mid-arc and at the horizon at the ends', () => {
    const noon = bodyPositions(0.275, W, HORIZON, ARC).sun!
    expect(noon.y).toBeLessThan(HORIZON - ARC * 0.9)
    const rise = bodyPositions(0.0, W, HORIZON, ARC).sun!
    const set = bodyPositions(0.55, W, HORIZON, ARC).sun!
    expect(rise.y).toBeCloseTo(HORIZON, 5)
    expect(set.y).toBeCloseTo(HORIZON, 5)
    // And they travel across, not just up.
    expect(set.x).toBeGreaterThan(rise.x)
  })

  it('fades both in and out rather than popping at the horizon', () => {
    expect(bodyPositions(0.0, W, HORIZON, ARC).sun!.a).toBeCloseTo(0, 5)
    expect(bodyPositions(0.275, W, HORIZON, ARC).sun!.a).toBe(1)
    expect(bodyPositions(0.55, W, HORIZON, ARC).sun!.a).toBeCloseTo(0, 5)
  })
})

describe('darknessAt (A13)', () => {
  const NIGHT = 0.82

  it('is 0 through the whole lit half of the day', () => {
    for (const u of [0, 0.1, 0.25, 0.4, 0.49]) expect(darknessAt(u, NIGHT)).toBe(0)
  })

  it('reaches full darkness exactly when night begins, not 10 s early', () => {
    // The §A13 defect: darkness ramped over CYCLE_TRANSITION centred on t=60, so
    // the world was black at t=64 while the sky still showed the orange sunset
    // keyframe at u=0.55. Dusk now ends where the `night` phase starts.
    expect(darknessAt(0.55, NIGHT)).toBeGreaterThan(0)
    expect(darknessAt(0.55, NIGHT)).toBeLessThan(NIGHT * 0.95)
    expect(darknessAt(0.62, NIGHT)).toBeCloseTo(NIGHT, 6)
    expect(darknessAt(0.8, NIGHT)).toBeCloseTo(NIGHT, 6)
  })

  it('matches the phase table it is derived from', () => {
    // One description of the day: dusk spans the `evening` phase and dawn spans
    // `dawn`, so the sky and the darkness can never disagree again.
    expect(skyPhase(0.5)).toBe('evening')
    expect(skyPhase(0.62)).toBe('night')
    expect(skyPhase(0.9)).toBe('dawn')
    expect(darknessAt(0.5, NIGHT)).toBe(0)
    expect(darknessAt(0.9, NIGHT)).toBeCloseTo(NIGHT, 6)
    expect(darknessAt(0.999, NIGHT)).toBeLessThan(NIGHT * 0.05)
  })

  it('is continuous everywhere, including across the wrap', () => {
    let worst = 0
    let prev = darknessAt(0, NIGHT)
    for (let i = 1; i <= 2000; i++) {
      const cur = darknessAt(i / 2000, NIGHT)
      worst = Math.max(worst, Math.abs(cur - prev))
      prev = cur
    }
    // One tick at 60 Hz is 1/7200 of the cycle; this bound is far above that and
    // still far below any visible step.
    expect(worst).toBeLessThan(0.01)
  })

  it('is monotonic within each ramp', () => {
    let prev = -1
    for (let i = 0; i <= 200; i++) {
      const v = darknessAt(0.5 + (i / 200) * 0.12, NIGHT)
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = v
    }
    prev = Infinity
    for (let i = 0; i <= 200; i++) {
      const v = darknessAt(0.9 + (i / 200) * 0.1, NIGHT)
      expect(v).toBeLessThanOrEqual(prev + 1e-9)
      prev = v
    }
  })

  it('gives a 240 s round exactly two nights', () => {
    let nights = 0
    let wasNight = false
    for (let t = 0; t <= 240; t += 0.1) {
      const isNight = darknessAt(cycleU(t), NIGHT) >= NIGHT * 0.999
      if (isNight && !wasNight) nights++
      wasNight = isNight
    }
    expect(nights).toBe(2)
  })
})

describe('starField', () => {
  it('is deterministic, so the sky does not reshuffle on reload', () => {
    const a = starField(50, 800, 400)
    const b = starField(50, 800, 400)
    expect(a).toEqual(b)
    expect(starField(50, 800, 400, 99)).not.toEqual(a)
  })

  it('stays inside the requested area', () => {
    for (const s of starField(400, 800, 400)) {
      expect(s.x).toBeGreaterThanOrEqual(0)
      expect(s.x).toBeLessThanOrEqual(800)
      expect(s.y).toBeGreaterThanOrEqual(0)
      expect(s.y).toBeLessThanOrEqual(400)
    }
  })
})

describe('starAlpha', () => {
  const NIGHT = 0.82

  it('is zero in broad daylight even if darkness is somehow set', () => {
    expect(starAlpha(0.3, NIGHT, NIGHT)).toBe(0)
  })

  it('is full at night with full darkness', () => {
    expect(starAlpha(0.78, NIGHT, NIGHT)).toBeCloseTo(1, 5)
  })

  it('scales with darkness, so stars arrive with the dark and not with the clock', () => {
    expect(starAlpha(0.78, NIGHT / 2, NIGHT)).toBeCloseTo(0.5, 5)
    expect(starAlpha(0.78, 0, NIGHT)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// §C14 — mountains and clouds
// ---------------------------------------------------------------------------

/**
 * The §C14 block reads its bounds from `constants.rs` through the WASM table.
 *
 * Not literals: a fixture carrying its own 6/3/0.55/1.45 stays green against a
 * drifted constant, which is §A19 and is exactly how this file's first version
 * of the cloud-scale test went stale within an hour of the constant changing.
 */
let c: ReturnType<typeof C>
beforeAll(async () => {
  await Core.init(readFileSync(join(here, '../core/pkg/game_wasm_bg.wasm')))
  c = C()
})

describe('mountainProfile', () => {
  const N = 256

  it('is the same for the same seed and differs for a different one', () => {
    const a = mountainProfile(4242, 0, N, c.MOUNTAIN_CELLS, c.MOUNTAIN_OCTAVES)
    const b = mountainProfile(4242, 0, N, c.MOUNTAIN_CELLS, c.MOUNTAIN_OCTAVES)
    expect(a).toEqual(b)

    // The half the T15.01 review was about: "same seed → same" holds for a
    // function that ignores its seed entirely. This is what rules that out.
    const other = mountainProfile(999, 0, N, c.MOUNTAIN_CELLS, c.MOUNTAIN_OCTAVES)
    expect(other).not.toEqual(a)
    const moved = other.filter((v, i) => Math.abs(v - a[i]!) > 0.02).length
    expect(moved).toBeGreaterThan(N / 2)
  })

  it('gives the two layers independent ridges from one seed', () => {
    const near = mountainProfile(4242, 0, N, c.MOUNTAIN_CELLS, c.MOUNTAIN_OCTAVES)
    const far = mountainProfile(4242, 1, N, c.MOUNTAIN_CELLS, c.MOUNTAIN_OCTAVES)
    expect(far).not.toEqual(near)
    // Not merely different: uncorrelated. A layer index that only offset the
    // profile would pass `not.toEqual` and still draw the same ridge shifted.
    const moved = far.filter((v, i) => Math.abs(v - near[i]!) > 0.02).length
    expect(moved).toBeGreaterThan(N / 2)
  })

  it('stays inside 0..1 so a height fraction means what it says', () => {
    for (const seed of [1, 4242, 999, 0x7fffffff, -12345]) {
      const p = mountainProfile(seed, 0, N, c.MOUNTAIN_CELLS, c.MOUNTAIN_OCTAVES)
      expect(p).toHaveLength(N)
      expect(Math.min(...p)).toBeGreaterThanOrEqual(0)
      expect(Math.max(...p)).toBeLessThanOrEqual(1)
    }
  })

  it('wraps: the last sample meets the first, so a scrolling layer has no seam', () => {
    const p = mountainProfile(4242, 0, N, c.MOUNTAIN_CELLS, c.MOUNTAIN_OCTAVES)
    // Step across the wrap is no larger than a typical step within the profile.
    const steps = p.map((v, i) => Math.abs(v - p[(i + 1) % N]!))
    const across = steps[N - 1]!
    const median = [...steps].sort((a, b) => a - b)[Math.floor(N / 2)]!
    expect(across).toBeLessThan(median * 6 + 0.01)
  })

  it('actually varies — a flat ridge is not a mountain range', () => {
    const p = mountainProfile(4242, 0, N, c.MOUNTAIN_CELLS, c.MOUNTAIN_OCTAVES)
    expect(Math.max(...p) - Math.min(...p)).toBeGreaterThan(0.3)
  })
})

describe('cloudField', () => {
  const make = (seed: number) =>
    cloudField(
      seed,
      c.CLOUD_COUNT,
      c.CLOUD_BAND_TOP,
      c.CLOUD_BAND_BOTTOM,
      c.CLOUD_SCALE_MIN,
      c.CLOUD_SCALE_MAX,
      c.CLOUD_SPEED_SPREAD,
    )

  it('is seeded: same seed same clouds, different seed different clouds', () => {
    expect(make(4242)).toEqual(make(4242))
    expect(make(999)).not.toEqual(make(4242))
  })

  it('places every cloud inside its band, as a fraction, at a scale in range', () => {
    for (const cl of make(4242)) {
      // Fractions of the visible rect, both axes — the asymmetry between an
      // absolute x and a scaled y is what folded the clouds in half at zoom 2.
      expect(cl.x).toBeGreaterThanOrEqual(0)
      expect(cl.x).toBeLessThan(1)
      expect(cl.y).toBeGreaterThanOrEqual(c.CLOUD_BAND_TOP)
      expect(cl.y).toBeLessThanOrEqual(c.CLOUD_BAND_BOTTOM)
      expect(cl.scale).toBeGreaterThanOrEqual(c.CLOUD_SCALE_MIN)
      expect(cl.scale).toBeLessThanOrEqual(c.CLOUD_SCALE_MAX)
    }
  })

  /**
   * The spread must survive the zoom, which is the assertion that was missing.
   *
   * The previous version measured gaps in the field's own units and passed at
   * every zoom by construction. This resolves the field to pixels the way the
   * renderer does — `cloudX` at t = 0 over the visible span — and checks the
   * spread at the zooms the game actually runs at: 2.0 in a round, 0.75 on the
   * title screen, 1.0 in the sandbox.
   */
  it('spreads across the sky at every zoom the game uses', () => {
    for (const zoom of [1, 2, 0.75]) {
      const span = c.VIEWPORT_W / zoom
      const xs = make(4242)
        .map((cl) => cloudX(cl, 0, c.CLOUD_DRIFT, span))
        .sort((a, b) => a - b)
      for (let i = 1; i < xs.length; i++) {
        expect(
          xs[i]! - xs[i - 1]!,
          `zoom ${zoom}: clouds ${i - 1} and ${i} are ${(xs[i]! - xs[i - 1]!).toFixed(1)} px apart`,
        ).toBeGreaterThan(span / (c.CLOUD_COUNT * 4))
      }
      // ...and no third of the sky empty, at either end of the range.
      expect(span - xs[xs.length - 1]! + xs[0]!).toBeLessThan(span / 3)
    }
  })
})

describe('cloudX', () => {
  const SPAN = 1000
  // `x` is a fraction of the span: 0.1 of 1000 is the old literal 100.
  const cloud = { x: 0.1, y: 0.3, scale: 1, speed: 1 }

  it('advances at CLOUD_DRIFT px per second', () => {
    const drift = c.CLOUD_DRIFT
    expect(cloudX(cloud, 0, drift, SPAN)).toBeCloseTo(100, 9)
    expect(cloudX(cloud, 10, drift, SPAN)).toBeCloseTo(100 + drift * 10, 9)
    expect(cloudX(cloud, 60, drift, SPAN)).toBeCloseTo(100 + drift * 60, 9)
  })

  it('scales its base position with the span, so a zoom does not fold the field', () => {
    // The bug this exists for: at CAMERA_ZOOM 2 the span halves, and a base held
    // in absolute pixels wrapped clouds 6..11 back onto the slots of 0..5.
    expect(cloudX(cloud, 0, c.CLOUD_DRIFT, 1280)).toBeCloseTo(128, 9)
    expect(cloudX(cloud, 0, c.CLOUD_DRIFT, 640)).toBeCloseTo(64, 9)
  })

  it('wraps into the span rather than running off to infinity', () => {
    const drift = c.CLOUD_DRIFT
    const far = cloudX(cloud, 100_000, drift, SPAN)
    expect(far).toBeGreaterThanOrEqual(0)
    expect(far).toBeLessThan(SPAN)
  })

  it('is continuous across the wrap — no jump the eye could catch', () => {
    const drift = c.CLOUD_DRIFT
    // Find the elapsed time at which this cloud crosses the wrap.
    const tCross = (SPAN - cloud.x * SPAN) / drift
    const before = cloudX(cloud, tCross - 0.01, drift, SPAN)
    const after = cloudX(cloud, tCross + 0.01, drift, SPAN)
    expect(before).toBeGreaterThan(SPAN - 1)
    expect(after).toBeLessThan(1)
  })

  it('respects the per-cloud speed multiplier', () => {
    const slow = { ...cloud, speed: 0.5 }
    const fast = { ...cloud, speed: 1.5 }
    expect(cloudX(fast, 10, c.CLOUD_DRIFT, SPAN) - 100).toBeCloseTo(
      3 * (cloudX(slow, 10, c.CLOUD_DRIFT, SPAN) - 100),
      6,
    )
  })
})

describe('cloudTwinX', () => {
  const SPAN = 1000

  it('asks for no twin when the cloud is clear of both edges', () => {
    expect(cloudTwinX(500, SPAN, 60)).toBeNull()
  })

  it('puts a twin on the far side when the cloud straddles an edge', () => {
    // Straddling the left edge: the missing right half comes from x + span.
    expect(cloudTwinX(20, SPAN, 60)).toBe(20 + SPAN)
    // Straddling the right edge: the missing left half comes from x - span.
    expect(cloudTwinX(980, SPAN, 60)).toBe(980 - SPAN)
  })

  // The control: without it, "returns a twin near the edge" is satisfied by a
  // function that always returns one.
  it('asks for no twin one pixel inside the edge', () => {
    expect(cloudTwinX(61, SPAN, 60)).toBeNull()
    expect(cloudTwinX(939, SPAN, 60)).toBeNull()
  })

  // The seam this exists to prevent: across the whole drift cycle, every column
  // of the span is covered by a cloud body or by its twin — never a hole where
  // the cloud used to be.
  it('keeps a straddling cloud whole all the way across the wrap', () => {
    const half = 60
    for (let x = 0; x <= SPAN; x += 3) {
      const twin = cloudTwinX(x, SPAN, half)
      const covers = (cx: number, px: number) => px >= cx - half && px <= cx + half
      // A point just inside the left edge is covered whenever the cloud overlaps
      // it, whether the body or the twin supplies the pixels.
      for (const probe of [1, SPAN - 1]) {
        const wantsIt =
          covers(x, probe) || covers(x + SPAN, probe) || covers(x - SPAN, probe)
        if (!wantsIt) continue
        const drawn = covers(x, probe) || (twin !== null && covers(twin, probe))
        expect(drawn).toBe(true)
      }
    }
  })
})

describe('cloudTint', () => {
  const lum = (v: number) =>
    0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)
  const tint = (u: number) => cloudTint(u, c.CLOUD_ALPHA, c.CLOUD_SKY_MIX, c.CLOUD_ALPHA_FLOOR)

  it('is darker at night than at noon', () => {
    const noon = tint(0.3)
    const night = tint(0.78)
    expect(lum(night.color)).toBeLessThan(lum(noon.color) - 40)
    expect(night.alpha).toBeLessThan(noon.alpha)
  })

  it('is warm at dusk — more red than blue, which noon is not', () => {
    const warmth = (c: number) => ((c >> 16) & 255) - (c & 255)
    expect(warmth(tint(0.55).color)).toBeGreaterThan(20)
    // The control: a daytime sky is blue, so its clouds are not warm.
    expect(warmth(tint(0.3).color)).toBeLessThan(0)
  })

  it('cannot drift from the gradient, because it is made out of it', () => {
    // Every phase's tint sits between white and that phase's own sky bottom.
    for (const u of [0.05, 0.3, 0.45, 0.55, 0.78, 0.95]) {
      const { bottom } = skyColors(u)
      const t = tint(u).color
      expect(lum(t)).toBeGreaterThanOrEqual(lum(bottom) - 1)
      expect(lum(t)).toBeLessThanOrEqual(lum(0xffffff) + 1)
    }
  })

  it('scales the alpha it is given rather than inventing one', () => {
    expect(cloudTint(0.3, 0, c.CLOUD_SKY_MIX, c.CLOUD_ALPHA_FLOOR).alpha).toBe(0)
    expect(cloudTint(0.3, 1, c.CLOUD_SKY_MIX, c.CLOUD_ALPHA_FLOOR).alpha).toBeGreaterThan(cloudTint(0.3, 0.5, c.CLOUD_SKY_MIX, c.CLOUD_ALPHA_FLOOR).alpha)
  })
})
