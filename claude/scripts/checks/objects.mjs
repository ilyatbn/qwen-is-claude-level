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
import { samplePatch, colourDelta } from './pixels.mjs'

const PORT = 3139
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
  const onObject = await samplePatch(page, {
    x: target.x + 2,
    y: target.y + 2,
    w: half,
    h: Math.max(8, Math.floor(target.h / 2)),
  })
  // The control region: ground well clear of every object, same frame.
  const clearX = farFromObjects(d0.objectPositions, target)
  const control = await samplePatch(page, {
    x: clearX,
    y: target.y + target.h - 4,
    w: half,
    h: 8,
  })
  if (colourDelta(onObject, control) < 8) {
    fail(
      `the patch over an object is the same colour as bare ground ` +
        `(delta ${colourDelta(onObject, control).toFixed(1)}) — no sprite is being drawn`,
    )
  } else {
    ok(`object patch differs from the control ground patch`)
  }

  // --- 3. the payoff: carve half, and assert BOTH halves ------------------
  const leftBefore = await samplePatch(page, {
    x: target.x + 2,
    y: target.y + 2,
    w: half,
    h: half,
  })
  const rightBefore = await samplePatch(page, {
    x: target.x + target.w - half - 2,
    y: target.y + 2,
    w: half,
    h: half,
  })

  await page.evaluate(() => window.__game.freeze(false))
  // Carve the LEFT half only, through the client's own core so the mask the
  // renderer reads is the one that changed.
  await page.evaluate(
    ([x, y, r]) => window.__game.core.carve(x, y, r),
    [target.x + Math.floor(target.w / 4), target.y + Math.floor(target.h / 2), half],
  )
  await sleep(500)
  await page.evaluate(() => window.__game.freeze(true))

  const leftAfter = await samplePatch(page, {
    x: target.x + 2,
    y: target.y + 2,
    w: half,
    h: half,
  })
  const rightAfter = await samplePatch(page, {
    x: target.x + target.w - half - 2,
    y: target.y + 2,
    w: half,
    h: half,
  })

  const carvedDelta = colourDelta(leftBefore, leftAfter)
  const keptDelta = colourDelta(rightBefore, rightAfter)

  // One assertion, both halves. Either alone is satisfied by a chunk that draws
  // nothing at all.
  if (carvedDelta < 12) {
    fail(
      `the carved half did not change (delta ${carvedDelta.toFixed(1)}) — ` +
        `the art is not being clipped by the live mask`,
    )
  } else if (keptDelta > 6) {
    fail(
      `the half that was NOT carved also changed (delta ${keptDelta.toFixed(1)}) — ` +
        `the whole object is being redrawn or removed, not clipped`,
    )
  } else {
    ok(
      `carve took the art with it: carved half moved ${carvedDelta.toFixed(1)}, ` +
        `the other half ${keptDelta.toFixed(1)}`,
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
    const leftOfSeam = await samplePatch(page, { x: seamX - 6, y: spanning.y + 4, w: 4, h: 8 })
    const rightOfSeam = await samplePatch(page, { x: seamX + 2, y: spanning.y + 4, w: 4, h: 8 })
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

/** An x well clear of every object, for the control region. */
function farFromObjects(objects, near) {
  let x = near.x + near.w + 200
  for (let guard = 0; guard < 50; guard++) {
    const clash = (objects ?? []).some((o) => x < o.x + o.w + 32 && x + 32 > o.x - 32)
    if (!clash) return x
    x += 64
  }
  return x
}

finish()
