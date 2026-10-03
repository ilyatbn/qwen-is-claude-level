/**
 * T8.05 — the performance ceilings from `docs/60` §6, measured rather than assumed.
 *
 * The fps question this exists to answer: a `fps 36` reading appeared in the same
 * frame as the new DOM feel layer. A number with no control is not evidence, so
 * this measures with the layer **on and off** rather than assuming either way.
 *
 * **M23's frame rate, both tiers (T23.23, 2026-10-03, `scripts/busy-fight.mjs`: 1 human + 5 bots, seed 320, a
 * bazooka every 250 ms for 8 s, zoom 1; mean fps of the 8 s).** Real GPU (headed google-chrome, D3D12 Intel Arc B390):
 * low 59.2 / 59.9, full 59.8 / 59.9 — vsync-bound, p99 16.8 ms. SwiftShader (this check's browser): low 39.3 / 39.5 /
 * 39.5, full 5.7 ×3 (a software rasteriser at the full tier is not a configuration anyone plays; reported). The low
 * tier's basis: the same script at T23.10's commit (9548528) gives 48.7 / 49.1 / 49.9 — T23.18B's 50.1–51.8 was a
 * different, uncommitted script. **The ~10 fps since then are T23.08B's foreground leaves**: hiding `fg` alone gives
 * 47.7 / 48.2 (fireflies, fx, backdrop/embers/cloudSea each change nothing). D-76: reported, not gated, and no task tunes the low
 * tier — the likely fix (the leaves' quad over their spots only, not the whole screen) is recorded in tasks/M23/CLOSING-M23.md.
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
  //
  // ## The backdrop pass is behind a toggle now (`CAVE_BACKDROP`)
  //
  // Shipped off, so `backdropMs` on a default build is a skipped pass, not a fast
  // one — and `0 < 500` would pass for a renderer whose classifier had become
  // arbitrarily slow. So this measures **both** sides: off, to confirm the toggle
  // really removes the work, and then on, which is where the ceiling is asserted.
  const bakeRun = async () => {
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
    return { bakes, backs, chunkOnly, gens }
  }

  const shipped = await page.evaluate(() => window.__game.debug().caveBackdrop)
  if (typeof shipped !== 'boolean') {
    throw new Error('debug().caveBackdrop is not a boolean — this check cannot tell the two apart')
  }

  // With it off, first.
  await page.evaluate(() => window.__game.caveBackdrop(false))
  const off = await bakeRun()
  const medianOf = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
  log(`  backdrop OFF:   median ${medianOf(off.backs).toFixed(1)} ms (the pass is skipped)`)
  if (medianOf(off.backs) > 20) {
    throw new Error(
      `CAVE_BACKDROP is off and the backdrop pass still costs ` +
        `${medianOf(off.backs).toFixed(0)} ms — the toggle is not skipping the work`,
    )
  }

  // ...and then on, which is what the ceiling below is about.
  await page.evaluate(() => window.__game.caveBackdrop(true))
  const { bakes, backs, chunkOnly, gens } = await bakeRun()
  await page.evaluate((on) => window.__game.caveBackdrop(on), shipped)
  const median = medianOf
  const list = (a) => a.map((n) => n.toFixed(0)).join(', ')
  const chunks = (await page.evaluate(() => window.__game.debug())).chunkCount
  log(`medium generate: median ${median(gens).toFixed(0)} ms of [${list(gens)}] (ceiling 1000)`)
  log(`  ${chunks}-chunk bake: median ${median(chunkOnly).toFixed(0)} ms of [${list(chunkOnly)}] (ceiling 400 — docs/60 §6)`)
  log(`  backdrop ON:    median ${median(backs).toFixed(0)} ms of [${list(backs)}] (ceiling 500)`)
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

  // ## A carve's rebuild (T23.19F re-derived it; it was "chunk rebake ≤ 4")
  //
  // This leg read `debug().lastRebakeMs` — `SandboxScene.carveAt`'s stopwatch round the carve AND
  // every chunk it dirtied AND, since T23.06, the lit terrain's field update (`terrainFields.ts`,
  // R4's `renderFieldsDirty` in wasm) — and held it to `docs/60` §6's **single chunk** 4 ms. Two
  // quantities under one name (the bug `terrain.ts::update` documents for `lastBakeMs`). Measured
  // on HEAD f2dca6d (sandbox 4242, r 60, SwiftShader, 12 fresh carves): total 5.3 ms median, of
  // which the fields pass 4.5 ms and Phaser's hidden fallback chunks 0.8 ms (worst single chunk
  // 0.8); wasm `renderFieldsDirty` alone 1.4 / 2.3 / 3.7 / 6.2 ms at r 8 / 24 / 40 / 60 — its
  // 64-px EDT read margin (R4) is the floor, so no rect trim brings a big carve under 4.
  // The single-chunk row stays gated where it is measured right: `chunk-rebake.mjs`.
  // What this leg gates now is the cost the player pays for a bazooka's crater
  // (`BAZOOKA_BLAST_RADIUS`, the busy fight's carve; the meteor's 50 and the mine's 48 are not in
  // `constants_json`, and r 60 was no weapon's), fields included, against **half a sim frame** (1000 / SIM_HZ / 2): the
  // frame carrying the carve keeps the other half for everything else. §6's "generous, so a
  // 50× regression is caught and variance is not" — measured ~4 ms against 8.3.
  const K = await page.evaluate(() => window.__game.constants())
  const R = K.BAZOOKA_BLAST_RADIUS
  const ceiling = 1000 / K.SIM_HZ / 2
  if (!(R > 0) || !(ceiling > 0)) throw new Error(`BAZOOKA_BLAST_RADIUS ${R} / SIM_HZ ${K.SIM_HZ} did not reach the page`)
  const carves = []
  for (let i = 0; i < 5; i++) {
    const r = await page.evaluate(([x, y, r]) => {
      const before = window.__world.terrain()?.feed?.carves ?? null
      window.__game.carve(x, y, r)
      const d = window.__game.debug()
      const feed = window.__world.terrain()?.feed ?? null
      return { total: d.lastRebakeMs, chunk: d.lastBakeMs, before, after: feed?.carves ?? null, fields: Number(feed?.lastCarveMs) }
    }, [1100 + i * 180, 1100, R])
    // The instrument guard: a carve that changed no field (air, or no lit terrain) reads as "fast".
    if (r.before === null || !(r.after > r.before)) {
      throw new Error(`carve ${i} at r ${R} updated no terrain field (${r.before} → ${r.after}) — no number here is evidence`)
    }
    carves.push(r)
    await page.waitForTimeout(150)
  }
  const mid = (k) => medianOf(carves.map((c) => c[k]))
  log(`carve r ${R} (BAZOOKA_BLAST_RADIUS), 5 fresh: whole carve ${mid('total').toFixed(2)} ms median, of it the lit terrain's fields ${mid('fields').toFixed(2)} ms, worst Phaser chunk ${mid('chunk').toFixed(2)} ms (ceiling ${ceiling.toFixed(2)} = half a ${K.SIM_HZ} Hz frame; single chunk gated by chunk-rebake)`)
  if (mid('total') > ceiling) {
    throw new Error(`a r ${R} carve's rebuild ${mid('total').toFixed(2)} ms median exceeds half a frame (${ceiling.toFixed(2)} ms)`)
  }

  // The single-chunk rebake budget (R37) was here from T22.00C until the M22 close-out:
  // this check is `flaky: true`, so while it lived here nothing gated it. It is now its
  // own serial, gated check, `chunk-rebake.mjs`, unchanged.

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
  // D-76 (owner, 2026-09-30; T23.25): a software rasteriser's frame rate is **reported, not gated** — the browser checks
  // run on SwiftShader, and these two floors were what parked this check (51.3 fps in the serial tail). On a GPU the
  // floors still hold. The renderer is read from the page (`ui/settings.ts`'s software pattern), not assumed.
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return 'none'
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
  })
  const software = /swiftshader|llvmpipe|softpipe|software/i.test(renderer)
  const fpsLow = realFps < 55
  const spiking = truth.p99 > 40
  if (software) {
    log(`D-76: ${renderer} is a software rasteriser — ${realFps.toFixed(1)} fps (floor 55 ${fpsLow ? 'MISSED' : 'met'}), p99 ${truth.p99.toFixed(1)} ms (ceiling 40 ${spiking ? 'MISSED' : 'met'}) reported, not gated`)
  } else {
    if (fpsLow) throw new Error(`measured ${realFps.toFixed(1)} fps on ${renderer} — that is a real frame-rate problem`)
    if (spiking) throw new Error(`frame p99 ${truth.p99.toFixed(1)}ms on ${renderer} — the frame time is spiking`)
  }

  await shot('perf')
}
