import { describe, expect, it } from 'vitest'
import {
  BANNER_LIFETIME,
  BannerQueue,
  DAMAGE_NUMBER_LIFETIME,
  DamageNumbers,
  HIT_MARKER_LIFETIME,
  HitMarkers,
  LANDING_VOLUME_FLOOR,
  VIGNETTE_MAX_ALPHA,
  landingVolume,
  Vignette,
} from './feel-math'

describe('damage numbers', () => {
  it('expire exactly at their lifetime', () => {
    const d = new DamageNumbers()
    d.add(0, 0, 25, false)
    d.update(DAMAGE_NUMBER_LIFETIME - 0.01)
    expect(d.count).toBe(1)
    d.update(0.02)
    expect(d.count).toBe(0)
  })

  it('ignores sub-1 damage, which is blast-edge noise', () => {
    const d = new DamageNumbers()
    d.add(0, 0, 0.4, false)
    expect(d.count).toBe(0)
  })

  it('rises and holds full opacity for the first half', () => {
    const d = new DamageNumbers()
    d.add(100, 100, 30, true)
    d.update(DAMAGE_NUMBER_LIFETIME * 0.25)
    const a = d.live()[0]
    expect(a).toBeDefined()
    expect(a?.alpha).toBe(1)
    expect(a?.drawY).toBeLessThan(100)
    d.update(DAMAGE_NUMBER_LIFETIME * 0.5)
    expect(d.live()[0]?.alpha).toBeLessThan(1)
  })
})

describe('vignette', () => {
  it('scales with the hit and is capped', () => {
    const v = new Vignette()
    v.hit(10)
    const small = v.alpha
    v.hit(500)
    expect(v.alpha).toBe(VIGNETTE_MAX_ALPHA)
    expect(small).toBeLessThan(VIGNETTE_MAX_ALPHA)
  })

  it('fades back to nothing', () => {
    const v = new Vignette()
    v.hit(50)
    v.update(10)
    expect(v.alpha).toBe(0)
  })
})

describe('hit markers', () => {
  it('expire and pop outward as they fade', () => {
    const h = new HitMarkers()
    h.add(false)
    h.update(HIT_MARKER_LIFETIME / 2)
    const m = h.live()[0]
    expect(m).toBeDefined()
    expect(m?.scale).toBeGreaterThan(1)
    expect(m?.alpha).toBeLessThan(1)
    h.update(HIT_MARKER_LIFETIME)
    expect(h.count).toBe(0)
  })
})

describe('phase banner', () => {
  it('shows one at a time — the newer one replaces the older', () => {
    const b = new BannerQueue()
    b.show('NIGHTFALL', 0x8899ff)
    b.show('METEOR SHOWER', 0xff7744)
    expect(b.live()?.text).toBe('METEOR SHOWER')
  })

  it('fades in, holds, fades out, then clears', () => {
    const b = new BannerQueue()
    b.show('DAWN', 0xffddaa)
    b.update(BANNER_LIFETIME * 0.05)
    expect(b.live()!.alpha).toBeLessThan(1)
    b.update(BANNER_LIFETIME * 0.35)
    expect(b.live()!.alpha).toBe(1)
    b.update(BANNER_LIFETIME * 0.9)
    expect(b.live()).toBeNull()
  })
})

describe('landingVolume (T20.11)', () => {
  // `MAX_FALL_SPEED`, passed in rather than imported, because this file is
  // Phaser-free and `C()` needs the wasm. The scenes pass `C().MAX_FALL_SPEED`.
  const MAX = 900

  it('a landing at rest is the floor, and only the floor', () => {
    expect(landingVolume(0, MAX)).toBe(LANDING_VOLUME_FLOOR)
  })

  it('scales with the impact speed', () => {
    // The property the old code could not have: two different falls, two
    // different volumes. `Math.abs(vy)` on the grounding frame was 0 for both.
    const soft = landingVolume(MAX * 0.2, MAX)
    const hard = landingVolume(MAX * 0.5, MAX)
    expect(hard).toBeGreaterThan(soft)
    expect(soft).toBeCloseTo(0.2 + LANDING_VOLUME_FLOOR, 6)
    expect(hard).toBeCloseTo(0.5 + LANDING_VOLUME_FLOOR, 6)
  })

  it('clamps at 1 rather than blowing the mixer past unity', () => {
    expect(landingVolume(MAX, MAX)).toBe(1)
    expect(landingVolume(MAX * 10, MAX)).toBe(1)
  })

  it('survives the degenerate inputs a caller can actually produce', () => {
    // A negative impact cannot happen — `integrate` clamps at 0 — but a volume
    // below the floor would be an inaudible landing, which is worse than a
    // loud one, so the floor holds regardless.
    expect(landingVolume(-50, MAX)).toBe(LANDING_VOLUME_FLOOR)
    expect(landingVolume(100, 0)).toBe(LANDING_VOLUME_FLOOR)
  })
})
