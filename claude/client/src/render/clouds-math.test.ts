/**
 * T16.04 — which cloud sprite, and which colour set.
 *
 * **What this file proves, and what it does not.** Everything here is pure: the
 * seeded pick, the phase → colour table, and the frame names. None of it is a
 * pixel assertion. `client/vite.config.ts` runs vitest with
 * `environment: 'node'` and there is no canvas in the client's dependencies, so
 * `ParallaxLayer` cannot be constructed here at all — it takes a
 * `Phaser.Scene`, makes textures and adds images.
 *
 * That a cloud is **visibly** darker at midnight than at noon is a claim about
 * a frame, so it is asserted on sampled pixels with a control region and a
 * control frame (§C2) in `scripts/checks/living-sky.mjs` — which is **written
 * and not run** in this task, D-07 having deferred every browser step to the
 * M16 sweep. A green run of this file does not mean the sky changed colour.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLOUD_SHAPES,
  CLOUD_SIZES,
  cloudColourForPhase,
  cloudFrame,
  cloudSpriteTint,
  cloudSprites,
} from './clouds-math'
import { cloudField, cloudTint, skyPhase, type SkyPhase } from './sky-math'
import { PACK_ROOT, selectClouds } from '../../../scripts/build-cloud-atlas.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const COUNT = 12

describe('the colour set for a sky phase', () => {
  it('is white by day, grey at dusk and dawn, black at night (§C14)', () => {
    expect(cloudColourForPhase('day')).toBe('white')
    expect(cloudColourForPhase('morning')).toBe('white')
    expect(cloudColourForPhase('afternoon')).toBe('white')
    expect(cloudColourForPhase('dawn')).toBe('gray')
    expect(cloudColourForPhase('evening')).toBe('gray')
    expect(cloudColourForPhase('night')).toBe('black')
  })

  it('actually varies across the day — the control', () => {
    // Without this, a table returning 'white' for everything passes every
    // assertion above that mentions white, and §A32's mistake is judging a
    // palette in one lighting condition.
    const phases: SkyPhase[] = ['morning', 'day', 'afternoon', 'evening', 'night', 'dawn']
    expect(new Set(phases.map((p) => cloudColourForPhase(p))).size).toBe(3)
  })

  it('is black in a storm whatever the hour — a branch with no caller yet', () => {
    // §C14 names it and it is implemented, but nothing calls it: there is no
    // storm state on the client. This asserts the arm, not that the game uses
    // it. See the note on `cloudColourForPhase`.
    expect(cloudColourForPhase('day', true)).toBe('black')
    expect(cloudColourForPhase('day', false)).toBe('white')
  })
})

describe('the seeded sprite pick', () => {
  it('gives the same clouds for the same seed', () => {
    expect(cloudSprites(4242, COUNT)).toEqual(cloudSprites(4242, COUNT))
  })

  it('gives different clouds for different seeds — the control', () => {
    // "Same seed → same clouds" is satisfied by a function returning a constant.
    const a = cloudSprites(4242, COUNT)
    const b = cloudSprites(31337, COUNT)
    expect(a).not.toEqual(b)
  })

  it('picks something, and picks more than one thing', () => {
    // The other half of the control: twelve identical clouds are deterministic
    // too, and would make the pack pointless.
    const picked = cloudSprites(4242, COUNT)
    expect(picked.length).toBe(COUNT)
    expect(new Set(picked.map((s) => `${s.shape}/${s.size}`)).size).toBeGreaterThan(1)
  })

  it('stays inside the pack across many seeds', () => {
    for (let seed = 0; seed < 200; seed++) {
      for (const s of cloudSprites(seed, COUNT)) {
        expect(s.shape, `seed ${seed}`).toBeGreaterThanOrEqual(1)
        expect(s.shape, `seed ${seed}`).toBeLessThanOrEqual(CLOUD_SHAPES)
        expect(s.size, `seed ${seed}`).toBeGreaterThanOrEqual(1)
        expect(s.size, `seed ${seed}`).toBeLessThanOrEqual(CLOUD_SIZES)
      }
    }
  })

  it('reaches all eight shape families, not three', () => {
    // The assertion the task file's own text would have failed. T16.04 says
    // three; the pack has eight, and drawing from three would quietly discard
    // five-eighths of the variety.
    const seen = new Set<number>()
    for (let seed = 0; seed < 100; seed++) {
      for (const s of cloudSprites(seed, COUNT)) seen.add(s.shape)
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('reaches all five sizes', () => {
    const seen = new Set<number>()
    for (let seed = 0; seed < 100; seed++) {
      for (const s of cloudSprites(seed, COUNT)) seen.add(s.size)
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })
})

describe('per-cloud brightness and alpha (§E11)', () => {
  const band = () => cloudSprites(4242, 24, 0.62, 1.0, 0.7, 1.0)

  it('gives the same clouds the same brightness for the same seed', () => {
    const a = band()
    const b = band()
    expect(a.map((c) => c.bright)).toEqual(b.map((c) => c.bright))
    expect(a.map((c) => c.alpha)).toEqual(b.map((c) => c.alpha))
  })

  it('varies across the sky rather than giving twelve clouds one value', () => {
    const sp = band()
    // The control the assertion needs: a constant would satisfy "inside the
    // band" perfectly, and twelve identical clouds is the sheet §E11 exists to
    // break up.
    expect(new Set(sp.map((c) => c.bright.toFixed(3))).size).toBeGreaterThan(4)
    expect(new Set(sp.map((c) => c.alpha.toFixed(3))).size).toBeGreaterThan(4)
  })

  it('stays inside the band it was given', () => {
    for (const c of band()) {
      expect(c.bright).toBeGreaterThanOrEqual(0.62)
      expect(c.bright).toBeLessThanOrEqual(1.0)
      expect(c.alpha).toBeGreaterThanOrEqual(0.7)
      expect(c.alpha).toBeLessThanOrEqual(1.0)
    }
  })

  it('does not move the shapes it was drawn alongside', () => {
    // §C14 promises a seed always looks the same. The brightness draws are taken
    // for **every** cloud in a fixed order, so adding them cannot shift the
    // shape or size picks — which is what a conditional draw would have done.
    const withBand = cloudSprites(4242, 12, 0.62, 1.0, 0.7, 1.0)
    const without = cloudSprites(4242, 12)
    expect(withBand.map((c) => c.shape)).toEqual(without.map((c) => c.shape))
    expect(withBand.map((c) => c.size)).toEqual(without.map((c) => c.size))
  })

  it('darkens the tint per cloud without touching the phase that chose it', () => {
    const sp = band()
    const dark = sp.reduce((a, b) => (a.bright < b.bright ? a : b))
    const light = sp.reduce((a, b) => (a.bright > b.bright ? a : b))
    const d = cloudSpriteTint(0.62, dark)
    const l = cloudSpriteTint(0.62, light)
    expect(d.color).toBeLessThan(l.color)
    expect(d.alpha).not.toBe(l.alpha)

    // **It varies within the set, never across it.** The colour set is still
    // whatever `cloudColourForPhase` picked — this only multiplies it — so a
    // black cloud cannot come out white at midnight, which is the §C14 bug the
    // whole three-set arrangement exists to prevent.
    for (const c of sp) {
      const { color } = cloudSpriteTint(0.62, c)
      expect(color).toBeLessThanOrEqual(0xffffff)
      const grey = color & 0xff
      expect((color >> 16) & 0xff).toBe(grey)
      expect((color >> 8) & 0xff).toBe(grey)
    }
  })

  it('is a no-op when no sprite is given — the fallback path is unchanged', () => {
    expect(cloudSpriteTint(0.62)).toEqual({ color: 0xffffff, alpha: 0.62 })
  })
})

describe('the atlas the renderer asks for', () => {
  const atlasPath = join(root, 'assets/atlas/clouds.json')

  it('names every frame the pick can produce', () => {
    // Both ends: every (colour, shape, size) this module can ask for has to
    // exist in the file `build-cloud-atlas.mjs` wrote. A pick that drifts out of
    // the atlas draws nothing and logs nothing.
    expect(existsSync(atlasPath), 'assets/atlas/clouds.json is missing').toBe(true)
    const atlas = JSON.parse(readFileSync(atlasPath, 'utf8')) as {
      frames: Record<string, unknown>
    }
    const missing: string[] = []
    for (const colour of ['white', 'gray', 'black'] as const) {
      for (let shape = 1; shape <= CLOUD_SHAPES; shape++) {
        for (let size = 1; size <= CLOUD_SIZES; size++) {
          const frame = cloudFrame(colour, { shape, size })
          if (!atlas.frames[frame]) missing.push(frame)
        }
      }
    }
    expect(missing).toEqual([])
    // 3 colours x 8 shapes x 5 sizes. The five `Lightning` sprites are NOT here
    // — §D0 and T16.04 both leave them for the weather scheduler.
    expect(Object.keys(atlas.frames).length).toBe(3 * CLOUD_SHAPES * CLOUD_SIZES)
  })

  it('has no lightning in it', () => {
    const atlas = JSON.parse(readFileSync(atlasPath, 'utf8')) as {
      frames: Record<string, unknown>
    }
    expect(Object.keys(atlas.frames).filter((f) => /lightning/i.test(f))).toEqual([])
  })

  it('was built from 120 sprites spanning every family, counted by name', () => {
    // A glob that silently matched three shape directories, or forty files,
    // would build a working atlas and a five-eighths-poorer sky with nothing
    // looking broken — D-06's failure mode one layer down. So: by name, not by
    // length.
    if (!existsSync(PACK_ROOT)) return
    const picked = selectClouds()
    expect([...new Set(picked.map((s) => s.colour))].sort()).toEqual(['black', 'gray', 'white'])
    expect([...new Set(picked.map((s) => s.shape))].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ])
    expect([...new Set(picked.map((s) => s.size))].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
    expect(picked.length).toBe(3 * CLOUD_SHAPES * CLOUD_SIZES)
    // Every combination exactly once — a duplicate would pass the counts above
    // while some other combination went missing.
    expect(new Set(picked.map((s) => s.frame)).size).toBe(picked.length)
    // §D0 and T16.04: Lightning belongs to the weather scheduler.
    expect(picked.filter((s) => /lightning/i.test(s.file))).toEqual([])
  })

  it('is listed in the asset manifest, so something actually loads it', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'assets/manifest.json'), 'utf8')) as {
      atlases: Array<{ key: string }>
    }
    expect(manifest.atlases.map((a) => a.key)).toContain('clouds')
  })
})

describe('the tint a sprite cloud is drawn with', () => {
  /**
   * Found by asking `skyPhase`, never assumed.
   *
   * The first version of this test took `u = 0.5` for noon and `u = 0.0` for
   * midnight and went red: 0.0 is brighter than 0.5 in the cycle table, so the
   * assertion was measuring the opposite of what it said. A fixture that names
   * a time of day has to get it from the thing that defines the day.
   */
  const uOf = (want: SkyPhase): number => {
    for (let i = 0; i < 1000; i++) {
      const u = i / 1000
      if (skyPhase(u) === want) return u
    }
    throw new Error(`no u in the cycle has phase ${want}`)
  }

  it('does not darken a cloud that is already the right colour', () => {
    // The double-darkening risk: `cloudTint` mixes toward the sky AND scales
    // alpha by its luminance, both jobs falling to it because a white blob is
    // all it had. Applied on top of a black night sprite that is two darkenings.
    const blob = cloudTint(uOf('night'), 0.62, 0.55, 0.4)
    const sprite = cloudSpriteTint(0.62)

    expect(sprite.color).toBe(0xffffff)
    expect(sprite.alpha).toBe(0.62)
    // The control that makes this mean something: the blob path really is
    // darker at midnight, so "the sprite path is not" is a difference and not a
    // restatement.
    expect(blob.alpha).toBeLessThan(sprite.alpha)
    expect(blob.color).not.toBe(0xffffff)
  })

  it('leaves the procedural blob path exactly as T15.03 had it', () => {
    // `cloudTint` is unchanged and still varies across the day — this task adds
    // a second path beside it rather than editing it.
    const noon = cloudTint(uOf('day'), 0.62, 0.55, 0.4)
    const midnight = cloudTint(uOf('night'), 0.62, 0.55, 0.4)
    expect(noon.color).not.toBe(midnight.color)
    expect(noon.alpha).toBeGreaterThan(midnight.alpha)
  })
})

describe('T15.03s cloud field is untouched', () => {
  /**
   * Pinned against `9031e62`, because nothing else would catch it.
   *
   * `cloudField` draws x, y, scale and speed from one xorshift seeded
   * `clientTagSeed(seed, 'clouds')`. Had the shape pick drawn from that same
   * stream, every cloud's position, size and drift would have shifted on every
   * seed — and T15.03's own determinism tests pin "same seed twice", which stays
   * green straight through that. The tell is a cross-version comparison, and
   * there was none.
   *
   * `cloudSprites` uses its own `'cloud-shapes'` tag, and `sky-math.ts` and
   * `noise-math.ts` are byte-identical to `9031e62`. This is the assertion that
   * keeps both true.
   */
  const PINNED_9031E62 = [
    [0.081484, 0.138847, 0.526514, 1.287698],
    [0.136399, 0.105577, 0.464573, 1.197965],
    [0.224822, 0.23411, 0.618455, 1.059467],
    [0.318545, 0.421322, 0.538574, 0.875607],
    [0.374743, 0.316646, 0.752826, 0.894626],
    [0.43104, 0.38282, 0.927758, 0.948641],
    [0.527667, 0.399215, 0.915586, 1.129531],
    [0.5991, 0.165189, 0.51297, 1.137818],
    [0.740069, 0.052641, 0.584044, 1.289807],
    [0.81706, 0.24607, 0.730902, 1.073915],
    [0.873389, 0.244921, 0.81309, 0.741262],
    [0.973289, 0.052533, 0.43551, 1.186278],
  ]

  it('produces the same field it did before the sprite pick existed', () => {
    const field = cloudField(4242, COUNT, 0.04, 0.46, 0.42, 0.95, 0.6)
    const actual = field.map((c) => [
      Number(c.x.toFixed(6)),
      Number(c.y.toFixed(6)),
      Number(c.scale.toFixed(6)),
      Number(c.speed.toFixed(6)),
    ])
    expect(actual).toEqual(PINNED_9031E62)
  })

  it('and the sprite pick draws from a different stream', () => {
    // The control: if both used `'clouds'` the pin above would already be red,
    // but only for the seed it pins. This says the streams are independent for
    // any seed, by asking whether one consumes the other.
    const before = cloudField(777, COUNT, 0.04, 0.46, 0.42, 0.95, 0.6)
    cloudSprites(777, COUNT)
    const after = cloudField(777, COUNT, 0.04, 0.46, 0.42, 0.95, 0.6)
    expect(after).toEqual(before)
  })
})
