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
import { C, Core, MapGenerator, MapScale } from '../core'
import { BackdropMask } from './chunkBake'

let core: Core
let bd: BackdropMask
let w = 0
let h = 0

/**
 * Every scale the game can ship, not just the one the threshold was tuned on
 * (§A19). §A18 picked its value from a table measured on one medium map while
 * §A1 ships Large, and the bound it chose was violated at Large.
 *
 * And both generators, not just the default (`MAP_GENERATOR`, RUNNING.md §5.1).
 *
 * v1 is still shipped, and the two make *different populations of air*: v1's
 * voids leave enclosed pockets ~155 px from any rock, v2's widest cavity is a
 * cave chamber at ~82 px. A suite that only ran the default would have stopped
 * guarding v1's deep interiors the moment v2 became the default, and its
 * "deep enclosed air" control would have gone quietly to zero samples.
 */
const CASES = [
  ['v1 small/777', MapScale.Small, 777n, MapGenerator.V1],
  ['v1 medium/4242', MapScale.Medium, 4242n, MapGenerator.V1],
  ['v1 large/99', MapScale.Large, 99n, MapGenerator.V1],
  ['v2 small/777', MapScale.Small, 777n, MapGenerator.V2],
  ['v2 medium/4242', MapScale.Medium, 4242n, MapGenerator.V2],
  ['v2 large/99', MapScale.Large, 99n, MapGenerator.V2],
] as const

/**
 * The window `still draws the deep interior of a wide void as backdrop` samples,
 * per generator, in px from the nearest rock.
 *
 * It has to come from the widest cavity the generator under test actually makes,
 * or the population is empty and the test passes on nothing. v1's voids put their
 * centres ~155 px from a wall (`VOID_RADIUS_MAX`); v2 has no voids and its widest
 * cavity is a cave chamber at `CAVE2_RADIUS_MAX` = 82 px. Sampling 90-150 on a v2
 * map yields **zero** samples.
 */
const DEEP_WINDOW = {
  [MapGenerator.V1]: [90, 150],
  [MapGenerator.V2]: [55, 88],
} as const

function build(scale: MapScale, seed: bigint, generator: MapGenerator) {
  distCache = null
  core.generateWith(seed, scale, generator)
  w = core.width
  h = core.height
  const c = C()
  bd = new BackdropMask(core, undefined, c.SKY_MARGIN, c.BACKDROP_RAYS, c.BACKDROP_RAY_LEN, c.BACKDROP_MIN_HITS, c.BACKDROP_MIN_UP, c.BACKDROP_MAX_DIST_TO_SOLID, c.BACKDROP_MIN_ROOF)
  // **Pay the chamfer here, inside the budget sized for it.** `distCache` was
  // filled lazily by whichever `it()` asked first, so that one test carried the
  // whole cost against the default 5 s while this `beforeAll` already carries
  // 120 s. The memoisation note below says "computed once per `build()`" — this
  // is the line that makes that true.
  //
  // **This is attribution, not a speed fix, and it is not the cause of any
  // timeout.** Measured: the chamfer is 66 ms at Small, 143 ms at Medium and
  // 257 ms at Large (8.4 M px) — against tests that individually run 20-33 s.
  // It is under 1 % of the file's runtime. The 33 s is the tests' own full-map
  // scans crossing into WASM per pixel, which is legitimate work.
  distToSolid()
}

beforeAll(async () => {
  const url = new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url)
  core = await Core.init(readFileSync(fileURLToPath(url)))
}, 120_000)

/**
 * Air with rock above it in its own column, **within the ray length**.
 *
 * The range bound is the point. Unbounded, this reports "roofed" for every pixel
 * under a floating island however far above it is — and §A17 says in as many
 * words that the air under a floating island is plainly sky. That made the
 * enclosed-air metric below count open sky as enclosed and then score the
 * renderer wrong for drawing it as sky: measured 1.5 % at v1 medium and 2.6 % at
 * v1 large, of which every single sample was this. With the bound, and no change
 * to the renderer, the same maps read 0.11 % and 0.00 %.
 *
 * 320 px is the window the other three directions already use, so "enclosed" now
 * means the same thing on all four sides.
 */
function roofed(x: number, y: number): boolean {
  for (let d = 1; d < 320; d++) if (core.solidAt(x, y - d)) return true
  return false
}

/**
 * How far you would have to walk, horizontally, to get out from under the roof —
 * the smaller of the two directions.
 *
 * **This is the object fix.** §E12 made rocks and bushes 50 % bigger, and they
 * are stamped into the mask, so a boulder roofs the whole column beneath it.
 * `roofed()` then finds its edge 100 px overhead, the wall scans find rock far
 * away on both sides, and **one object-width of open hillside counts as
 * enclosed**. Measured on v2 large/99 after T18.04: 60 misclassified samples, 51
 * of them in a single sample column at object 0's left edge, roofed by an object
 * pixel in 60 cases out of 60, sitting in air 262 px wide at the median — wider
 * than any cave this generator makes, since `CAVE2_RADIUS_MAX` 82 gives 164 px
 * across.
 *
 * It is §A17's floating-island case with a rock instead of an island, and the
 * bound this file already put on `roofed()` cannot catch it: an island is
 * excluded by being *far above*, and a boulder is not far above. The axis that
 * separates them is the horizontal one.
 */
function roofSpan(x: number, y: number): number {
  let l = 0
  let r = 0
  for (; l < 400; l++) if (!roofed(x - l, y)) break
  for (; r < 400; r++) if (!roofed(x + r, y)) break
  return Math.min(l, r)
}

/**
 * Air the classifier is entitled to be asked about: enclosed, and **not at the
 * lip of an overhang**.
 *
 * The bound is `BackdropMask.CELL`, which is the classifier's own resolution and
 * not a tuned number. Its roof field is one value per 8 px cell, blurred 3x3 and
 * bilinearly interpolated — it cannot resolve a roof edge finer than a cell, and
 * this file already says so in as many words, excluding pixels within ~24 px of
 * rock from the sibling metric for exactly that reason. Asking a per-cell field
 * to agree with a per-pixel ray test **on the outermost pixel of a roof** is
 * asking for precision it does not claim to have.
 *
 * **What it costs, measured, because a cost nobody wrote down is a cost the next
 * person rediscovers.** On v2 large/99 the bound removes all 60 misclassified
 * samples — every one has a roof span of exactly 1 px, against a 5th percentile
 * of 3 and a median of 39 for the samples the classifier gets right. It also
 * removes **872 correct samples, 15.31 % of them**. That collateral is acceptable
 * for one reason only: it falls entirely on air the classifier was already
 * getting *right*, so the metric loses samples and not power. 4824 remain, and
 * they still include everything the classifier gets wrong.
 *
 * **It does not separate the populations in general, and an earlier draft of this
 * comment claimed it did.** That held on v2 large and nowhere else: on v1
 * large/99 the misclassified spans run to **282 px** (p50 3, p95 278) against a
 * p50 of 348 for the correct set, so the two overlap thoroughly and this bound
 * catches only the low-span end of them. v1 passes because its misclassification
 * rate is 0.08 %, under the assertion either way — not because the mechanism
 * reaches it. A comment asserting a separation that holds on one map is the
 * "describes an intent the code does not deliver" shape this file has already
 * been bitten by twice.
 *
 * So the justification is the resolution argument above, standing alone. It is
 * enough: the classifier is not built to answer at this precision, and the
 * samples removed are ones it answered correctly.
 *
 * What this is **not** is a width or gap bound on `roofed()`. Those were measured
 * and refused: "roofed by an object" enriches 3.4x and does not separate — the
 * correctly-classified control's p90 air width is the misclassified set's median,
 * so any width tightening reclassifies genuinely enclosed air. That is a
 * threshold move wearing a mechanism's clothes.
 *
 * **A flood-fill metric was ruled for and then measured and withdrawn.** Defining
 * enclosed as *air not reachable from the sky* fails three ways: the population
 * collapses to 70 samples at v2 medium and 666 at v2 large, against the
 * `toBeGreaterThan(1000)` guard below; the misclassification rate reads 0.00 % on
 * every case **by construction**, because a pixel unreachable from the sky is
 * certainly roofed, so `insideAt`'s own upward ray always calls it inside and
 * flood-fill's set is a strict subset of this one (`flood-only = 0`); and it
 * discards the 5090 samples that are caves joined to daylight by a winding
 * passage, which is the population this test exists for.
 */
const LIP_PX = BackdropMask.CELL

function enclosedAir(x: number, y: number): boolean {
  if (core.solidAt(x, y)) return false
  // "Enclosed" measured independently of the class under test: rock above,
  // below, and on both sides within the ray length.
  if (!roofed(x, y)) return false
  let below = false
  for (let d = 1; d < 320 && !below; d++) below = core.solidAt(x, y + d)
  let left = false
  for (let d = 1; d < 320 && !left; d++) left = core.solidAt(x - d, y)
  let right = false
  for (let d = 1; d < 320 && !right; d++) right = core.solidAt(x + d, y)
  if (!(below && left && right)) return false
  return roofSpan(x, y) >= LIP_PX
}

/**
 * Distance from every pixel to the nearest solid one, in px.
 *
 * Computed independently of the class under test — `BackdropMask` derives its own
 * field from the coarse grid, and a test that reused it would be asking the
 * implementation to grade itself. Chamfer 3-4, which is within ~2 % of Euclidean.
 */
/**
 * Memoised per map.
 *
 * This is a chamfer over the whole mask — 8.4 M pixels at Large — and it is one
 * unbroken synchronous block. Three tests wanted it, so each case paid for it
 * three times, and with six cases that starved the vitest worker's RPC until it
 * reported `Timeout calling "onTaskUpdate"` and failed the file without failing a
 * test. Computed once per `build()`, which is once per map.
 */
let distCache: Float32Array | null = null
function distToSolid(): Float32Array {
  if (distCache) return distCache
  distCache = computeDistToSolid()
  return distCache
}

function computeDistToSolid(): Float32Array {
  const ORTH = 3
  const DIAG = 4
  const CAP = 3 * 500
  const d = new Int32Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) d[y * w + x] = core.solidAt(x, y) ? 0 : CAP
  const relax = (i: number, from: number, cost: number) => {
    const v = d[from]! + cost
    if (v < d[i]!) d[i] = v
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (d[i] === 0) continue
      if (x > 0) relax(i, i - 1, ORTH)
      if (y > 0) {
        relax(i, i - w, ORTH)
        if (x > 0) relax(i, i - w - 1, DIAG)
        if (x + 1 < w) relax(i, i - w + 1, DIAG)
      }
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x
      if (d[i] === 0) continue
      if (x + 1 < w) relax(i, i + 1, ORTH)
      if (y + 1 < h) {
        relax(i, i + w, ORTH)
        if (x + 1 < w) relax(i, i + w + 1, DIAG)
        if (x > 0) relax(i, i + w - 1, DIAG)
      }
    }
  const px = new Float32Array(w * h)
  for (let i = 0; i < d.length; i++) px[i] = d[i]! / ORTH
  return px
}

for (const [name, scale, seed, generator] of CASES)
  describe(`BackdropMask on a real map (${name})`, () => {
    beforeAll(() => build(scale, seed, generator), 120_000)

  it('draws almost no enclosed air as sky', () => {
    // The §A14 implementation failed this at 49.3%.
    let enclosed = 0
    let asSky = 0
    for (let y = 8; y < h; y += 4) {
      for (let x = 8; x < w; x += 4) {
        if (!enclosedAir(x, y)) continue
        enclosed++
        if (!bd.insideAt(x, y)) asSky++
      }
    }
    expect(enclosed).toBeGreaterThan(1000)
    const share = asSky / enclosed
    console.log(`   ${name}: ${(share * 100).toFixed(1)}% of enclosed air drawn as sky`)
    // Standing in a cavern and seeing daylight is the failure that has recurred
    // three times, so this is the tightest bound in the file.
    //
    // 2 % / 3 % were the old ceilings, and they were loose because the metric was
    // counting sky (see `roofed`). 1 % came from measuring ~9x the worst case.
    //
    // With §E12's objects and the lip exclusion that answers them (see
    // `enclosedAir`), the measured values are:
    //
    //   v1 small/777  0.00%   v2 small/777  0.00%
    //   v1 medium     0.00%   v2 medium     0.02%
    //   v1 large      0.02%   v2 large      0.00%
    //
    // **The bound is deliberately left at 1 %**, which is now ~50x the worst
    // rather than ~9x. Tightening it to 0.2 % — the file's own calibration rule
    // applied to the new numbers — is the right follow-up, and doing it in the
    // same change as the metric fix would mean a later failure could not be
    // attributed to one or the other. One change at a time.
    //
    // v1 large keeps **15** genuine disagreements after the exclusion, which is
    // what stops this being a bound on an empty set: the metric can still go
    // red, and the control below asserts that it does when the classifier is
    // broken on purpose.
    expect(share, `${(share * 100).toFixed(1)}% of enclosed air drawn as sky`).toBeLessThan(0.01)
  })

  /**
   * **The metric is not the classifier**, and it can still go red.
   *
   * The danger in fixing a metric to make a test pass is that the metric quietly
   * becomes the thing it measures, and the assertion turns into
   * `classifier == classifier`. Two independent guards against that, both on the
   * same population the sibling test uses:
   *
   *  - the population is non-trivial after the lip exclusion, so the bound is not
   *    a bound on an empty set;
   *  - a **deliberately broken classifier** — `maxDistToSolid` 0, so §A37's guard
   *    rejects every pixel and nothing is ever interior — is caught. If the
   *    metric had drifted into agreeing with `insideAt` by construction, this
   *    would read the same as the shipped one.
   *
   * `maxDistToSolid` and not `minHits`, measured: raising `minHits` to `rays`
   * scored only **2.49 %** on v2 small/777, because that map's enclosed air is
   * mostly *sealed* and the sealed-air branch short-circuits every ray test
   * before `minHits` is consulted. A control that a correct classifier can pass
   * on one map out of six is not a control. §A37's guard runs first and is
   * unconditional, so breaking it breaks the classifier everywhere.
   *
   * **This is the guard that lets the lip exclusion above be trusted.** A metric
   * that quietly narrowed until it agreed with the class under test would pass
   * its sibling and fail here, because a broken classifier would still have to
   * score differently from the shipped one on whatever samples remain. It is a
   * live falsification — the broken mask is built and run — rather than an
   * argument that two definitions could in principle differ, which is the weaker
   * thing a "show they can disagree" demonstration would have given.
   */
  it('still detects a broken classifier on the same population', () => {
    const c = C()
    const broken = new BackdropMask(
      core,
      undefined,
      c.SKY_MARGIN,
      c.BACKDROP_RAYS,
      c.BACKDROP_RAY_LEN,
      c.BACKDROP_MIN_HITS,
      c.BACKDROP_MIN_UP,
      // Air further than this from rock is sky, whatever else is true. At 0,
      // that is everything.
      0,
      c.BACKDROP_MIN_ROOF,
    )
    let enclosed = 0
    let shippedAsSky = 0
    let brokenAsSky = 0
    for (let y = 8; y < h; y += 4) {
      for (let x = 8; x < w; x += 4) {
        if (!enclosedAir(x, y)) continue
        enclosed++
        if (!bd.insideAt(x, y)) shippedAsSky++
        if (!broken.insideAt(x, y)) brokenAsSky++
      }
    }
    // Not an empty set: the sibling test's bound has something to bound.
    expect(enclosed).toBeGreaterThan(1000)
    const shipped = shippedAsSky / enclosed
    const bad = brokenAsSky / enclosed
    console.log(
      `   ${name}: enclosed ${enclosed}, shipped ${(shipped * 100).toFixed(2)}% as sky, ` +
        `broken classifier ${(bad * 100).toFixed(2)}%`,
    )
    // The gap is the evidence. A metric that had become a restatement of
    // `insideAt` would score both classifiers identically.
    // Measured 86.5-89.8 % across the six cases against a shipped 0.00-0.02 %:
    // four orders of magnitude, so the bound is nowhere near either number. It
    // is not 100 % because the guard is bilinearly interpolated and air touching
    // rock still reads a distance of 0.
    expect(bad, `a classifier that calls nothing interior scored ${(bad * 100).toFixed(2)}%`)
      .toBeGreaterThan(0.8)
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
    // This used to be §A21's *accepted trade*: §A17 wanted both this and the
    // enclosed-as-sky bound tight, "no configuration satisfies both at all three
    // scales", and the milder failure was taken — sky drawn dark is haze, enclosed
    // air showing daylight is a hole through the world. The ceilings were 20 % at
    // small and 9 % elsewhere, against measured 16.42 / 5.86 / 7.18 %.
    //
    // `BACKDROP_MIN_ROOF` ended the trade rather than rebalancing it. The residual
    // was air beside a cliff or an island's flank, reached by *diagonal* upward
    // rays while the column overhead was clear — so it was never a threshold
    // problem, it was a missing discriminator. Requiring rock straight up:
    //
    //   v1 small/777  16.42% -> 0.9%    v2 small/777  2.3% -> 0.0%
    //   v1 medium     5.86%  -> 0.1%    v2 medium     8.1% -> 0.0%
    //   v1 large      7.18%  -> 0.1%    v2 large      2.0% -> 0.0%
    //
    // with enclosed-as-sky unmoved at <= 0.1 % everywhere. Both of §A17's bounds
    // now hold at every scale on both generators, so this is a real ceiling again
    // and not a record of a compromise. 2 % is ~2x the worst measured.
    expect(share, `${(share * 100).toFixed(1)}% of open sky drawn as backdrop`).toBeLessThan(0.02)
  })

  /**
   * §A37's guarantee, stated directly: nothing further than the bound from rock is
   * ever backdrop.
   *
   * This is the assertion the amendment is actually worth. Its *aggregate*
   * prediction — that the residual would fall "well below 1 %" — was wrong, and the
   * numbers are recorded on the sibling test below. What the bound does deliver is
   * this: the far tail is gone, and the far tail is what renders as a hard-edged
   * rectangle hanging in the sky rather than as shadow hugging a cliff.
   */
  it('never draws backdrop far from any rock', () => {
    const maxD = C().BACKDROP_MAX_DIST_TO_SOLID
    // Slack for the coarse field: the distance is sampled per 8 px cell and
    // bilinearly interpolated, so a pixel can read a little under its true
    // distance. Measured worst overshoot across the three maps is ~8 px.
    const slack = 12
    let far = 0
    let violations = 0
    let worst = 0
    const dist = distToSolid()
    for (let y = 8; y < h; y += 4) {
      for (let x = 8; x < w; x += 4) {
        if (core.solidAt(x, y)) continue
        const d = dist[y * w + x]!
        if (d <= maxD + slack) continue
        far++
        if (bd.insideAt(x, y)) {
          violations++
          if (d > worst) worst = d
        }
      }
    }
    // Control: the population has to be non-empty, or this passes on a map with
    // no deep sky at all (§A26 — an absence needs a presence).
    expect(far).toBeGreaterThan(500)
    expect(
      violations,
      `${violations} of ${far} air px beyond ${maxD}+${slack} px from rock are backdrop (worst ${worst.toFixed(0)} px)`,
    ).toBe(0)
  })

  it('still draws the deep interior of a wide void as backdrop', () => {
    // The failure §A18 ranks worst is standing in a cavern and seeing daylight, and
    // a distance bound is exactly the kind of change that could cause it. A v1 void
    // at VOID_RADIUS_MAX puts its centre ~155 px from a wall, which is why
    // BACKDROP_MAX_DIST_TO_SOLID is 160 and not lower — so the deepest enclosed air
    // must still be backdrop. `DEEP_WINDOW` is where that air is, per generator.
    const [deepLo, deepHi] = DEEP_WINDOW[generator]
    const dist = distToSolid()
    let deep = 0
    let asSky = 0
    // Stride 2, not 4. This population is one physical region — the interior of
    // the widest cavity on the map — and on a small map that is a single cave
    // chamber. At stride 4 it yields 11 samples, which is a control that controls
    // nothing; the region did not change, the sampling did.
    for (let y = 8; y < h; y += 2) {
      for (let x = 8; x < w; x += 2) {
        if (core.solidAt(x, y)) continue
        const d = dist[y * w + x]!
        // Deep enclosed air: far from rock, but genuinely roofed and walled.
        if (d < deepLo || d > deepHi) continue
        // The same enclosure definition as its sibling, from the same function.
        // Two spellings of "enclosed" in one file is how the two would drift the
        // first time either was touched.
        if (!enclosedAir(x, y)) continue
        deep++
        if (!bd.insideAt(x, y)) asSky++
      }
    }
    expect(deep).toBeGreaterThan(50)
    const share = asSky / deep
    console.log(`   ${name}: ${(share * 100).toFixed(1)}% of deep enclosed air drawn as sky`)
    expect(share, `${(share * 100).toFixed(1)}% of deep enclosed air drawn as sky`).toBeLessThan(0.35)
  })

  /**
   * `BACKDROP_MIN_ROOF`, stated directly: air with a clear column to the sky is
   * never backdrop, however much rock is beside it.
   *
   * This is the assertion the sibling metrics could not make. Their "open sky"
   * population excludes anything with rock within 120 px, so the defect the
   * constant exists for — half a frame of sky painted as cave next to a 300 px
   * mesa — sat entirely outside what they measured, and they reported 5-8 % while
   * a playthrough showed a wall of brown.
   */
  it('never draws air with open sky straight overhead as backdrop', () => {
    // Two legitimate ways a pixel with a clear column can still be interior, and
    // the population excludes both rather than the assertion tolerating them:
    //
    //  - the roof field is per 8 px cell and blurred over 3x3, so within ~24 px of
    //    rock a pixel inherits its roofed neighbours. That blur is what keeps the
    //    boundary off the coarse lattice (see the sibling test) and is wanted.
    //  - sealed air short-circuits every ray test. The floor of a crack narrower
    //    than 2 x REACH_PX is sealed for flood purposes even though the sky is
    //    straight up, and drawing it dark is right.
    //
    // 40 px of clearance clears both: it is past the blur, and wider than half of
    // 2 x REACH_PX (28).
    const dist = distToSolid()
    // Sealed air short-circuits every ray test in `BackdropMask` by design, so it
    // is excluded rather than tolerated. Flooded here with the class's own reach
    // rule but computed independently — the flood seeds from the sky margin
    // through air at least `REACH_PX` from rock, so a crack narrower than a
    // player-sized disc does not let daylight in.
    const sealed = (() => {
      const rC = BackdropMask.REACH_PX * 3
      const open = new Uint8Array(w * h)
      const stack: number[] = []
      const push = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= w || y >= h) return
        const i = y * w + x
        if (open[i] || core.solidAt(x, y) || dist[i]! * 3 <= rC) return
        open[i] = 1
        stack.push(i)
      }
      for (let x = 0; x < w; x++) for (let y = 0; y < C().SKY_MARGIN; y++) push(x, y)
      while (stack.length) {
        const i = stack.pop()!
        const x = i % w
        const y = (i - x) / w
        push(x + 1, y)
        push(x - 1, y)
        push(x, y + 1)
        push(x, y - 1)
      }
      return open
    })()

    let openAbove = 0
    let asBackdrop = 0
    let nearish = 0
    for (let y = 8; y < h; y += 4) {
      for (let x = 8; x < w; x += 4) {
        if (core.solidAt(x, y)) continue
        if (dist[y * w + x]! < 40) continue
        if (!sealed[y * w + x]) continue
        // A clear column here **and** across the blur's reach either side. The
        // roof field is per 8 px cell and blurred over 3x3, so a pixel 24 px from
        // a roofed cell inherits some of it — that softening is what keeps the
        // boundary off the coarse lattice, and a pixel sitting in it is not a
        // defect. Ask about pixels that are unambiguously out from under.
        let clear = true
        for (let d = -24; d <= 24 && clear; d += 8) clear = !roofed(x + d, y)
        if (!clear) continue
        openAbove++
        // Control on the population: some of it has to be the interesting case —
        // sky hard against a cliff, which is where the ray tests get it wrong. A
        // population of nothing but mid-sky would prove nothing.
        for (let d = 40; d <= 140; d += 4) {
          if (core.solidAt(x + d, y) || core.solidAt(x - d, y)) {
            nearish++
            break
          }
        }
        if (bd.insideAt(x, y)) asBackdrop++
      }
    }
    expect(openAbove).toBeGreaterThan(1000)
    expect(nearish, 'no sampled sky sits within 140 px of a cliff').toBeGreaterThan(200)
    console.log(
      `   ${name}: ${asBackdrop}/${openAbove} clear-overhead px as backdrop (${nearish} near a cliff)`,
    )
    // Not zero, and the residual is measured rather than tolerated: 0 / 4 / 9 /
    // 0 / 24 / 4 px of 30k-294k, i.e. 0.02 % at worst. It is sampling granularity
    // on both sides — the roof ray is cast from the **cell corner**, so a pixel up
    // to 7 px away can straddle a spire the cell's own column missed, and this
    // test's own clearance walk steps 8 px. 0.1 % is 5x the worst measured; the
    // defect this guards against was half a frame.
    const share = asBackdrop / openAbove
    expect(
      share,
      `${asBackdrop}/${openAbove} px with clear sky overhead drawn as backdrop`,
    ).toBeLessThan(0.001)
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
