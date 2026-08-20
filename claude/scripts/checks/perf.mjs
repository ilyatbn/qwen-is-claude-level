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

  // docs/60 §6 ceilings. Measured over several runs and judged on the median:
  // a single sample of the full bake varied 262–411 ms on this box across a
  // couple of minutes with no code change, so one sample decides nothing. This
  // is software rendering (swiftshader) — real hardware is faster.
  const bakes = []
  const gens = []
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.__game.regenerate('4242', 'medium'))
    await page.waitForTimeout(600)
    const d = await page.evaluate(() => window.__game.debug())
    bakes.push(d.buildAllMs)
    gens.push(d.generateMs)
  }
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
  const chunks = (await page.evaluate(() => window.__game.debug())).chunkCount
  log(`medium generate: median ${median(gens).toFixed(0)} ms of [${gens.map((n) => n.toFixed(0)).join(', ')}] (ceiling 1000)`)
  log(`full ${chunks}-chunk bake: median ${median(bakes).toFixed(0)} ms of [${bakes.map((n) => n.toFixed(0)).join(', ')}] (ceiling 400)`)
  if (median(bakes) > 400) {
    throw new Error(`full bake median ${median(bakes).toFixed(0)} ms exceeds 400`)
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
