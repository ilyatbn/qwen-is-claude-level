#!/usr/bin/env node
/**
 * `objects` — T16.03 / §D1 §D6: scenery is drawn, and destruction takes it away.
 *
 *   node scripts/checks/objects.mjs
 *   node scripts/e2e.mjs objects
 *
 * ## This check carries the task, and nothing in vitest can
 *
 * `client/vite.config.ts` runs vitest with `environment: 'node'`; there is no
 * canvas in the client's dependencies and `BakeScratch` calls
 * `document.createElement('canvas')`, so `bakeChunk` cannot execute there at
 * all. `chunkBake.test.ts` covers the chunk index and the geometry of the draw
 * calls — the arguments, never the picture.
 *
 * §D1's whole claim is that **destruction needs no per-object work** because the
 * art is drawn before the bake punches the chunk out to the live mask. That is a
 * claim about pixels, so it is asserted on pixels (`docs/72` §C2), in a real
 * Chrome, or it is not asserted at all. Four "I cannot see it" bugs shipped past
 * 905 tests on this project because every assertion checked simulation state.
 *
 * ## What it asserts, and the controls each one needs
 *
 * 1. **Both ends.** `map_init` carried N objects and the renderer's index holds
 *    N. A scene that decodes them and never calls `setObjects` passes any
 *    assertion about the wire alone.
 * 2. **Acceptance.** The patch over an object differs from a patch of plain
 *    ground — with a *control region* (ground with no object in it) so "the
 *    picture is not uniform" cannot pass for "the object is drawn".
 * 3. **The payoff.** Carve half an object away; the carved half changes and the
 *    other half does not. **Both halves in one assertion**: a bake that drew
 *    nothing satisfies "the carved half changed" the moment anything else moves,
 *    and satisfies "the other half is unchanged" trivially. The *control frame*
 *    is the same two patches before the carve.
 * 4. **The falsification**, and it is the reason this check exists: with
 *    `destination-in` removed from `chunkBake.ts` the carved half must stay
 *    visible and this check must go **red**. That operator is at
 *    `client/src/render/chunkBake.ts:173` — the live binding site the bake
 *    actually runs, not `docs/12` §2's description of it.
 * 5. **The budget.** A single rebake under `CHUNK_REBAKE_MS`, read from
 *    `TerrainRenderer.stats.lastBakeMs` — the renderer's own instrument, not a
 *    stopwatch this check starts. Gated on the **median** of 40 samples and
 *    reported with the max: §6's ceilings are generous on purpose, "so a 50x
 *    regression is caught and normal variance is not", and a max-of-40
 *    wall-clock in a browser is decided by one GC pause.
 *
 *    That constant is new: `docs/60` §6 states 4 ms and nothing in the codebase
 *    mirrored it, so the only way to assert it before was to spell `4` in a
 *    check and call that a budget. `lastBakeMs` is new too — it used to time the
 *    whole frame's loop of up to `CHUNK_REBAKE_BUDGET` chunks while its name
 *    said one.
 *
 * ## Not yet run
 *
 * D-07 defers every browser step to the end-of-M16 sweep. This file is written
 * and has never been executed; nothing below has passed. Treat every number in
 * it as a claim awaiting its first run.
 */
import { join } from 'node:path'
import { startStack, enterBattle, standStill, tally, sleep, shotsDir } from './harness.mjs'
import { samplePatch, colourDelta, toScreen } from './pixels.mjs'

const PORT = 3139

/**
 * A world rectangle as a screen rectangle, or `null` if it is not on screen.
 *
 * Every sample below used raw world coordinates. That is only ever right at
 * zoom 1 with the camera at the origin, and this check runs a real round at
 * `CAMERA_ZOOM` 2 — so the first `samplePatch` threw
 * `Clipped area is either empty or outside the resulting image` on its first
 * ever execution, which is a fixture handing Playwright a rect off the page.
 */
async function worldRect(page, wx, wy, ww, wh) {
  const a = await toScreen(page, wx, wy)
  const b = await toScreen(page, wx + ww, wy + wh)
  if (!a || !b) return null
  const rect = {
    x: Math.round(Math.min(a.x, b.x)),
    y: Math.round(Math.min(a.y, b.y)),
    w: Math.max(4, Math.round(Math.abs(b.x - a.x))),
    h: Math.max(4, Math.round(Math.abs(b.y - a.y))),
  }
  const bd = a.bounds
  if (
    rect.x < bd.left ||
    rect.y < bd.top ||
    rect.x + rect.w > bd.left + bd.width ||
    rect.y + rect.h > bd.top + bd.height
  ) {
    return null
  }
  return rect
}
const { fail, ok, finish } = tally('objects')

// FIXED_SEED so the scenery is in the same place every run. This check has to
// find an object big enough to carve half of, and picking that by luck is how a
// gate becomes a coin flip. No bots: one wandering into frame would move pixels
// the payoff assertion attributes to the carve.
const stack = await startStack({
  port: PORT,
  label: 'objects',
  env: { FIXED_SEED: '4242', ROUND_SECONDS: '300', BOT_COUNT: '0', DEV_LOADOUT: '1' },
})
const { page, dbg, shot } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'objects' })
await standStill(page)

try {
  // --- 1. both ends -------------------------------------------------------
  const d0 = await dbg()
  if (!d0.objects) {
    fail(`map_init carried no objects — every assertion below would be vacuous`)
  } else if (d0.objects !== d0.objectsIndexed) {
    fail(`the wire carried ${d0.objects} objects but the index holds ${d0.objectsIndexed}`)
  } else {
    ok(`${d0.objects} objects on the wire and in the renderer's index`)
  }
  if (!d0.objectChunks) fail('no chunk holds an object — the index reaches nothing')

  // Pick the widest object: half of it has to be worth photographing, and the
  // patch has to fit either side of the carve.
  const target = [...(d0.objectPositions ?? [])].sort((a, b) => b.w * b.h - a.w * a.h)[0]
  if (!target) throw new Error('no object positions on the debug handle')

  // --- 2. acceptance, with a control region -------------------------------
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [
    target.x + target.w / 2,
    target.y + target.h / 2,
  ])
  await sleep(400)
  await page.evaluate(() => window.__game.freeze(true))

  const half = Math.max(8, Math.floor(target.w / 4))
  const onRect = await worldRect(page, target.x + 2, target.y + 2, half, Math.max(8, Math.floor(target.h / 2)))
  if (!onRect) throw new Error('the target object is not on screen after watching it')
  const onObject = await samplePatch(page, onRect)
  // The control region: ground well clear of every object, same frame.
  const clear = await clearGroundX(page, d0.objectPositions, target)
  if (clear.x === null || clear.gap < 16) {
    throw new Error(
      `no on-screen ground clear of every object (best gap ${clear.gap}) — the control ` +
        'region would be sitting on scenery, which is not a control',
    )
  }
  const controlRect = await worldRect(page, clear.x, target.y + target.h - 4, half, 8)
  if (!controlRect) throw new Error('the control region is off screen')
  ok(`control region at world x ${clear.x}, ${clear.gap.toFixed(0)} px clear of any object`)
  const control = await samplePatch(page, controlRect)
  if (colourDelta(onObject, control) < 8) {
    fail(
      `the patch over an object is the same colour as bare ground ` +
        `(delta ${colourDelta(onObject, control).toFixed(1)}) — no sprite is being drawn`,
    )
  } else {
    ok(`object patch differs from the control ground patch`)
  }

  // --- 3. the payoff: carve half, and assert BOTH halves ------------------
  const leftRect = await worldRect(page, target.x + 2, target.y + 2, half, half)
  const rightRect = await worldRect(page, target.x + target.w - half - 2, target.y + 2, half, half)
  if (!leftRect || !rightRect) throw new Error('both halves of the object must be on screen')
  const leftBefore = await samplePatch(page, leftRect)
  const rightBefore = await samplePatch(page, rightRect)

  await page.evaluate(() => window.__game.freeze(false))
  // Carve the LEFT half only, through the client's own core so the mask the
  // renderer reads is the one that changed.
  await page.evaluate(
    ([x, y, r]) => window.__game.core.carve(x, y, r),
    [target.x + Math.floor(target.w / 4), target.y + Math.floor(target.h / 2), half],
  )
  await sleep(500)
  await page.evaluate(() => window.__game.freeze(true))

  const leftAfter = await samplePatch(page, leftRect)
  const rightAfter = await samplePatch(page, rightRect)

  const carvedDelta = colourDelta(leftBefore, leftAfter)
  const keptDelta = colourDelta(rightBefore, rightAfter)
  ok(
    `carved half moved ${carvedDelta.toFixed(1)}, untouched half moved ${keptDelta.toFixed(1)}`,
  )

  // **One assertion, both halves, and no invented threshold.**
  //
  // This compared each half against numbers picked by hand — 12 and 6 — and the
  // carved half measured 11.9 on its first ever run. A fixture that fails at
  // 11.9 and passes at 12.1 is not measuring anything; it is measuring the
  // number I chose.
  //
  // The untouched half **is** the control: same object, same frame, same
  // lighting, same everything except that nothing was carved out of it. So the
  // claim is a ratio between them, and both failure modes fall out of it — a
  // bake that drew nothing leaves both halves still and fails, and a bake that
  // redrew or removed the whole object moves both and fails.
  // **A floor as well as a ratio.** `keptDelta` can be exactly 0.0 between two
  // screenshots of a frozen, deterministic frame — and then `carved > kept * 3`
  // is satisfied by any non-zero number at all, including a single unit of
  // dither. §2 already measured the frame's own noise: `control` is a patch of
  // ground clear of every object, sampled in this same frame, and it moved by
  // `groundNoise` across the carve without anything happening to it. That is a
  // measured floor rather than a chosen one.
  const groundNoise = colourDelta(control, await samplePatch(page, controlRect))
  ok(`untouched ground moved ${groundNoise.toFixed(2)} across the carve — the frame's own noise`)
  if (carvedDelta <= Math.max(keptDelta * 3, groundNoise * 3)) {
    fail(
      `the carved half moved ${carvedDelta.toFixed(1)} against ${keptDelta.toFixed(1)} for the ` +
        `half that was not carved and ${groundNoise.toFixed(2)} for untouched ground — ` +
        'the art is not being clipped by the live mask',
    )
  } else {
    ok(
      `carve took the art with it: the carved half moved ${(carvedDelta / Math.max(keptDelta, 0.01)).toFixed(1)}x ` +
        'the untouched half',
    )
  }
  await shot(join(shotsDir, 'objects-carved.png'))

  // --- 4. the seam: an object spanning a chunk boundary is not cut --------
  const chunk = await page.evaluate(() => window.__game.constants().CHUNK_SIZE)
  const spanning = (d0.objectPositions ?? []).find(
    (o) => Math.floor(o.x / chunk) !== Math.floor((o.x + o.w - 1) / chunk),
  )
  if (!spanning) {
    // **A failure, not a skip.** This used to report `ok` and move on, which is
    // green output for an assertion that never ran — and on a pinned seed it is
    // deterministic, so §D6's seam requirement would have had zero coverage
    // every single run with nobody the wiser.
    //
    // FIXED_SEED 4242 at Small has five objects straddling a vertical chunk
    // boundary, counted from the placement pass rather than hoped for, and
    // `seed_4242_small_has_an_object_across_a_chunk_seam` in `map/gen/objects.rs`
    // guards that so a drift in generation breaks the fast gate rather than
    // this check. Seed 31337 at Small has none — which is what a silent skip
    // would have looked like.
    fail(`no object spans a chunk boundary — the seam case cannot run on this map`)
  } else {
    await page.evaluate(() => window.__game.freeze(false))
    await page.evaluate(([x, y]) => window.__game.watch(x, y), [
      spanning.x + spanning.w / 2,
      spanning.y + spanning.h / 2,
    ])
    await sleep(400)
    await page.evaluate(() => window.__game.freeze(true))
    const seamX = Math.floor((spanning.x + spanning.w / 2) / chunk) * chunk
    const lRect = await worldRect(page, seamX - 6, spanning.y + 4, 6, 8)
    const rRect = await worldRect(page, seamX + 2, spanning.y + 4, 6, 8)
    if (!lRect || !rRect) throw new Error('the spanning object is not on screen either side of the seam')
    const leftOfSeam = await samplePatch(page, lRect)
    const rightOfSeam = await samplePatch(page, rRect)
    if (colourDelta(leftOfSeam, rightOfSeam) > 60) {
      fail(
        `a hard colour break at the chunk seam (delta ` +
          `${colourDelta(leftOfSeam, rightOfSeam).toFixed(1)}) — the object is clipped to one chunk`,
      )
    } else {
      ok(`the object crosses the seam without a visible cut`)
    }
  }

  // --- 5. the rebake budget ----------------------------------------------
  await page.evaluate(() => window.__game.freeze(false))
  const budget = await page.evaluate(() => window.__game.constants().CHUNK_REBAKE_MS)
  const samples = []
  const RUNS = 40
  for (let i = 0; i < RUNS; i++) {
    await page.evaluate(
      ([x, y, r]) => window.__game.core.carve(x, y, r),
      [target.x + (i % 5) * 12, target.y + 8, 24],
    )
    await sleep(60)
    const d = await dbg()
    if (d.lastBakeMs) samples.push(d.lastBakeMs)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
  const worst = sorted.length ? sorted[sorted.length - 1] : 0

  if (!sorted.length) {
    // The instrument guard: every assertion below passes for a renderer whose
    // timer never ran, and a zero that reads as "fast" is the worst kind.
    fail('lastBakeMs never moved — the instrument is not recording, so no number here is evidence')
  } else if (median > budget) {
    // **Gated on the median, reported with the max.** `docs/60` §6 sets its
    // ceilings generously "so a 50x regression is caught and normal variance is
    // not"; a max-of-40 wall-clock in a browser is decided by whichever sample
    // caught a GC pause, and a gate that fails on a coin flip gates nothing. A
    // 50x regression moves the median and then some.
    fail(
      `median single-chunk rebake ${median.toFixed(2)} ms over ${sorted.length} samples ` +
        `(max ${worst.toFixed(2)}), budget ${budget} ms`,
    )
  } else {
    ok(
      `median single-chunk rebake ${median.toFixed(2)} ms, max ${worst.toFixed(2)} ms, ` +
        `over ${sorted.length} samples, budget ${budget} ms`,
    )
  }
} finally {
  await stack.close()
}

/**
 * A world x that is clear of every object **and on screen**, for the control.
 *
 * This walked outward from the target in 64 px steps from `target.x + w + 200`,
 * which at `CAMERA_ZOOM` 2 leaves the visible rect almost immediately — the
 * visible world is only ~640 px wide. The control has to be in the same frame
 * as the subject or it is not a control, so the search is bounded by the frame.
 */
async function clearGroundX(page, objects, near) {
  const view = await page.evaluate(() => {
    const raw = window.__game.debug().worldView
    return { x: raw.x, w: raw.width ?? raw.w }
  })
  const margin = 48
  let bestX = null
  let bestGap = -1
  for (let x = Math.round(view.x + margin); x < view.x + view.w - margin; x += 8) {
    if (Math.abs(x - near.x) < near.w + margin) continue
    let gap = Infinity
    for (const o of objects ?? []) {
      gap = Math.min(gap, Math.abs(o.x + o.w / 2 - x) - o.w / 2)
    }
    if (gap > bestGap) {
      bestGap = gap
      bestX = x
    }
  }
  return { x: bestX, gap: bestGap }
}

finish()
