/**
 * The single-chunk rebake budget (`docs/60` §6's 4 ms, `CHUNK_REBAKE_MS`) — R37's
 * assertion, on its own so it gates.
 *
 * **History.** It lived in `objects.mjs`, where under `e2e.mjs --jobs` its median
 * walked into the max's range (4.20 ms once in a `--changed` run, 0.80 alone minutes
 * later) and decided a gate on load. R37 (T22.00C) moved it into `perf.mjs`, which is
 * `serial` — but `perf` is also `flaky: true`, so from then on **nothing gated it**: a
 * 50x rebake regression would have left the default suite green. It is here, `serial`
 * and not parked (the M22 close-out, 2026-09-25), with the same instrument, sample count
 * and bound it had in `perf`: nothing about the assertion changed except that it runs.
 *
 * `TerrainRenderer.stats.lastBakeMs` — the renderer's own per-chunk instrument, not a
 * stopwatch this check starts — against `CHUNK_REBAKE_MS`. Gated on the **median** of 40
 * and reported with the max: §6's ceilings are generous "so a 50x regression is caught
 * and normal variance is not", and a max-of-40 in a browser is decided by one GC pause.
 * The sandbox's renderer is the same `TerrainRenderer` a match draws with; `carve`
 * flushes the pending set (`SandboxScene.carveAt`).
 *
 * If this reds under load, it goes to `tasks/flaky-test.md` with its numbers — it does
 * not go back into a parked check, which is how it stopped gating the first time.
 */
export default async function ({ page, shot, log }) {
  await page.evaluate(() => window.__game.regenerate('4242', 'medium'))
  await page.waitForTimeout(800)

  const budget = await page.evaluate(() => window.__game.constants().CHUNK_REBAKE_MS)
  if (typeof budget !== 'number' || !(budget > 0)) {
    throw new Error(`CHUNK_REBAKE_MS read as ${budget} — the budget is not reaching the page`)
  }
  const samples = []
  const RUNS = 40
  for (let i = 0; i < RUNS; i++) {
    await page.evaluate(([x, y, r]) => window.__game.carve(x, y, r), [1500 + (i % 5) * 12, 808, 24])
    await page.waitForTimeout(60)
    const d = await page.evaluate(() => window.__game.debug())
    if (d.lastBakeMs) samples.push(d.lastBakeMs)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  // The instrument guard: a timer that never ran reads as "fast".
  if (!sorted.length) {
    throw new Error('lastBakeMs never moved — the instrument is not recording, so no number here is evidence')
  }
  const median = sorted[Math.floor(sorted.length / 2)]
  const worst = sorted[sorted.length - 1]
  log(`median single-chunk rebake ${median.toFixed(2)} ms, max ${worst.toFixed(2)} ms, over ${sorted.length} samples, budget ${budget} ms`)
  if (median > budget) {
    throw new Error(
      `median single-chunk rebake ${median.toFixed(2)} ms over ${sorted.length} samples (max ${worst.toFixed(2)}), budget ${budget} ms`,
    )
  }
  await shot('chunk-rebake')
}
