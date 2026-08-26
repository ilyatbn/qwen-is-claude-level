/**
 * T16.01 — the PNG → terrain mask pipeline.
 *
 * Drives `scripts/lib/object-masks.mjs` and `scripts/build-object-masks.mjs`
 * directly, so these assertions run over the code the build runs rather than a
 * second copy of it. The build scripts are `.mjs` with a sibling `.d.mts`, which
 * is what lets a strict-TS test import across the client boundary.
 *
 * **The scale policy is pack-mean**: one factor per category, applied to every
 * sprite's own bounds, so a small crystal stays small and a big rock stays big.
 * §D2's "integer factor" is impossible against §D4's fractional table; the factor
 * is an exact `num/den` and every sampling step is integer arithmetic, which is
 * what §A24 actually wants. The relative-size assertion below is the one that
 * says pack-mean rather than per-sprite, and it is falsified against a per-sprite
 * sizer to prove it can tell them apart.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import {
  assertIdsMatchPosition,
  crop,
  decodeMasksBin,
  divRound,
  encodeMasksBin,
  opaqueBounds,
  packBits,
  packedLength,
  packFactor,
  popcount,
  rationalFromNumber,
  reduceRational,
  scaleFor,
  scaleNearest,
  thresholdAlpha,
  unpackBits,
} from '../../../scripts/lib/object-masks.mjs'
import { constants, parseConstants } from '../../../scripts/lib/rust-constants.mjs'
import {
  PACK_ROOT,
  PACKS,
  TARGET_CONSTANT,
  packFactors,
  selectSources,
  targetHeightPx,
} from '../../../scripts/build-object-masks.mjs'
import type {
  MeasuredSource,
  ObjectManifest,
} from '../../../scripts/build-object-masks.d.mts'
import type { Box, Rational } from '../../../scripts/lib/object-masks.d.mts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const THRESHOLD = constants().get('OBJECT_ALPHA_THRESHOLD')

const manifest = JSON.parse(
  readFileSync(join(root, 'assets/objects/manifest.json'), 'utf8'),
) as ObjectManifest
const blob = new Uint8Array(readFileSync(join(root, 'assets/objects/masks.bin')))

/** An RGBA buffer whose alpha comes from a per-pixel function. */
function rgbaFrom(w: number, h: number, alpha: (x: number, y: number) => number): Uint8Array {
  const buf = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (w * y + x) << 2
      buf[i] = 255
      buf[i + 1] = 255
      buf[i + 2] = 255
      buf[i + 3] = alpha(x, y)
    }
  }
  return buf
}

/** Round-trip through a real PNG, so the test reads what the build reads. */
function throughPng(w: number, h: number, alpha: (x: number, y: number) => number): PNG {
  const png = new PNG({ width: w, height: h })
  png.data.set(rgbaFrom(w, h, alpha))
  return PNG.sync.read(PNG.sync.write(png))
}

describe('the constants reader', () => {
  it('throws on a name that is not there', () => {
    // Without this the whole suite is theatre: a reader that returned undefined
    // makes every threshold assertion `undefined > undefined`, false forever.
    expect(() => constants().get('OBJECT_NO_SUCH_CONSTANT')).toThrow(/no `pub const/)
  })

  it('resolves a constant defined in terms of another', () => {
    const parsed = parseConstants('pub const A: f32 = 4.0;\npub const B: f32 = A * 3.0;\n')
    expect(parsed.get('B')).toBe(12)
  })

  it('reads the threshold the pipeline uses', () => {
    expect(Number.isFinite(THRESHOLD)).toBe(true)
    expect(constants().has('OBJECT_ALPHA_THRESHOLD')).toBe(true)
  })
})

describe('thresholding an 8x8 PNG', () => {
  // Column x is transparent for x < 4 and opaque for x >= 4, except row 0 which
  // straddles the threshold exactly.
  const png = throughPng(8, 8, (x, y) => {
    if (y === 0) return x < 4 ? THRESHOLD : THRESHOLD + 1
    return x < 4 ? 0 : 255
  })

  it('produces exactly the expected bits', () => {
    const bits = thresholdAlpha(png.data, 8, 8, THRESHOLD)
    const expected = new Uint8Array(64)
    for (let y = 0; y < 8; y++) for (let x = 4; x < 8; x++) expected[8 * y + x] = 1
    expect([...bits]).toEqual([...expected])
  })

  it('treats alpha exactly at the threshold as empty', () => {
    // `scripts/catalogue-sprites.mjs:15` measured every bound in CATALOGUE.md
    // with `a > 128`. `>=` here would describe different pixels than §D0's table.
    const bits = thresholdAlpha(png.data, 8, 8, THRESHOLD)
    expect(bits[0]).toBe(0)
    expect(bits[4]).toBe(1)
  })

  it('packs and unpacks those bits without loss', () => {
    const bits = thresholdAlpha(png.data, 8, 8, THRESHOLD)
    const packed = packBits(bits, 8, 8)
    expect(packed.length).toBe(packedLength(8, 8))
    expect(popcount(packed)).toBe(32)
    expect([...unpackBits(packed, 8, 8)]).toEqual([...bits])
  })
})

describe('trimming to the opaque bounding box', () => {
  const margin = 40
  const inner = { w: 7, h: 5 }
  const w = inner.w + margin * 2
  const h = inner.h + margin * 2
  const png = throughPng(w, h, (x, y) =>
    x >= margin && x < margin + inner.w && y >= margin && y < margin + inner.h ? 255 : 0,
  )
  const bits = thresholdAlpha(png.data, w, h, THRESHOLD)

  it('yields bounds without the margin', () => {
    expect(opaqueBounds(bits, w, h)).toEqual({ x: margin, y: margin, w: inner.w, h: inner.h })
  })

  it('crops to exactly those pixels', () => {
    const box = opaqueBounds(bits, w, h)
    const cropped = crop(bits, w, h, box)
    expect(cropped.length).toBe(inner.w * inner.h)
    expect([...cropped].every((b) => b === 1)).toBe(true)
  })

  it('reports an empty box for a fully transparent sprite', () => {
    const blank = thresholdAlpha(rgbaFrom(4, 4, () => 0), 4, 4, THRESHOLD)
    expect(opaqueBounds(blank, 4, 4)).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })
})

/** Reading B, kept only so the assertions below can be shown to reject it. */
function perSpriteSize(targetPx: number, bounds: Box): { w: number; h: number } {
  const h = Math.max(1, Math.round(targetPx))
  return { w: Math.max(1, Math.round((bounds.w * h) / bounds.h)), h }
}

/**
 * The claim that says pack-mean rather than per-sprite: two sprites of different
 * heights come out of the same category still different, in the same proportion.
 *
 * Written as a function so the *same* assertion can be pointed at a per-sprite
 * sizer and shown to fail. An assertion that cannot fail is not one.
 */
function assertRelativeSizePreserved(
  size: (bounds: Box) => { w: number; h: number },
  short: Box,
  tall: Box,
): void {
  const a = size(short)
  const b = size(tall)
  if (a.h === b.h) throw new Error(`both scaled to ${a.h}px — the spread is gone`)
  const scaledRatio = b.h / a.h
  // The exact heights are `short.h * f` and `tall.h * f`, each rounded to the
  // nearest pixel — so the ratio may sit anywhere half a pixel either way puts
  // it, and nowhere else. Deriving the window instead of picking a tolerance is
  // what stops this passing on a policy that merely happens to be close.
  const f = b.h / tall.h
  const low = (tall.h * f - 0.5) / (short.h * f + 0.5)
  const high = (tall.h * f + 0.5) / (short.h * f - 0.5)
  if (scaledRatio < low - 1e-9 || scaledRatio > high + 1e-9) {
    throw new Error(
      `ratio ${scaledRatio.toFixed(3)} is outside [${low.toFixed(3)}, ${high.toFixed(3)}]`,
    )
  }
}

describe('the scale factor', () => {
  it('takes a decimal as an exact rational', () => {
    expect(rationalFromNumber(1.5)).toEqual({ num: 15, den: 10 })
    expect(rationalFromNumber(28)).toEqual({ num: 28, den: 1 })
    expect(reduceRational(rationalFromNumber(1.5))).toEqual({ num: 3, den: 2 })
  })

  it('refuses a number it cannot spell exactly', () => {
    expect(() => rationalFromNumber(1e-7)).toThrow(/exact rational/)
  })

  it('refuses a target whose exact rational would leave safe-integer range', () => {
    // `PLAYER_H * 1.1` is 30.800000000000004, whose exact denominator is 10^15.
    // `num` past MAX_SAFE_INTEGER means `bounds.w * num` silently stops being
    // integer arithmetic — so this stops rather than shipping masks that are
    // bit-exact only on paper. This is the first multiplier a human will type.
    expect(() => rationalFromNumber(28 * 1.1)).toThrow(/too large to stay exact/)
    expect(() => packFactor(28 * 1.1, [50, 60])).toThrow(/too large to stay exact/)
  })

  it('still accepts a target with a sane number of decimals', () => {
    expect(rationalFromNumber(30.8)).toEqual({ num: 308, den: 10 })
  })

  it('keeps every real category inside safe-integer range', () => {
    // The control for the guard: the four shipping multipliers must pass it, or
    // the guard is just a wall in front of the build.
    for (const category of Object.keys(TARGET_CONSTANT)) {
      expect(() => rationalFromNumber(targetHeightPx(category))).not.toThrow()
    }
  })

  it('is target over the mean of the heights it was given', () => {
    // 2 sprites, heights 10 and 30, mean 20, target 40 → x2.
    expect(packFactor(40, [10, 30])).toEqual({ num: 2, den: 1 })
  })

  it('reduces to lowest terms, so the same factor has one spelling', () => {
    expect(packFactor(42, [40, 60, 80])).toEqual(packFactor(21, [20, 30, 40]))
  })

  it('refuses a category with nothing in it', () => {
    expect(() => packFactor(42, [])).toThrow(/no mean height/)
  })

  it('reads every category target from constants.rs and nowhere else', () => {
    // No 28/42/84/1.5 here: the expected value is rebuilt from the same two
    // constants the pipeline reads, so adjusting a multiplier moves both.
    for (const [category, name] of Object.entries(TARGET_CONSTANT)) {
      expect(constants().has(name)).toBe(true)
      expect(targetHeightPx(category)).toBe(constants().get('PLAYER_H') * constants().get(name))
    }
  })

  it('has no target for a category it has never heard of', () => {
    expect(() => targetHeightPx('spaceship')).toThrow(/no target height/)
  })

  it('leaves an empty sprite out of the mean', () => {
    const measured = [
      { category: 'rock', bounds: { x: 0, y: 0, w: 10, h: 10 } },
      { category: 'rock', bounds: { x: 0, y: 0, w: 0, h: 0 } },
      { category: 'rock', bounds: { x: 0, y: 0, w: 30, h: 30 } },
    ] as MeasuredSource[]
    const withBlank = packFactors(measured).get('rock')
    const without = packFactors(measured.filter((m) => m.bounds.h > 0)).get('rock')
    expect(withBlank).toEqual(without)
  })
})

describe('nearest-neighbour scaling', () => {
  const w = 5
  const h = 3
  const factor = 4
  const bits = new Uint8Array(w * h)
  for (let i = 0; i < bits.length; i++) bits[i] = i % 3 === 0 ? 1 : 0
  const bounds: Box = { x: 0, y: 0, w, h }
  /** An integer factor, routed through the live `scaleFor` — not a local copy. */
  const integer: Rational = { num: factor, den: 1 }

  it('divRound rounds half up without a float', () => {
    expect(divRound(3, 2)).toBe(2)
    expect(divRound(1, 2)).toBe(1)
    expect(divRound(1, 3)).toBe(0)
    expect(divRound(10, 5)).toBe(2)
  })

  it('never scales a sprite out of existence', () => {
    expect(scaleFor({ num: 1, den: 1000 }, bounds)).toEqual({ w: 1, h: 1 })
  })

  it('is exact at an integer factor: every source pixel becomes a solid block', () => {
    const size = scaleFor(integer, bounds)
    expect(size).toEqual({ w: w * factor, h: h * factor })
    const up = scaleNearest(bits, w, h, size.w, size.h)
    for (let y = 0; y < size.h; y++) {
      for (let x = 0; x < size.w; x++) {
        expect(up[size.w * y + x]).toBe(bits[w * Math.floor(y / factor) + Math.floor(x / factor)])
      }
    }
  })

  it('is reversible at an integer factor', () => {
    const size = scaleFor(integer, bounds)
    const up = scaleNearest(bits, w, h, size.w, size.h)
    const down = scaleNearest(up, size.w, size.h, w, h)
    expect([...down]).toEqual([...bits])
  })

  it('is not reversible at a non-integer factor — which is what makes the claim above a claim', () => {
    // The control. Round-tripping through a size that is not a multiple loses
    // columns, so "exact and reversible" is a property of the *integer* factor,
    // not something nearest-neighbour gives away for free.
    const odd = 7
    const up = scaleNearest(bits, w, h, odd, h)
    expect([...scaleNearest(up, odd, h, w, h)]).not.toEqual([...bits])
  })

  it('an off-by-one sampler fails the exactness assertion', () => {
    // Falsified against the same block of assertions, one pixel further along.
    const size = scaleFor(integer, bounds)
    const shifted = new Uint8Array(size.w * size.h)
    for (let y = 0; y < size.h; y++) {
      for (let x = 0; x < size.w; x++) {
        const sy = Math.min(h - 1, Math.floor(y / factor) + 1)
        const sx = Math.min(w - 1, Math.floor(x / factor) + 1)
        shifted[size.w * y + x] = bits[w * sy + sx] ?? 0
      }
    }
    expect([...shifted]).not.toEqual([...scaleNearest(bits, w, h, size.w, size.h)])
  })

  it('is bit-exact at a fractional factor, twice', () => {
    // No float enters the sampler, so this is repeatable rather than nearly so.
    const fraction: Rational = { num: 105, den: 167 }
    const size = scaleFor(fraction, { x: 0, y: 0, w: 93, h: 67 })
    const src = new Uint8Array(93 * 67)
    for (let i = 0; i < src.length; i++) src[i] = i % 7 === 0 ? 1 : 0
    const once = scaleNearest(src, 93, 67, size.w, size.h)
    const twice = scaleNearest(src, 93, 67, size.w, size.h)
    expect([...packBits(once, size.w, size.h)]).toEqual([...packBits(twice, size.w, size.h)])
  })

  it('scales a hand-checkable case exactly', () => {
    // 4x2 at x1/2 is 2x1. Source columns 0..3 map to dst 0,1 by floor(x*4/2):
    // dst 0 reads src 0, dst 1 reads src 2. Row 0 is [1,0,0,1] → [1,0].
    const src = new Uint8Array([1, 0, 0, 1, 0, 1, 1, 0])
    const size = scaleFor({ num: 1, den: 2 }, { x: 0, y: 0, w: 4, h: 2 })
    expect(size).toEqual({ w: 2, h: 1 })
    expect([...scaleNearest(src, 4, 2, size.w, size.h)]).toEqual([1, 0])
  })
})

describe('relative size inside a category', () => {
  // A short sprite and a tall one from the same pack. Mean height 30, target 60,
  // so the factor is x2 and the two must come out 20 and 80, not both 60.
  const short: Box = { x: 0, y: 0, w: 8, h: 10 }
  const tall: Box = { x: 0, y: 0, w: 40, h: 50 }
  const targetPx = 60
  const factor = packFactor(targetPx, [short.h, tall.h])

  it('is preserved by the live scaleFor', () => {
    expect(scaleFor(factor, short)).toEqual({ w: 16, h: 20 })
    expect(scaleFor(factor, tall)).toEqual({ w: 80, h: 100 })
    expect(() => assertRelativeSizePreserved((b) => scaleFor(factor, b), short, tall)).not.toThrow()
  })

  it('is destroyed by a per-sprite factor — the same assertion, falsified', () => {
    // Reading B lands every sprite on the target height. This is the assertion
    // that tells the two policies apart; without it "output height is about
    // right" would pass under either.
    expect(perSpriteSize(targetPx, short).h).toBe(perSpriteSize(targetPx, tall).h)
    expect(() =>
      assertRelativeSizePreserved((b) => perSpriteSize(targetPx, b), short, tall),
    ).toThrow(/spread is gone/)
  })

  it('holds across every real category', () => {
    // The committed table, not a fixture: the tallest and shortest object of each
    // category, in the same proportion the sources were.
    const byCategory = new Map<string, typeof manifest.objects>()
    for (const o of manifest.objects) {
      if (!byCategory.has(o.category)) byCategory.set(o.category, [])
      byCategory.get(o.category)!.push(o)
    }
    expect(byCategory.size).toBeGreaterThan(0)
    for (const [category, objects] of byCategory) {
      const heights = objects.map((o) => o.h)
      expect(Math.max(...heights), `${category} is all one height`).toBeGreaterThan(
        Math.min(...heights),
      )
    }
  })
})

describe('ids are array positions', () => {
  const entries = [0, 1, 2].map((id) => ({
    id,
    key: `k${id}`,
    w: 2,
    h: 2,
    anchorX: 1,
    anchorY: 2,
    packed: packBits(new Uint8Array([1, 0, 0, 1]), 2, 2),
  }))

  it('accepts a contiguous table', () => {
    expect(() => assertIdsMatchPosition(entries)).not.toThrow()
  })

  it('fails when an entry is inserted at the front', () => {
    // §B16: both registries silently assumed this and a laser resolved as a
    // bazooka. Falsified at the live binding site — `encodeMasksBin` runs the
    // same assertion the build runs.
    const shifted = [{ ...entries[0]!, id: 99, key: 'inserted' }, ...entries]
    expect(() => assertIdsMatchPosition(shifted)).toThrow(/must equal array position/)
    expect(() => encodeMasksBin(shifted)).toThrow(/must equal array position/)
  })

  it('names the offender', () => {
    const broken = entries.map((e, i) => (i === 1 ? { ...e, id: 7 } : e))
    expect(() => assertIdsMatchPosition(broken)).toThrow(/k1 is at position 1 with id 7/)
  })
})

describe('masks.bin round-trips through its own encoder', () => {
  it('gives back every mask it was given', () => {
    const entries = [
      { id: 0, key: 'a', w: 3, h: 2, anchorX: 1, anchorY: 2, packed: packBits(new Uint8Array([1, 0, 1, 0, 1, 0]), 3, 2) },
      { id: 1, key: 'b', w: 2, h: 2, anchorX: 1, anchorY: 2, packed: packBits(new Uint8Array([1, 1, 0, 0]), 2, 2) },
    ]
    const records = decodeMasksBin(encodeMasksBin(entries))
    expect(records.map((r) => [r.id, r.w, r.h])).toEqual([
      [0, 3, 2],
      [1, 2, 2],
    ])
    expect([...records[0]!.packed]).toEqual([...entries[0]!.packed])
    expect([...records[1]!.packed]).toEqual([...entries[1]!.packed])
  })

  it('rejects a foreign file', () => {
    expect(() => decodeMasksBin(new Uint8Array(64))).toThrow(/magic/)
  })
})

describe('the committed table', () => {
  const records = decodeMasksBin(blob)

  it('holds objects at all', () => {
    // The control: every assertion below passes over an empty table.
    expect(records.length).toBeGreaterThan(0)
    expect(manifest.objects.length).toBeGreaterThan(0)
  })

  it('is counted the same at both ends', () => {
    expect(records.length).toBe(manifest.objects.length)
  })

  it("every manifest entry's w x h matches its blob length in bits", () => {
    const wrong = manifest.objects
      .filter((o, i) => {
        const rec = records[i]
        return !rec || rec.len !== packedLength(o.w, o.h) || rec.w !== o.w || rec.h !== o.h
      })
      .map((o) => o.key)
    expect(wrong).toEqual([])
  })

  it('agrees with the blob on every offset and anchor', () => {
    const wrong = manifest.objects
      .filter((o, i) => {
        const rec = records[i]
        return (
          !rec ||
          rec.offset !== o.offset ||
          rec.id !== o.id ||
          rec.anchorX !== o.anchor.x ||
          rec.anchorY !== o.anchor.y
        )
      })
      .map((o) => o.key)
    expect(wrong).toEqual([])
  })

  it('has contiguous ids matching array position', () => {
    expect(() => assertIdsMatchPosition(manifest.objects)).not.toThrow()
  })

  it('names any object whose mask is blank', () => {
    const blank = manifest.objects
      .filter((_o, i) => popcount(records[i]!.packed) === 0)
      .map((o) => o.key)
    expect(blank).toEqual([])
  })

  it('is listed in the asset manifest, so something actually loads it', () => {
    const assets = JSON.parse(readFileSync(join(root, 'assets/manifest.json'), 'utf8')) as {
      atlases: Array<{ key: string; png: string; json: string }>
    }
    expect(assets.atlases.map((a) => a.key)).toContain('objects')
    expect(existsSync(join(root, 'assets/atlas/objects.png'))).toBe(true)
  })

  it('has an atlas frame for every object', () => {
    const atlas = JSON.parse(readFileSync(join(root, 'assets/atlas/objects.json'), 'utf8')) as {
      frames: Record<string, { frame: { w: number; h: number } }>
    }
    const missing = manifest.objects.filter((o) => !atlas.frames[o.key]).map((o) => o.key)
    expect(missing).toEqual([])
    const mismatched = manifest.objects
      .filter((o) => {
        const f = atlas.frames[o.key]
        return !f || f.frame.w !== o.w || f.frame.h !== o.h
      })
      .map((o) => o.key)
    expect(mismatched).toEqual([])
  })
})

describe('what the packs contribute', () => {
  const havePacks = existsSync(PACK_ROOT)

  it.runIf(havePacks)('selects nothing from the clouds pack', () => {
    // §D0: fill 0.40 and wispy. They route to the sky layer, not the terrain.
    expect(PACKS.map((p) => p.pack)).not.toContain('clouds')
    expect(selectSources().filter((s) => s.pack === 'clouds')).toEqual([])
  })

  it.runIf(havePacks)('takes ruins from one variant directory, not four', () => {
    // 164 files, 40 objects: four render variants of the same basenames, plus
    // four `Assets*_source.png` contact sheets at the top level that no
    // dedup-by-basename would remove.
    const ruins = selectSources().filter((s) => s.pack === 'ruins')
    const onDisk = readdirSync(join(PACK_ROOT, 'ruins')).filter((n) =>
      statSync(join(PACK_ROOT, 'ruins', n)).isDirectory(),
    )
    expect(onDisk.length).toBeGreaterThan(1)
    expect(new Set(ruins.map((s) => s.rel.split('/')[0])).size).toBe(1)
    expect(ruins.every((s) => s.rel.startsWith('Assets/'))).toBe(true)
    expect(ruins.length).toBe(
      readdirSync(join(PACK_ROOT, 'ruins/Assets')).filter((n) => n.endsWith('.png')).length,
    )
  })

  it.runIf(havePacks)('names any selected PNG that thresholds to nothing', () => {
    const blank = selectSources()
      .filter((s) => {
        const png = PNG.sync.read(readFileSync(s.file))
        const bits = thresholdAlpha(png.data, png.width, png.height, THRESHOLD)
        return opaqueBounds(bits, png.width, png.height).w === 0
      })
      .map((s) => `${s.pack}/${s.rel}`)
    expect(blank).toEqual([])
  })

  it.runIf(havePacks)('produced one object per selected source', () => {
    expect(manifest.objects.length).toBe(selectSources().length)
  })
})
