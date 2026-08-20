/**
 * T8.05 — the performance ceilings from `docs/60` §6, measured rather than assumed.
 *
 * The fps question this exists to answer: a `fps 36` reading appeared in the same
 * frame as the new DOM feel layer. A number with no control is not evidence, so
 * this measures with the layer **on and off** rather than assuming either way.
 */
export default async function ({ page, shot, log }) {
  const sample = async (label, seconds = 3) => {
    const fps = await page.evaluate(async (s) => {
      const frames = []
      let last = performance.now()
      const t0 = last
      await new Promise((done) => {
        const tick = () => {
          const now = performance.now()
          frames.push(now - last)
          last = now
          if (now - t0 < s * 1000) requestAnimationFrame(tick)
          else done()
        }
        requestAnimationFrame(tick)
      })
      frames.sort((a, b) => a - b)
      const at = (q) => frames[Math.floor(frames.length * q)] ?? 0
      return { frames: frames.length, p50: at(0.5), p99: at(0.99) }
    }, seconds)
    log(`${label}: ${(1000 / fps.p50).toFixed(1)} fps median, frame p50 ${fps.p50.toFixed(2)}ms p99 ${fps.p99.toFixed(2)}ms`)
    return fps
  }

  await page.evaluate(() => window.__game.regenerate('4242', 'medium'))
  await page.waitForTimeout(800)

  const withFeel = await sample('feel layer ON ')
  await page.evaluate(() => window.__game.setFeelEnabled(false))
  await page.waitForTimeout(400)
  const withoutFeel = await sample('feel layer OFF')
  await page.evaluate(() => window.__game.setFeelEnabled(true))

  const delta = withFeel.p50 - withoutFeel.p50
  log(`feel layer costs ${delta.toFixed(2)} ms/frame at the median`)
  if (delta > 4) {
    throw new Error(`the feel layer costs ${delta.toFixed(2)} ms/frame — that is a real regression`)
  }

  // docs/60 §6 ceilings, measured over several runs and judged on the median: a
  // single sample decides nothing here. This is software rendering
  // (swiftshader) — real hardware is faster.
  //
  // ## Three ceilings, not one (T9.07, §A38)
  //
  // §6's 400 ms is on "a full 72-chunk bake". `buildAllMs` stopped being that
  // some milestones ago: it is now the chunk bake **plus** the backdrop
  // classification pass (§A17/§A21/§A37), which did not exist when the number
  // was written and is two thirds of the total. The check was comparing a
  // growing total against a ceiling written for one of its parts, so it went red
  // without anything in the chunk bake getting slower — the chunk bake measures
  // ~90 ms against its own 400.
  //
  // ## The numbers move with machine load, and that is measured, not assumed
  //
  // Under a deliberate 8-core load every pass rose together — including
  // `generateMs`, which is pure WASM with no canvas and no GPU. Nothing done to
  // the bake can slow that down, so the swing is contention, and it is what the
  // "bimodal" samples were: whether a regenerate lands in a contended window.
  // Quiet: total median 295, max 330. Loaded: median 378, max 502. Ceilings
  // below carry headroom for a gate that runs beside other work.
  const bakes = []
  const backs = []
  const chunkOnly = []
  const gens = []
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.__game.regenerate('4242', 'medium'))
    await page.waitForTimeout(600)
    const d = await page.evaluate(() => window.__game.debug())
    bakes.push(d.buildAllMs)
    backs.push(d.backdropMs)
    chunkOnly.push(d.chunkBakeMs)
    gens.push(d.generateMs)
  }
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
  const list = (a) => a.map((n) => n.toFixed(0)).join(', ')
  const chunks = (await page.evaluate(() => window.__game.debug())).chunkCount
  log(`medium generate: median ${median(gens).toFixed(0)} ms of [${list(gens)}] (ceiling 1000)`)
  log(`  ${chunks}-chunk bake: median ${median(chunkOnly).toFixed(0)} ms of [${list(chunkOnly)}] (ceiling 400 — docs/60 §6)`)
  log(`  backdrop pass:  median ${median(backs).toFixed(0)} ms of [${list(backs)}] (ceiling 500)`)
  log(`  round-start total: median ${median(bakes).toFixed(0)} ms of [${list(bakes)}] (ceiling 800)`)

  // The ceiling docs/60 §6 actually states, against the quantity it names.
  if (median(chunkOnly) > 400) {
    throw new Error(`72-chunk bake median ${median(chunkOnly).toFixed(0)} ms exceeds 400`)
  }
  // Set from measurement: 176–237 quiet, 218–349 under an 8-core load.
  if (median(backs) > 500) {
    throw new Error(`backdrop pass median ${median(backs).toFixed(0)} ms exceeds 500`)
  }
  // What the player actually waits for at round start, inside a 10 s warmup.
  // 295 quiet / 378 loaded, worst single sample 502.
  if (median(bakes) > 800) {
    throw new Error(`round-start bake median ${median(bakes).toFixed(0)} ms exceeds 800`)
  }

  const t0 = await page.evaluate(() => {
    const t = performance.now()
    window.__game.carve(1500, 800, 60)
    return performance.now() - t
  })
  await page.waitForTimeout(300)
  const d2 = await page.evaluate(() => window.__game.debug())
  log(`carve+rebake: carve ${t0.toFixed(2)} ms, last chunk rebake ${d2.lastRebakeMs.toFixed(2)} ms (ceiling 4)`)
  if (d2.lastRebakeMs > 4) throw new Error(`chunk rebake ${d2.lastRebakeMs.toFixed(2)} ms exceeds 4`)

  // Where "fps 36" came from. Phaser's `actualFps` is a smoothed average, and a
  // regenerate stalls the loop for generate + full bake (~0.9 s here). The
  // counter takes seconds to climb back, so a screenshot taken just after a
  // regenerate shows a low number for a game that is running at 60. The control
  // is the same counter a few seconds later, with nothing else changed.
  await page.evaluate(() => window.__game.regenerate('4242', 'medium'))
  await page.waitForTimeout(300)
  const justAfter = (await page.evaluate(() => window.__game.debug())).fps
  await page.waitForTimeout(4000)
  const settled = (await page.evaluate(() => window.__game.debug())).fps
  log(`Phaser actualFps 300 ms after a regenerate: ${justAfter.toFixed(0)}; 4 s later: ${settled.toFixed(0)}`)

  // Deliberately NOT asserted on. `actualFps` is a smoothed average that
  // under-reports for seconds after a stall — it still reads ~55 while the
  // measured frame time is 16.7 ms, which is 59.9 fps. Asserting on a counter
  // this check has just demonstrated to be unreliable would be asserting on the
  // instrument rather than the effect. The real assertion is the rAF-measured
  // frame time below, and the number above is here only to explain why a
  // screenshot taken after a regenerate shows a low fps for a game running at 60.
  const truth = await sample('steady state ', 3)
  const realFps = 1000 / truth.p50
  log(`measured frame time: p50 ${truth.p50.toFixed(2)}ms (${realFps.toFixed(1)} fps), p99 ${truth.p99.toFixed(2)}ms`)
  if (realFps < 55) {
    throw new Error(`measured ${realFps.toFixed(1)} fps — that is a real frame-rate problem`)
  }
  if (truth.p99 > 40) {
    throw new Error(`frame p99 ${truth.p99.toFixed(1)}ms — the frame time is spiking`)
  }

  await shot('perf')
}
