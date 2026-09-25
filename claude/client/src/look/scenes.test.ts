/**
 * T23.01: the ported reference scenes against the mockup that drew them — counted at both
 * ends. The mockup end is read off its source, by hand (the literal counts in the comments)
 * and by machine where a regex can do it honestly (lights, `P` fields).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decodeMask, type ActorKind, type SceneData } from './scene'
import { SCENES } from './scenes'

const mockup = join(dirname(fileURLToPath(import.meta.url)), '../../../tasks/M23/reference/mockup-src')
const src = (f: string): string => readFileSync(join(mockup, f), 'utf8')

const kinds = (s: SceneData): Partial<Record<ActorKind, number>> => {
  const out: Partial<Record<ActorKind, number>> = {}
  for (const a of s.actors) out[a.kind] = (out[a.kind] ?? 0) + 1
  return out
}
const fxKinds = (s: SceneData): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const f of s.fx) out[f.kind] = (out[f.kind] ?? 0) + 1
  return out
}

// f_scene.js::combatF draw2d, read by hand: S.smoke ×1; turret ×1; stick ×3 (enemy, hero,
// teammate); rocket ×1; gate ×1; crystals ×2; beetle ×1; spider ×1; the bird loop over 4.
// fx3d: the tracer loop k<4 + the laser = 5 ribbons; sprites at m0, l1, the jet, the rocket,
// the flamer = 5; one explosion. F2 and F5 are combatF with another P, so the same.
interface Expected {
  actors: Partial<Record<ActorKind, number>>
  fx: Record<string, number>
  labels: number
}
const COMBAT: Expected = {
  actors: { smoke: 1, turret: 1, stick: 3, rocket: 1, gate: 1, crystals: 2, beetle: 1, spider: 1, bird: 4 },
  fx: { ribbon: 5, sprite: 5, explosion: 1 },
  labels: 0,
}
const EXPECTED: Record<string, Expected & { file: string }> = {
  F1: { ...COMBAT, file: 'f_scene.js' },
  F2: { ...COMBAT, file: 'f_scene.js' },
  F5: { ...COMBAT, file: 'f_scene.js' },
  // variant_F3.js, by hand: smoke ×1; stick ×3 (enemy, hero, jetpacker); rocket; turret;
  // spider; beetle; gate; crystals ×2. fx: tracers k<4 + laser = 5 ribbons; sprites at m0,
  // l1, the rocket = 3; one explosion.
  F3: {
    actors: { smoke: 1, stick: 3, rocket: 1, turret: 1, spider: 1, beetle: 1, gate: 1, crystals: 2 },
    fx: { ribbon: 5, sprite: 3, explosion: 1 },
    labels: 0,
    file: 'variant_F3.js',
  },
  // variant_F4.js, by hand: stick ×4 (P[0..3]) + the 3-aim forEach = 7; turret; gate; beetle;
  // spider; bird ×2; crystals; smoke; rocket. fx: 2 ribbons, 2 sprites, 1 explosion.
  // Labels: 6 cast + 6 row + 'aim reads at a glance' + the caption = 14.
  F4: {
    actors: { stick: 7, turret: 1, gate: 1, beetle: 1, spider: 1, bird: 2, crystals: 1, smoke: 1, rocket: 1 },
    fx: { ribbon: 2, sprite: 2, explosion: 1 },
    labels: 14,
    file: 'variant_F4.js',
  },
}

describe('the ported reference scenes', () => {
  it('ports exactly F1–F5', () => {
    expect(Object.keys(SCENES).sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  for (const [id, want] of Object.entries(EXPECTED)) {
    describe(id, () => {
      const s = SCENES[id]!
      it('has the mockup’s actors, fx and labels, by kind', () => {
        expect(kinds(s)).toEqual(want.actors)
        expect(fxKinds(s)).toEqual(want.fx)
        expect(s.labels.length).toBe(want.labels)
      })
      it('has as many lights as the mockup’s source declares', () => {
        // Every `L(` call in the file (the helper's definition, `const L = (`, has a space).
        const declared = (src(want.file).match(/\bL\(/g) ?? []).length
        expect(s.look.lights.length).toBe(declared)
        expect(declared).toBeGreaterThan(0)
      })
      it('decodes to a 1280×720 mask with rock', () => {
        const m = decodeMask(s.mask)
        expect([m.w, m.h]).toEqual([1280, 720])
        expect(m.solid.reduce((a, b) => a + b, 0)).toBeGreaterThan(1280 * 100)
      })
      it('stands its standing figures on the mask they came with', () => {
        // The mockup placed them with `groundAt`: rock under the feet, air above them.
        const m = decodeMask(s.mask)
        const standing = s.actors.filter(a => a.kind === 'stick' && !a.opts.jet && a.lit?.shadow)
        expect(standing.length).toBeGreaterThan(0)
        for (const a of standing) {
          expect(m.solid[a.y * m.w + a.x], `${id} stick at ${a.x},${a.y}`).toBe(1)
          expect(m.solid[(a.y - 1) * m.w + a.x], `${id} stick at ${a.x},${a.y}`).toBe(0)
        }
      })
    })
  }

  it('shares one map across F1, F2 and F5, and only the arena maps have a cave wall', () => {
    expect(SCENES.F2!.mask).toBe(SCENES.F1!.mask)
    expect(SCENES.F5!.mask).toBe(SCENES.F1!.mask)
    const back = (id: string): number => decodeMask(SCENES[id]!.mask).back.reduce((a, b) => a + b, 0)
    expect(back('F1')).toBeGreaterThan(1000)
    expect(back('F3')).toBeGreaterThan(1000)
    expect(back('F4')).toBe(0) // the cast sheet's flat ground carves nothing: the control
  })

  it('gives combatF every P field it reads, for every scene built with it', () => {
    // Machine-read from the mockup: every `P.<field>` in f_scene.js.
    const read = new Set([...src('f_scene.js').matchAll(/\bP\.(\w+)/g)].map(m => m[1]!))
    expect(read.size).toBeGreaterThan(20)
    for (const id of ['F1', 'F2', 'F5']) {
      const P = SCENES[id]!.palette as unknown as Record<string, unknown>
      expect(P, id).not.toBeNull()
      for (const f of read) expect(P[f], `${id}.palette.${f}`).not.toBeUndefined()
      // And nothing the mockup does not read: a stray field is a typo of a real one.
      expect(Object.keys(P).sort(), id).toEqual([...read].sort())
    }
    expect(SCENES.F3!.palette).toBeNull()
    expect(SCENES.F4!.palette).toBeNull()
  })
})
