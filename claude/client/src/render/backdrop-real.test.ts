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

beforeAll(async () => {
  const url = new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url)
  core = await Core.init(readFileSync(fileURLToPath(url)))
  core.generate(4242n, MapScale.Medium)
  w = core.width
  h = core.height
  const c = C()
  bd = new BackdropMask(core, undefined, c.SKY_MARGIN, c.BACKDROP_RAYS, c.BACKDROP_RAY_LEN, c.BACKDROP_MIN_HITS)
}, 120_000)

/** Air with rock somewhere above it in its own column. */
function roofed(x: number, y: number): boolean {
  for (let yy = y - 1; yy >= 0; yy--) if (core.solidAt(x, yy)) return true
  return false
}

describe('BackdropMask on a real map', () => {
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
    // 0.9% measured. This is the failure that has recurred three times — standing
    // in a cavern and seeing daylight — so it carries the tighter bound (§A18).
    expect(share, `${(share * 100).toFixed(1)}% of enclosed air drawn as sky`).toBeLessThan(0.02)
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
    // 2.5% measured. Bounded at 3% deliberately: darkening a patch of sky reads as
    // haze, and no threshold satisfies both bounds at once (§A18).
    expect(share, `${(share * 100).toFixed(1)}% of open sky drawn as backdrop`).toBeLessThan(0.03)
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
