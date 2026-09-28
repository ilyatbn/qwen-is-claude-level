import { describe, expect, it } from 'vitest'
import { F1 } from '../scenes/F1'
import { explosion, emptyFrame, Lcg, sceneFx, SMOKE_TEX_DRAWS, STILL } from './kit'
import { blastFx, blastScale, BLAST_REACH, cloudFx, CLOUD_SIZE, CLOUD_SPREAD, CLOUD_SPRITES, FLAME_LIFT, FLAME_REACH, flameFx, IMPACT_LIFE, IMPACT_MAX_R } from './game'
import { fxFeed, gameFrame, MINE_FAR, MINE_NEAR } from './feed'
import { beamFx, LASER_CORE, MUZZLE_SIZE } from './game'
import { MUZZLE_LIGHT } from '../effectLights'
import { OrdnanceState } from '../../render/ordnance-state'
import { OrdnanceFxState } from '../../render/ordnanceFx-math'

describe('kit.js as data', () => {
  it('rnd is the mockup’s Park–Miller stream from seed 7', () => {
    const r = new Lcg(7)
    expect(r.next()).toBeCloseTo((7 * 16807) / 2147483647, 15)
    expect(r.q).toBe(7 * 16807)
  })

  it('F1’s effects become the mockup’s meshes: 5 ribbons + 22 sparks, 5 sprites + the glow, 22 smoke, fireball + ring', () => {
    const f = sceneFx(F1.fx)
    expect(f.ribbons.length).toBe(5 + 22)
    expect(f.soft.length).toBe(5 + 1)
    expect(f.smoke.length).toBe(22)
    expect(f.discs.map((d) => d.kind)).toEqual([0, 2])
    // z 40–43 are under the plume (z 45+); the explosion's own parts are over it.
    expect(f.ribbons.filter((r) => r.under).length).toBe(5)
    expect(f.soft.filter((s) => s.under).length).toBe(5)
  })

  it('the explosion continues the stream after the smoke texture’s draws, as the mockup’s does', () => {
    const rnd = new Lcg(7)
    for (let i = 0; i < SMOKE_TEX_DRAWS; i++) rnd.next()
    const a = rnd.next() * 6.283
    const r = (30 + rnd.next() * 60) * 0.5
    const up = rnd.next()
    const e = F1.fx.find((f) => f.kind === 'explosion')!
    const first = sceneFx(F1.fx).smoke[0]!
    if (e.kind !== 'explosion') throw new Error('no explosion')
    expect(first.x).toBeCloseTo(e.x + Math.cos(a) * r * 0.8, 9)
    expect(first.y).toBeCloseTo(e.y - 20 * 0.5 - up * 110 * 0.5 - Math.sin(a) * 20 * 0.5, 9)
  })
})

describe('the game’s effects cover what the simulation hurts', () => {
  it('a blast is drawn at the scale whose fire reads out to its radius', () => {
    for (const r of [36, 42, 48]) {
      const s = blastScale(r)
      expect(BLAST_REACH * s).toBeCloseTo(r, 9)
      const out = emptyFrame()
      explosion(out, 0, 0, s, 0, new Lcg(3), STILL)
      // The fireball quad's half-side (95 s) reaches past the radius.
      expect(out.discs[0]!.size / 2).toBeGreaterThan(r)
    }
  })

  it('a blast grows old and goes; an impact has no plume and a short life', () => {
    const young = emptyFrame()
    blastFx(young, { x: 0, y: 0, r: 42, age: 0.1, ttl: 1.1 })
    expect(young.discs.some((d) => d.kind === 0)).toBe(true)
    expect(young.smoke.length).toBe(22)
    const gone = emptyFrame()
    blastFx(gone, { x: 0, y: 0, r: 42, age: 1.1, ttl: 1.1 })
    expect(gone.smoke.length + gone.discs.length + gone.soft.length + gone.ribbons.length).toBe(0)
    const hit = emptyFrame()
    blastFx(hit, { x: 0, y: 0, r: IMPACT_MAX_R - 1, age: 0.05, ttl: 1.1 })
    expect(hit.smoke.length).toBe(0)
    expect(hit.discs.length).toBeGreaterThan(0)
    const hitGone = emptyFrame()
    blastFx(hitGone, { x: 0, y: 0, r: IMPACT_MAX_R - 1, age: IMPACT_LIFE, ttl: 1.1 })
    expect(hitGone.discs.length).toBe(0)
  })

  it('a flame’s tongue reaches every point of its burn circle within FLAME_REACH of its half-side', () => {
    const R = 10
    const out = emptyFrame()
    flameFx(out, { id: 5, x: 100, y: 50 }, R)
    const d = out.discs[0]!
    const h = d.size / 2
    expect(d.max).toBe(true)
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2
      // The shader's p (y up) of a point just inside the circle; its tongue's distance `rr`.
      const px = (Math.cos(a) * (R - 1)) / h
      const py = (d.y - (50 + Math.sin(a) * (R - 1))) / h
      const dy = py + FLAME_LIFT
      const rr = Math.hypot(px, dy * (dy > 0 ? 0.62 : 1.3))
      expect(rr).toBeLessThanOrEqual(FLAME_REACH * 1.3 + 1e-9)
    }
  })

  it('a cloud is CLOUD_SPRITES sprites around its centre, and nothing once it has thinned out', () => {
    const out = emptyFrame()
    const h = { id: 3, kind: 'smoke' as const, x: 0, y: 0, r: 110, ttl: 5, life: 8 }
    cloudFx(out, h, 12)
    expect(out.smoke.length).toBe(CLOUD_SPRITES)
    for (const s of out.smoke) expect(Math.hypot(s.x, s.y)).toBeLessThanOrEqual(CLOUD_SPREAD * h.r + 0.06 * h.r * Math.SQRT2 + 1e-9)
    expect(Math.max(...out.smoke.map((s) => s.size))).toBeLessThanOrEqual(h.r * CLOUD_SIZE * 1.2 + 1e-9)
    const done = emptyFrame()
    cloudFx(done, { ...h, ttl: 0 }, 12)
    expect(done.smoke.length).toBe(0)
  })
})

describe('the feed', () => {
  it('builds from the layers’ records, and nothing from a hidden layer', () => {
    const scene = {}
    const feed = fxFeed(scene)
    expect(fxFeed(scene)).toBe(feed)
    const o = new OrdnanceState(0.35, 8)
    o.blastLife = 1.1
    o.addImpact(10, 10, 42, 'blast')
    o.addProjectile(1, 'flame', 50, 50)
    const z = new OrdnanceFxState(0.15, 0.08)
    z.addHazard(7, 'toxic', 0, 0, 90, 8)
    z.hazards.get(7)!.ttl = 4
    const src = { state: o, visible: true, flameRadius: 10, bulletLength: 10 }
    feed.ordnance = src
    feed.zones = { state: z, visible: true, eye: { x: 0, y: 0 }, nowMs: 0, armTime: 1 }
    const out = emptyFrame()
    gameFrame(feed, out, 1)
    expect(out.discs.filter((d) => d.max).length).toBe(1)
    expect(out.smoke.length).toBe(22 + CLOUD_SPRITES)
    feed.ordnance = { ...src, visible: false }
    gameFrame(feed, out, 1)
    expect(out.discs.length).toBe(0)
    expect(out.smoke.length).toBe(CLOUD_SPRITES)
  })
})

describe('part B: beams, rounds, muzzles, swings, mines', () => {
  const feedWith = (o: OrdnanceState, z: OrdnanceFxState, eye = { x: 0, y: 0 }) => {
    const feed = fxFeed({})
    feed.ordnance = { state: o, visible: true, flameRadius: 10, bulletLength: 10 }
    feed.zones = { state: z, visible: true, eye, nowMs: 0, armTime: 1 }
    return feed
  }

  it('a beam is F1’s laser and impact, fading with its life, and gone at its end', () => {
    const out = emptyFrame()
    beamFx(out, { x0: 0, y0: 0, x1: 100, y1: 0, life: 0.35, ttl: 0.35 })
    expect(out.ribbons[0]!.core).toEqual(LASER_CORE)
    expect(out.soft[0]!.alpha).toBe(1)
    const half = emptyFrame()
    beamFx(half, { x0: 0, y0: 0, x1: 100, y1: 0, life: 0.175, ttl: 0.35 })
    expect(half.soft[0]!.alpha).toBeCloseTo(0.5, 9)
    const gone = emptyFrame()
    beamFx(gone, { x0: 0, y0: 0, x1: 100, y1: 0, life: 0, ttl: 0.35 })
    expect(gone.ribbons.length + gone.soft.length).toBe(0)
  })

  it('a muzzle glow is where a muzzle light is, as strong; other lights make none', () => {
    const feed = feedWith(new OrdnanceState(0.35, 8), new OrdnanceFxState(0.15, 0.08))
    const out = emptyFrame()
    gameFrame(feed, out, 0, [
      { x: 5, y: 6, z: 30, r: 120, rgb: MUZZLE_LIGHT.rgb, i: MUZZLE_LIGHT.i / 2, muzzle: true },
      { x: 50, y: 60, z: 70, r: 460, rgb: '255,140,50', i: 3.2 },
    ])
    expect(out.soft.length).toBe(1)
    expect(out.soft[0]!).toMatchObject({ x: 5, y: 6, size: MUZZLE_SIZE })
    expect(out.soft[0]!.alpha).toBeCloseTo(0.45, 9)
  })

  it('a round is a streak, a rocket a motor and a trail, a thrown weapon nothing (Phaser draws it)', () => {
    const o = new OrdnanceState(0.35, 8)
    o.addProjectile(1, 'bullet', 0, 0)
    o.moveProjectile(1, 20, 0)
    o.addProjectile(2, 'bazooka', 100, 0)
    for (let i = 1; i < 5; i++) o.moveProjectile(2, 100 + i * 10, 0)
    o.addProjectile(3, 'grenade', 200, 0)
    const out = emptyFrame()
    gameFrame(feedWith(o, new OrdnanceFxState(0.15, 0.08)), out, 0)
    expect(out.ribbons.length).toBe(1)
    expect(out.ribbons[0]!.pts[0]![0]).toBe(20)
    expect(out.soft.length).toBe(1)
    expect(out.smoke.length).toBe(4)
  })

  it('a mine reads at close range and not far off (§B6); a swing is an arc at its reach', () => {
    const z = new OrdnanceFxState(0.15, 0.08)
    z.addMine(1, 0, 0, 0)
    z.addSwing(0, 0, 0, 40, 1.6, 0)
    const near = emptyFrame()
    gameFrame(feedWith(new OrdnanceState(0.35, 8), z, { x: MINE_NEAR - 1, y: 0 }), near, 0)
    expect(near.ink.length).toBe(1)
    const far = emptyFrame()
    gameFrame(feedWith(new OrdnanceState(0.35, 8), z, { x: MINE_FAR + 1, y: 0 }), far, 0)
    expect(far.ink.length).toBe(0)
    const arc = near.ribbons[0]!.pts
    for (const [x, y] of arc) expect(Math.hypot(x, y)).toBeCloseTo(40, 9)
  })
})

describe('followWorldDraws (T23.19D F1)', () => {
  it('a follower hears the flag now and on every change, from the drawer only, until it unfollows', async () => {
    const { followWorldDraws, fxFeed, setWorldDraws } = await import('./feed')
    const scene = {}
    const heard: boolean[] = []
    const off = followWorldDraws(scene, (on) => heard.push(on))
    // No drawer yet (the stub, `?world=off`): Phaser draws — the layers hear false at once, not nothing.
    expect(heard).toEqual([false])
    setWorldDraws(fxFeed(scene), true)
    setWorldDraws(fxFeed(scene), true)
    setWorldDraws(fxFeed(scene), false)
    expect(heard).toEqual([false, true, false])
    off()
    setWorldDraws(fxFeed(scene), true)
    expect(heard).toEqual([false, true, false])
    // Another scene's drawer is not this scene's.
    const other = {}
    const heardOther: boolean[] = []
    followWorldDraws(other, (on) => heardOther.push(on))
    setWorldDraws(fxFeed(scene), false)
    expect(heardOther).toEqual([false])
  })
})
