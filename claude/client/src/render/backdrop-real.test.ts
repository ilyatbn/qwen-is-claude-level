/**
 * `BackdropMask` against **real generated terrain**.
 *
 * Every defect this class has had lived exclusively in real maps: the synthetic
 * `FakeMask` tests passed throughout all three wrong implementations. §A17 makes
 * the point general — anything whose failure mode only exists in real terrain gets
 * a test against real terrain.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { C, Core, MapScale } from '../core'
import { BackdropMask } from './chunkBake'

let core: Core
let bd: BackdropMask
let w = 0
let h = 0

/**
 * Every scale the game can ship, not just the one the threshold was tuned on
 * (§A19). §A18 picked its value from a table measured on one medium map while
 * §A1 ships Large, and the bound it chose was violated at Large.
 */
const CASES = [
  ['small/777', MapScale.Small, 777n],
  ['medium/4242', MapScale.Medium, 4242n],
  ['large/99', MapScale.Large, 99n],
] as const

function build(scale: MapScale, seed: bigint) {
  core.generate(seed, scale)
  w = core.width
  h = core.height
  const c = C()
  bd = new BackdropMask(core, undefined, c.SKY_MARGIN, c.BACKDROP_RAYS, c.BACKDROP_RAY_LEN, c.BACKDROP_MIN_HITS, c.BACKDROP_MIN_UP)
}

beforeAll(async () => {
  const url = new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url)
  core = await Core.init(readFileSync(fileURLToPath(url)))
}, 120_000)

/** Air with rock somewhere above it in its own column. */
function roofed(x: number, y: number): boolean {
  for (let yy = y - 1; yy >= 0; yy--) if (core.solidAt(x, yy)) return true
  return false
}

for (const [name, scale, seed] of CASES)
  describe(`BackdropMask on a real map (${name})`, () => {
    beforeAll(() => build(scale, seed), 120_000)

  it('draws almost no enclosed air as sky', () => {
    // The §A14 implementation failed this at 49.3%.
    let enclosed = 0
    let asSky = 0
    for (let y = 8; y < h; y += 4) {
      for (let x = 8; x < w; x += 4) {
        if (core.solidAt(x, y)) continue
        // "Enclosed" measured independently of the class under test: rock above,
        // below, and on both sides within the ray length.
        if (!roofed(x, y)) continue
        let below = false
        for (let d = 1; d < 320 && !below; d++) below = core.solidAt(x, y + d)
        let left = false
        for (let d = 1; d < 320 && !left; d++) left = core.solidAt(x - d, y)
        let right = false
        for (let d = 1; d < 320 && !right; d++) right = core.solidAt(x + d, y)
        if (!(below && left && right)) continue
        enclosed++
        if (!bd.insideAt(x, y)) asSky++
      }
    }
    expect(enclosed).toBeGreaterThan(1000)
    const share = asSky / enclosed
    console.log(`   ${name}: ${(share * 100).toFixed(1)}% of enclosed air drawn as sky`)
    // Standing in a cavern and seeing daylight is the failure that has recurred
    // three times, so this keeps the tighter bound. 3% at large, where the measured
    // value is 2.9% — see the table on the sibling test.
    const bound = scale === MapScale.Large ? 0.03 : 0.02
    expect(share, `${(share * 100).toFixed(1)}% of enclosed air drawn as sky`).toBeLessThan(bound)
  })

  it('draws almost no open sky as backdrop', () => {
    let open = 0
    let asBackdrop = 0
    for (let y = 8; y < h; y += 4) {
      for (let x = 8; x < w; x += 4) {
        if (core.solidAt(x, y)) continue
        // **Unambiguous** open sky: nothing above it, and no rock anywhere near.
        // "Unroofed" alone is not enough — the floor of a roofless canyon has no
        // rock above it and is plainly enclosed, so counting it as open sky would
        // be measuring the wrong thing rather than measuring a defect.
        if (roofed(x, y)) continue
        let near = false
        for (let d = 1; d <= 120 && !near; d += 2) {
          near =
            core.solidAt(x + d, y) ||
            core.solidAt(x - d, y) ||
            core.solidAt(x, y + d) ||
            core.solidAt(x, y - d)
        }
        if (near) continue
        open++
        if (bd.insideAt(x, y)) asBackdrop++
      }
    }
    expect(open).toBeGreaterThan(1000)
    const share = asBackdrop / open
    console.log(`   ${name}: ${(share * 100).toFixed(1)}% of open sky drawn as backdrop`)
    // §A21's accepted trade, with the numbers written down as it requires.
    //
    // Measured from a FRESH wasm build at BACKDROP_MIN_HITS 4 + BACKDROP_MIN_UP
    // 0.5 (enclosed-as-sky / this metric / crest halo):
    //
    //   small/777    0.00% / 16.42% / 3.3px
    //   medium/4242  1.42% /  5.86% / 4.7px
    //   large/99     2.49% /  7.18% / 3.9px
    //
    // No configuration satisfies both of §A17's bounds at all three scales, so
    // the milder failure was taken: enclosed air showing daylight is a hole
    // through the world, sky drawn dark is haze. These are therefore REGRESSION
    // ceilings on an accepted trade, not the design bound — set just above the
    // measured value so a real regression still trips them.
    //
    // The residual is air beside and below a floating island's flank, reached by
    // a diagonal upward ray while the column overhead is clear. It concentrates
    // at small scale because a small map packs six islands into a small sky.
    const bound = scale === MapScale.Small ? 0.2 : 0.09
    expect(share, `${(share * 100).toFixed(1)}% of open sky drawn as backdrop`).toBeLessThan(bound)
  })

  it('keeps the interior boundary off the coarse grid', () => {
    // Measured as grid ALIGNMENT rather than run length. A run-length metric on a
    // real map mostly measures how flat the terrain is — a plateau produces a long
    // constant run legitimately — whereas the defect being guarded against is the
    // boundary snapping to the 8 px cell lattice.
    const CELL = BackdropMask.CELL
    let boundary = 0
    let aligned = 0
    for (let y = 8; y < h - 8; y += 2) {
      for (let x = 8; x < w - 8; x += 2) {
        if (core.solidAt(x, y)) continue
        const here = bd.insideAt(x, y)
        // A transition between interior and exterior, in air.
        if (here === bd.insideAt(x + 2, y)) continue
        boundary++
        if (x % CELL === 0 || (x + 2) % CELL === 0) aligned++
      }
    }
    // Control: the same statistic on the raw terrain silhouette, which is
    // generated from noise and cannot be grid-aligned. If the metric reports a
    // similar figure there, the metric is measuring itself and not the boundary.
    let ctrlBoundary = 0
    let ctrlAligned = 0
    for (let y = 8; y < h - 8; y += 2) {
      for (let x = 8; x < w - 8; x += 2) {
        if (core.solidAt(x, y) === core.solidAt(x + 2, y)) continue
        ctrlBoundary++
        if (x % CELL === 0 || (x + 2) % CELL === 0) ctrlAligned++
      }
    }
    const control = ctrlAligned / ctrlBoundary
    console.log(`   control (terrain silhouette): ${(control * 100).toFixed(1)}% aligned`)

    expect(boundary).toBeGreaterThan(500)
    // Chance alignment for a 2 px stride against an 8 px cell is 50%; a
    // grid-snapped boundary drives it toward 100%.
    const share = aligned / boundary
    expect(share, `${(share * 100).toFixed(1)}% of boundary transitions sit on the cell grid`).toBeLessThan(
      0.75,
    )
  })
})
