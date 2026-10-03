/**
 * T23.09: the effect lights — built from the ordnance layer's own records, decaying with them, capped,
 * culled, and carrying the mockup's numbers (read from `f_scene.js` itself, not restated).
 */
import { BLACK_HOLE_LIGHT } from './fx/blackHole'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OrdnanceState } from '../render/ordnance-state'
import {
  EXPLOSION_LIGHT,
  EffectLights,
  FLAMETHROWER_LIGHT,
  GATE_LIGHT,
  GATE_LIGHT_RISE,
  JET_PLUME_LIGHT,
  LASER_IMPACT_LIGHT,
  LAVA_GLOW_LIGHT,
  MUZZLE_FRAMES,
  MUZZLE_LIGHT,
  ROCKET_LIGHT,
  CRYSTAL_LIGHT,
  StaticLights,
  explosionLight,
  gateLights,
  jetFlames,
  type EffectSources,
  type LightSpec,
} from './effectLights'
import { F1 } from './scenes/F1'
import { TERRAIN_LIGHTS, pickLights } from './terrainLights'

const view = { x: 1000, y: 500, w: 1280, h: 720 }
const TTL = 0.35
const LIFE = 0.35
const TRAIL = 12

function sources(o: OrdnanceState, extra: Partial<EffectSources> = {}): EffectSources {
  return { projectiles: o.projectiles.values(), tracers: o.tracers, impacts: o.impacts, jets: [], vents: [], ...extra }
}

describe('the mockup numbers (f_scene.js::combatF, read from the file)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../tasks/M23/reference/mockup-src/f_scene.js'), 'utf8')
  /** `L(…, z, r, P.key|'r,g,b', i), // comment` → by comment (or the index for the uncommented crystals). */
  const rows = [...src.matchAll(/L\(.*?,\s*(\d+),\s*(\d+),\s*(P\.\w+|'[\d,]+'),\s*([\d.]+)\)/g)].map((m) => ({
    z: Number(m[1]),
    r: Number(m[2]),
    rgb: m[3]!.startsWith('P.') ? (F1.palette as unknown as Record<string, string>)[m[3]!.slice(2)] : m[3]!.slice(1, -1),
    i: Number(m[4]),
  }))
  it('has the ten lights', () => expect(rows.length).toBe(10))
  const cases: [string, LightSpec, number][] = [
    ['explosion', EXPLOSION_LIGHT, 0],
    ['laser impact', LASER_IMPACT_LIGHT, 1],
    ['muzzle', MUZZLE_LIGHT, 2],
    ['jet plume', JET_PLUME_LIGHT, 3],
    ['rocket motor', ROCKET_LIGHT, 4],
    ['flamethrower', FLAMETHROWER_LIGHT, 5],
    ['gate', GATE_LIGHT, 6],
    ['crystal', CRYSTAL_LIGHT, 7],
    ['lava glow', LAVA_GLOW_LIGHT, 9],
  ]
  for (const [name, spec, k] of cases) it(`${name} is the mockup's row ${k}`, () => expect(spec).toEqual(rows[k]))
})

describe('explosions decay (T23.09)', () => {
  it("an explosion's light is full at the blast and 0 by its end", () => {
    const o = new OrdnanceState(LIFE, TRAIL)
    const fx = new EffectLights()
    o.addImpact(1500, 800, 40, 'blast', TTL)
    const first = fx.frame(sources(o), view)
    expect(first).toEqual([{ x: 1500, y: 800, ...EXPLOSION_LIGHT }])
    o.update(TTL / 2)
    const mid = fx.frame(sources(o), view)
    // Presence control for the absence below: mid-life it is still there, dimmer.
    expect(mid.length).toBe(1)
    expect(mid[0]!.i).toBeCloseTo(EXPLOSION_LIGHT.i / 2, 9)
    o.update(TTL / 2)
    expect(fx.frame(sources(o), view)).toEqual([])
    expect(explosionLight({ x: 0, y: 0, life: 0, ttl: TTL })).toBeNull()
  })
})

describe('beams, muzzles, rockets, fire, jets, vents, gates', () => {
  it('a laser lights its far end, fading with the beam, and flashes its muzzle for MUZZLE_FRAMES lists', () => {
    const o = new OrdnanceState(LIFE, TRAIL)
    const fx = new EffectLights()
    o.addTracer(1100, 600, 1500, 700)
    const seen: string[][] = []
    const lists = Array.from({ length: MUZZLE_FRAMES + 1 }, () => {
      const l = fx.frame(sources(o), view)
      seen.push([...fx.lastKinds])
      return l
    })
    expect(seen[0]).toEqual(['laser', 'muzzle'])
    expect(lists[0]![0]).toMatchObject({ x: 1500, y: 700, i: LASER_IMPACT_LIGHT.i, rgb: LASER_IMPACT_LIGHT.rgb })
    expect(lists[0]![1]).toMatchObject({ x: 1100, y: 600, i: MUZZLE_LIGHT.i })
    expect(lists[1]![1]!.i).toBeCloseTo(MUZZLE_LIGHT.i / MUZZLE_FRAMES, 9)
    expect(seen[MUZZLE_FRAMES]).toEqual(['laser'])
    o.update(LIFE / 2)
    expect(fx.frame(sources(o), view)[0]!.i).toBeCloseTo(LASER_IMPACT_LIGHT.i / 2, 9)
    o.update(LIFE)
    expect(fx.frame(sources(o), view)).toEqual([])
  })

  it('a round flashes where it was fired; one the view marked stale does not (T23.09C F2: the view says, not the trail)', () => {
    const o = new OrdnanceState(LIFE, TRAIL)
    const fx = new EffectLights()
    o.addProjectile(1, 'bullet', 1200, 600)
    o.moveProjectile(1, 1200, 600)
    o.addProjectile(2, 'bullet', 1300, 600)
    o.moveProjectile(2, 1300, 600)
    // Both records look alike — the trail of two every new record has, the case T23.09 read as "fresh".
    const stale = new WeakSet<object>([o.projectiles.get(2)!])
    const l = fx.frame(sources(o, { stale }), view)
    expect(fx.lastKinds).toEqual(['muzzle'])
    expect(l[0]).toMatchObject({ x: 1200, y: 600 })
    o.moveProjectile(1, 1220, 600)
    fx.frame(sources(o, { stale }), view)
    o.moveProjectile(1, 1240, 600)
    expect(fx.frame(sources(o, { stale }), view)).toEqual([])
    // Control: with nothing marked, the second flashes too.
    const o2 = new OrdnanceState(LIFE, TRAIL)
    o2.addProjectile(2, 'bullet', 1300, 600)
    const fx2 = new EffectLights()
    fx2.frame(sources(o2), view)
    expect(fx2.lastKinds).toEqual(['muzzle'])
  })

  it('T23.09C F8: an unchanged list is the same array back; a changed one is new and leaves the old one alone', () => {
    const fx = new EffectLights()
    fx.statics.set(gateLights([{ x: 1300, y: 800 }]))
    const o = new OrdnanceState(LIFE, TRAIL)
    const a = fx.frame(sources(o), view)
    const snapshot = JSON.stringify(a)
    expect(fx.frame(sources(o), view)).toBe(a)
    o.addImpact(1500, 800, 40, 'blast', TTL)
    const b = fx.frame(sources(o), view)
    expect(b).not.toBe(a)
    expect(JSON.stringify(a)).toBe(snapshot)
    expect(b.length).toBe(2)
    o.update(TTL / 2)
    const c = fx.frame(sources(o), view)
    expect(c).not.toBe(b)
    expect(b[1]!.i).toBe(EXPLOSION_LIGHT.i)
  })

  it('a rocket carries its motor light behind it; a grenade carries none', () => {
    const o = new OrdnanceState(LIFE, TRAIL)
    const fx = new EffectLights()
    o.addProjectile(1, 'bazooka', 1200, 600)
    o.moveProjectile(1, 1220, 600)
    o.addProjectile(2, 'grenade', 1400, 600)
    fx.frame(sources(o), view) // the launch flash
    fx.frame(sources(o), view)
    const l = fx.frame(sources(o), view)
    expect(fx.lastKinds).toEqual(['rocket'])
    expect(l[0]).toMatchObject({ x: 1220 - 8, y: 600, r: ROCKET_LIGHT.r, i: ROCKET_LIGHT.i })
  })

  it("a molotov's crowd of flames is one fire light, and two fires apart are two", () => {
    const o = new OrdnanceState(LIFE, TRAIL)
    const fx = new EffectLights()
    for (let k = 0; k < 24; k++) o.addProjectile(k, 'flame', 1210 + k * 4, 610)
    fx.frame(sources(o), view)
    expect(fx.lastKinds).toEqual(['flame'])
    o.addProjectile(99, 'flame', 1210 + FLAMETHROWER_LIGHT.r * 3, 610)
    fx.frame(sources(o), view)
    expect(fx.lastKinds).toEqual(['flame', 'flame'])
  })

  it('a drawn burning body lights its flame; a hidden one, or one with no flame, does not', () => {
    const flame = { x: 1296, y: 706 }
    expect(jetFlames({ container: { visible: true }, flame })).toEqual([{ x: 1296, y: 706 }])
    expect(jetFlames({ container: { visible: false }, flame })).toEqual([])
    expect(jetFlames({ container: { visible: true }, flame: null })).toEqual([])
    expect(jetFlames(null)).toEqual([])
    const fx = new EffectLights()
    const l = fx.frame(sources(new OrdnanceState(LIFE, TRAIL), { jets: [flame] }), view)
    // T23.10B F1: marked as a body's own light — it lights the rock, and sees no one (`sightLights`).
    expect(l).toEqual([{ x: 1296, y: 706, ...JET_PLUME_LIGHT, body: true }])
  })

  it('a jetting vent lights its column, a burning one its mouth, a quiet one nothing', () => {
    const fx = new EffectLights()
    const vents = [
      { x: 1200, y: 800, jetting: true, burning: false },
      { x: 1400, y: 800, jetting: false, burning: true },
      { x: 1600, y: 800, jetting: false, burning: false },
    ]
    const l = fx.frame(sources(new OrdnanceState(LIFE, TRAIL), { vents }), view)
    expect(l).toEqual([
      { x: 1200, y: 740, ...FLAMETHROWER_LIGHT },
      { x: 1400, y: 800, ...LAVA_GLOW_LIGHT },
    ])
  })

  it('gates are static lights: near ones come back from the spatial list, far ones do not', () => {
    const fx = new EffectLights()
    fx.statics.set(gateLights([{ x: 1300, y: 800 }, { x: 9000, y: 800 }]))
    expect(fx.statics.size).toBe(2)
    const l = fx.frame(sources(new OrdnanceState(LIFE, TRAIL)), view)
    // T23.18B: marked standing (`fixed`), so combat lights rank before it in `pickLights`.
    expect(l).toEqual([{ x: 1300, y: 800 - GATE_LIGHT_RISE, ...GATE_LIGHT, fixed: true }])
  })
})

describe('the list the terrain gets: culled and capped (pickLights)', () => {
  it(`caps at ${TERRAIN_LIGHTS} and keeps the brightest (the explosions)`, () => {
    const o = new OrdnanceState(LIFE, TRAIL)
    const fx = new EffectLights()
    for (let k = 0; k < 30; k++) o.addTracer(1000 + k * 40, 600, 1000 + k * 40, 1000)
    for (let k = 0; k < 3; k++) o.addImpact(1200 + k * 400, 900, 40, 'blast', TTL)
    fx.frame(sources(o), view) // muzzles out of the way: laser + explosion lists only
    fx.frame(sources(o), view)
    const all = fx.frame(sources(o), view)
    expect(all.length).toBe(33)
    const got = pickLights(all, view)
    expect(got.length).toBe(TERRAIN_LIGHTS)
    expect(got.filter((l) => l.i === EXPLOSION_LIGHT.i).length).toBe(3)
  })

  it('culls a light whose circle misses the view, keeps one just inside its radius', () => {
    const fx = new EffectLights()
    const o = new OrdnanceState(LIFE, TRAIL)
    o.addImpact(view.x - EXPLOSION_LIGHT.r - 1, 800, 40, 'blast', TTL)
    o.addImpact(view.x - EXPLOSION_LIGHT.r + 1, 800, 40, 'blast', TTL)
    const got = pickLights(fx.frame(sources(o), view), view)
    expect(got.map((l) => l.x)).toEqual([view.x - EXPLOSION_LIGHT.r + 1])
  })

  it('the static grid returns a superset of what can reach the view', () => {
    const s = new StaticLights(256)
    const lights = Array.from({ length: 50 }, (_, k) => ({ x: k * 97, y: 700, z: 30, r: 150, rgb: GATE_LIGHT.rgb, i: 1 }))
    s.set(lights)
    const q = s.query(view)
    for (const l of pickLights(lights, view, 1000)) expect(q).toContain(l)
    expect(q.length).toBeLessThan(lights.length)
  })
})

describe('the black hole is a light (T23.20 part C)', () => {
  it('lights while shown, swells in, and goes when hidden or gone', () => {
    const fx = new EffectLights()
    const o = new OrdnanceState(LIFE, TRAIL)
    const hole = { x: 1500, y: 800, growth: 0.5, hidden: false }
    const on = fx.frame(sources(o, { hole }), view)
    expect(fx.lastKinds).toEqual(['hole'])
    expect(on[0]).toMatchObject({ x: 1500, y: 800, r: BLACK_HOLE_LIGHT.r })
    expect(on[0]!.i).toBeCloseTo(BLACK_HOLE_LIGHT.i * 0.5)
    expect(fx.frame(sources(o, { hole: { ...hole, hidden: true } }), view)).toEqual([])
    expect(fx.frame(sources(o, { hole: null }), view)).toEqual([])
  })
})
