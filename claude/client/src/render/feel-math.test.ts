import { describe, expect, it } from 'vitest'
import {
  BANNER_LIFETIME,
  BannerQueue,
  DAMAGE_NUMBER_LIFETIME,
  DamageNumbers,
  HIT_MARKER_LIFETIME,
  HitMarkers,
  SHAKE_MAX_PX,
  TRAUMA_DECAY_S,
  TRAUMA_MAX_DISTANCE,
  Trauma,
  VIGNETTE_MAX_ALPHA,
  Vignette,
} from './feel-math'

describe('trauma', () => {
  it('decays to zero within the stated time and never goes negative', () => {
    const t = new Trauma()
    t.add(1)
    t.update(TRAUMA_DECAY_S)
    expect(t.level).toBe(0)
    t.update(1)
    expect(t.level).toBe(0)
  })

  it('never exceeds 1, however many explosions land at once', () => {
    const t = new Trauma()
    for (let i = 0; i < 20; i++) t.addExplosion(0, 42)
    expect(t.level).toBe(1)
    expect(t.shake).toBe(1)
  })

  it('is squared, so a small hit barely shakes and a close one throws the camera', () => {
    const near = new Trauma()
    near.addExplosion(0, 42)
    const far = new Trauma()
    far.addExplosion(TRAUMA_MAX_DISTANCE * 0.5, 42)
    // Linear falloff would make the far one half; the square makes it much less.
    expect(far.shake).toBeLessThan(near.shake * 0.2)
  })

  it('adds nothing at all beyond the maximum distance', () => {
    const t = new Trauma()
    t.addExplosion(TRAUMA_MAX_DISTANCE + 1, 42)
    expect(t.level).toBe(0)
  })

  it('scales with blast radius, so a meteor does not shake like a grenade', () => {
    const grenade = new Trauma()
    grenade.addExplosion(100, 36)
    const meteor = new Trauma()
    meteor.addExplosion(100, 50)
    expect(meteor.level).toBeGreaterThan(grenade.level)
  })

  it('offsets stay inside the stated bound and are uncorrelated frame to frame', () => {
    const t = new Trauma()
    t.add(1)
    const a = t.offset(1)
    const b = t.offset(2)
    expect(Math.abs(a.x)).toBeLessThanOrEqual(SHAKE_MAX_PX)
    expect(Math.abs(a.y)).toBeLessThanOrEqual(SHAKE_MAX_PX)
    // A smooth wobble reads as a camera bug rather than as impact.
    expect(a.x).not.toBe(b.x)
    expect(a.roll).not.toBe(b.roll)
  })

  it('is exactly zero when there is no trauma, so a calm camera is perfectly still', () => {
    const t = new Trauma()
    expect(t.offset(5)).toEqual({ x: 0, y: 0, roll: 0 })
  })
})

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
