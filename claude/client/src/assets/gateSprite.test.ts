import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import {
  alphaStats,
  borderSeeds,
  clearConnected,
  cutBackdrop,
  downscaleRgba,
  isBackdrop,
  portalLooksLikeARing,
} from '../../../scripts/lib/gate-sprite.mjs'
import { targetSize } from '../../../scripts/build-gate-sprite.mjs'
import { constants } from '../../../scripts/lib/rust-constants.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SOURCE = join(root, 'tasks/M21/assets/gate.png')
const BUILT = join(root, 'assets/images/gate.png')

/**
 * T21.12's background removal (`docs/50` §8, `docs/51` §5).
 *
 * The source art is **fully opaque with a white background**, so "remove the
 * background" is real work. The trap it is written against: a global
 * white-to-transparent threshold punches holes through the stone's own
 * highlights, and the failure is invisible until somebody looks at the sprite.
 */
describe('the gate sprite build (T21.12)', () => {
  it('starts from a source that is genuinely opaque, or this tests nothing', () => {
    const src = PNG.sync.read(readFileSync(SOURCE))
    const stats = alphaStats(src.data)
    expect(stats.clear, 'the source already has transparency').toBe(0)
    expect(stats.opaque).toBeGreaterThan(0)
  })

  it('clears the background and the portal, and leaves the stone alone', () => {
    const src = PNG.sync.read(readFileSync(SOURCE))
    const rgba = Uint8Array.from(src.data)
    const cut = cutBackdrop(rgba, src.width, src.height)

    // Both fills did something. A fill that matched nothing and one that worked
    // are otherwise the same silent success.
    expect(cut.outside, 'the background fill cleared nothing').toBeGreaterThan(0)
    expect(cut.interior, 'the portal fill cleared nothing').toBeGreaterThan(0)

    const at = (x: number, y: number) => rgba[((src.width * y + x) << 2) + 3]
    // The border is gone.
    expect(at(0, 0)).toBe(0)
    expect(at(src.width - 1, 0)).toBe(0)
    expect(at(0, src.height - 1)).toBe(0)
    // The portal is gone — sampled at the region the fill itself reported, so
    // this cannot drift from the art.
    const p = cut.portal!
    expect(p).toBeTruthy()
    expect(at(Math.round(p.cx * src.width), Math.round(p.cy * src.height))).toBe(0)

    // **The half that a threshold would fail**: the stone between the portal and
    // the border is still there. Sampled on the ring's left limb, a third of the
    // way down the portal box — inside the arch, outside the hole.
    const limbX = Math.round((p.cx - p.rx) * src.width) - 12
    const limbY = Math.round(p.cy * src.height)
    expect(at(limbX, limbY), 'the fill ate through the stone ring').toBe(255)
  })

  it('does not leak through a wall of stone — the fill is connectivity, not colour', () => {
    // A 9x9 image: white border, a closed black ring, white inside. A threshold
    // would clear both whites; a flood fill from the border clears only the
    // outer one.
    const w = 9
    const h = 9
    const rgba = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      const x = i % w
      const y = (i / w) | 0
      const onRing = x >= 2 && x <= 6 && y >= 2 && y <= 6 && (x === 2 || x === 6 || y === 2 || y === 6)
      const v = onRing ? 10 : 255
      rgba[i * 4] = v
      rgba[i * 4 + 1] = v
      rgba[i * 4 + 2] = v
      rgba[i * 4 + 3] = 255
    }
    const outside = clearConnected(rgba, w, h, borderSeeds(w, h), 236)
    expect(outside.cleared).toBeGreaterThan(0)
    // The enclosed white survived the border fill.
    const centre = ((w * 4 + 4) << 2) + 3
    expect(rgba[centre], 'the border fill leaked through the ring').toBe(255)
    // And the control: seeding inside does clear it.
    const inside = clearConnected(rgba, w, h, [[4, 4]], 236)
    expect(inside.cleared).toBeGreaterThan(0)
    expect(rgba[centre]).toBe(0)
  })

  it('treats a saturated pale colour as paint, not paper', () => {
    expect(isBackdrop(255, 255, 255, 236)).toBe(true)
    expect(isBackdrop(240, 242, 241, 236)).toBe(true)
    expect(isBackdrop(100, 100, 100, 236)).toBe(false)

    // **The case the saturation clause exists for**, and the first version of
    // this test did not contain one: every colour it tried was decided by
    // brightness alone, so deleting `max - min <= 12` from `isBackdrop` left all
    // four assertions green. The test's name was a claim it never checked.
    //
    // Bright enough to pass the brightness gate (min 237 >= 236) and clearly
    // tinted (spread 18 > 12): a pale highlight, which is paint.
    expect(isBackdrop(255, 246, 237, 236), 'a tinted highlight was taken for paper').toBe(false)
    // And the boundary, from both sides, so the clause cannot drift.
    expect(isBackdrop(249, 240, 237, 236)).toBe(true) // spread 12, inclusive
    expect(isBackdrop(250, 240, 237, 236)).toBe(false) // spread 13
  })

  /**
   * The committed sprite must be **what the source builds to right now**.
   *
   * `build-gate-sprite.mjs --check` exists for this, but nothing in
   * `scripts/check.sh` runs it — and the same is true of
   * `build-object-masks.mjs --check`, so this is a standing gap rather than
   * something special about the gate. A derived artifact nobody re-derives is a
   * file that silently stops matching its source, and the symptom here would be
   * an old gate on screen with the build script innocently green.
   *
   * So the staleness check lives where the gate will actually run it.
   */
  /**
   * The shape guard, exercised — which is the whole reason it is a pure
   * function rather than four lines inside the build script.
   *
   * On the shipped art the only reachable build failure is `interior === 0`, so
   * inline this check could never run: it would have been a comment claiming a
   * guarantee nothing tested. Both halves here, because a guard that cannot
   * reject is not a guard and one that cannot accept blocks the build.
   */
  it('rejects a region that is not the ring, and accepts one that is', () => {
    const real = { cx: 0.499, cy: 0.375, rx: 0.284, ry: 0.262 }
    expect(portalLooksLikeARing(real).ok, 'the real portal was rejected').toBe(true)

    // A rune-sized speck the fill might find if the seed missed the hole.
    const speck = { cx: 0.5, cy: 0.5, rx: 0.03, ry: 0.03 }
    expect(portalLooksLikeARing(speck).ok).toBe(false)
    expect(portalLooksLikeARing(speck).why).toMatch(/too small/)

    // A region off to one side: the fill escaped through a gap in the stone.
    const escaped = { cx: 0.2, cy: 0.375, rx: 0.3, ry: 0.3 }
    expect(portalLooksLikeARing(escaped).ok).toBe(false)
    expect(portalLooksLikeARing(escaped).why).toMatch(/off-centre/)

    expect(portalLooksLikeARing(null).ok).toBe(false)
  })

  it('ships a sprite the source still builds to', () => {
    const built = PNG.sync.read(readFileSync(BUILT))
    const src = PNG.sync.read(readFileSync(SOURCE))

    // **Through the builder's own `targetSize`**, not a second copy of its
    // `WIDTH_IN_PADS`. A duplicated 1.6 here makes a *correct* retune of the
    // gate's size fail this test for the wrong reason, and pins nothing that
    // `targetSize` does not already pin.
    const want = targetSize(src.width, src.height)
    expect({ w: built.width, h: built.height }).toEqual(want)
    // And the size is a function of `PAD_W`, which is the claim `targetSize`
    // makes — asserted here so the two cannot quietly decouple.
    expect(built.width).toBeGreaterThan(constants().get('PAD_W'))

    // Re-derive and compare **per pixel**, not by histogram.
    //
    // The first version compared `alphaStats`, which is three integers: any
    // regression preserving the counts while moving the pixels passed. The one
    // that matters is dropping the un-premultiply in `downscaleRgba` — it
    // darkens every soft edge into the halo that function exists to prevent and
    // leaves alpha untouched. So colour is compared too.
    const rgba = Uint8Array.from(src.data)
    cutBackdrop(rgba, src.width, src.height)
    const small = downscaleRgba(rgba, src.width, src.height, built.width, built.height)
    let differing = 0
    for (let i = 0; i < small.length; i++) {
      if (small[i] !== built.data[i]) differing++
    }
    expect(differing, 'the committed sprite is not what the source builds to').toBe(0)

    // And the controls: it is neither fully opaque nor fully transparent.
    const stats = alphaStats(built.data)
    expect(stats.clear, 'the shipped sprite has no transparency at all').toBeGreaterThan(0)
    expect(stats.opaque, 'the shipped sprite is entirely transparent').toBeGreaterThan(0)
    const at = (x: number, y: number) => built.data[((built.width * y + x) << 2) + 3]
    expect(at(0, 0)).toBe(0)
  })
})
