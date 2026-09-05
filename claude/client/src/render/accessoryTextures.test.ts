/**
 * The accessory registries, and the rule that makes a picker worth opening
 * (T20.12).
 *
 * `tombstoneTextures.ts` states it: variants must *"differ in **silhouette**
 * rather than in palette. A skin picker whose options differ only by colour is a
 * picker with one option."* At `PLAYER_W = 16` a hat is about ten pixels wide, so
 * the outline is all a player can read — and a colour-only difference is exactly
 * the kind that passes a "there are five entries" test and fails on screen.
 *
 * These run headless, so they cannot ask Phaser to rasterise. What they *can*
 * check is the two things that make the browser assertion meaningful: the ids are
 * contiguous wire values, and the paint calls are not the same shape twice.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GLASSES_ART, HAT_ART, glassesArt, hatArt } from './accessoryTextures'

const source = readFileSync(fileURLToPath(new URL('./accessoryTextures.ts', import.meta.url)), 'utf8')

/** One whole `draw(textures, ART[n]!, ...)` block, as it appears in the source. */
function blockOf(src: string, list: 'HAT_ART' | 'GLASSES_ART', id: number): string {
  const head = src.indexOf(`draw(textures, ${list}[${id}]!,`)
  if (head < 0) throw new Error(`${list}[${id}] is never drawn`)
  const end = src.indexOf('\n  })', head)
  return src.slice(head, end)
}

/**
 * The geometry inside one such block, `fillStyle` lines stripped.
 *
 * **Takes the source as an argument.** The falsification below runs the real
 * extractor over a mutated *copy* of the real file, which it cannot do if the
 * source is baked in — and a falsification that builds its own two strings and
 * watches `Set` deduplicate them tests `Set`, not this file.
 */
function paintIn(src: string, list: 'HAT_ART' | 'GLASSES_ART', id: number): string {
  return blockOf(src, list, id)
    .split('\n')
    .filter((l) => /c\.(fillRect|arc|beginPath|fill)\(/.test(l))
    .join('\n')
}

function paintOf(list: 'HAT_ART' | 'GLASSES_ART', id: number): string {
  return paintIn(source, list, id)
}

describe('accessory registries (T20.12)', () => {
  for (const [name, list] of [
    ['hats', HAT_ART],
    ['glasses', GLASSES_ART],
  ] as const) {
    it(`${name}: ids are contiguous from 0, because they are wire values`, () => {
      expect(list.map((a) => a.id)).toEqual(list.map((_, i) => i))
    })

    it(`${name}: id 0 is "none" and draws nothing`, () => {
      // **Load-bearing.** `readId` falls back to 0 for a junk or out-of-range
      // value, so the fallback has to be a legal appearance — and unlike a grave,
      // which always has a marker, a head does not always have a hat. If id 0
      // were a real hat, every player with corrupt storage would be wearing one.
      expect(list[0]!.name).toBe('None')
      expect(list[0]!.key).toBe('')
    })

    it(`${name}: more than one wearable option, or the picker is decoration`, () => {
      expect(list.filter((a) => a.key !== '').length).toBeGreaterThan(1)
    })

    it(`${name}: every key is unique`, () => {
      const keys = list.map((a) => a.key).filter(Boolean)
      expect(new Set(keys).size).toBe(keys.length)
    })
  }

  it('falls back to "none" for an id past the end (docs/50 §8)', () => {
    expect(hatArt(999)).toBe(HAT_ART[0])
    expect(glassesArt(-1)).toBe(GLASSES_ART[0])
    expect(hatArt(Number.NaN)).toBe(HAT_ART[0])
    // The control: a real id resolves to itself, so the fallback above is not
    // satisfied by a function that always returns entry 0.
    expect(hatArt(2)).toBe(HAT_ART[2])
    expect(glassesArt(1)).toBe(GLASSES_ART[1])
  })

  it('draws every wearable entry, and no two of them the same shape', () => {
    for (const [name, list] of [
      ['HAT_ART', HAT_ART],
      ['GLASSES_ART', GLASSES_ART],
    ] as const) {
      const paints = list.filter((a) => a.key).map((a) => paintOf(name, a.id))
      // The presence half: without it, "no two are the same" passes for a file
      // that draws nothing at all.
      for (const p of paints) expect(p.length).toBeGreaterThan(20)
      // **Geometry only** — the `fillStyle` lines are stripped by `paintOf`, so
      // two options that differ solely in colour collapse to the same string and
      // fail here. That is the rule, made mechanical.
      expect(new Set(paints).size).toBe(paints.length)
    }
  })

  it('catches a colour-only variant — the falsification, on the real source', () => {
    // **Mutate the real file and run the real extractor over it**, the way
    // `gameScene-reset.test.ts` inserts a synthetic field and `scene-graph.test.ts`
    // strips a real edge. The previous version of this test built two identical
    // string literals and asserted that `Set` deduplicated them: it never called
    // `paintOf`, never touched `HAT_ART`, and would have passed with
    // `accessoryTextures.ts` deleted from the repository.
    //
    // Give hat 2 hat 1's geometry, keeping hat 2's own header line so the
    // extractor still finds it. The two now differ only in `fillStyle`, which is
    // exactly what the rule forbids.
    const target = blockOf(source, 'HAT_ART', 2)
    const donor = blockOf(source, 'HAT_ART', 1)
    const swapped = [target.split('\n')[0], ...donor.split('\n').slice(1)].join('\n')
    const mutated = source.replace(target, () => swapped)

    // The controls: the mutation took, and the two were distinct before it.
    expect(mutated).not.toBe(source)
    expect(paintOf('HAT_ART', 1)).not.toBe(paintOf('HAT_ART', 2))

    expect(paintIn(mutated, 'HAT_ART', 2)).toBe(paintIn(mutated, 'HAT_ART', 1))
    const paints = HAT_ART.filter((a) => a.key).map((a) => paintIn(mutated, 'HAT_ART', a.id))
    expect(new Set(paints).size).toBe(paints.length - 1)
  })
})
