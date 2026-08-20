/** T3.07's eight acceptance checks, run headlessly. */
export default async function ({ page, shot, log }) {
  const dbg = () => page.evaluate(() => window.__game.debug())
  const hash = () =>
    page.evaluate(() => Array.from(window.__game.core.maskHash()).join(','))
  const solidCount = () =>
    page.evaluate(() => {
      const c = window.__game.core
      const v = c.maskView()
      let n = 0
      for (let i = 0; i < v.length; i++) {
        let b = v[i]
        while (b) {
          n += b & 1
          b >>= 1
        }
      }
      return n
    })

  // 1. A map generates and renders.
  let d = await dbg()
  if (!(d.chunkCount > 0)) throw new Error('no chunks built')
  log(`1. renders: ${d.mapW}x${d.mapH}, ${d.chunkCount} chunks, seed ${d.seed}`)

  // 7. Generation time under 1 s, and displayed.
  const shown = await page.evaluate(() => document.querySelector('pre')?.textContent ?? '')
  if (!/generate \d+ ms/.test(shown)) throw new Error('generation time not displayed')
  if (d.generateMs >= 1000) throw new Error(`generate ${d.generateMs} ms exceeds 1 s`)
  log(`7. generate ${d.generateMs.toFixed(0)} ms, bakeAll ${d.buildAllMs.toFixed(0)} ms, displayed`)

  // 2. The same seed twice is the same map.
  await page.evaluate(() => window.__game.regenerate('12345'))
  const h1 = await hash()
  await page.evaluate(() => window.__game.regenerate('999'))
  await page.evaluate(() => window.__game.regenerate('12345'))
  const h2 = await hash()
  if (h1 !== h2) throw new Error('same seed produced a different map')
  log('2. seed 12345 reproduces bit-identically')

  // 3. Ten regenerates do not leak textures. Phaser's texture manager is global,
  //    so a missing destroy() shows up as an unbounded terrain-texture count long
  //    before the browser reports memory pressure.
  const tex = async () => (await dbg()).liveTerrainTextures
  const t0 = await tex()
  for (let i = 0; i < 10; i++) {
    await page.evaluate((s) => window.__game.regenerate(String(s)), 1000 + i)
  }
  const t1 = await tex()
  if (t1 > t0) throw new Error(`terrain textures climbed ${t0} -> ${t1} over 10 regenerates`)
  log(`3. 10 regenerates: live terrain textures ${t0} -> ${t1} (destroy works)`)

  // 8. All three scales rebuild.
  for (const [name, w, h] of [
    ['small', 2048, 1024],
    ['medium', 3072, 1536],
    ['large', 4096, 2048],
  ]) {
    await page.evaluate(([s, n]) => window.__game.regenerate(s, n), ['4242', name])
    d = await dbg()
    if (d.mapW !== w || d.mapH !== h) throw new Error(`${name}: got ${d.mapW}x${d.mapH}`)
    log(`8. ${name}: ${d.mapW}x${d.mapH}, ${d.chunkCount} chunks, generate ${d.generateMs.toFixed(0)} ms`)
  }

  // 4 + 5. Carving removes pixels and rebakes; radius 200 stays inside budget.
  await page.evaluate(() => window.__game.regenerate('12345', 'medium'))
  const before = await solidCount()
  const spawn = await page.evaluate(() => window.__game.core.meta.spawn_points[0])
  // Carve INTO the rock: 40 px *above* a spawn point is mostly air, and removing
  // 80 px would let a broken carve pass.
  await page.evaluate((s) => window.__game.carve(s.x, s.y + 60, 42), spawn)
  const after = await solidCount()
  // A full r=42 disc is ~5500 px; anything much less means we hit air.
  if (before - after < 4000) throw new Error(`carve removed only ${before - after} px`)
  d = await dbg()
  log(`4. carve r=42 removed ${before - after} px, rebake ${d.lastRebakeMs.toFixed(1)} ms`)
  await shot('sandbox-carve-42')

  await page.evaluate((s) => window.__game.carve(s.x, s.y + 60, 200), spawn)
  d = await dbg()
  const after200 = await solidCount()
  log(`5. carve r=200 removed ${after - after200} px, rebake ${d.lastRebakeMs.toFixed(1)} ms`)
  if (d.lastRebakeMs > 400) throw new Error(`r=200 rebake took ${d.lastRebakeMs} ms`)
  await shot('sandbox-carve-200')

  // 6. Seams: eyeballed from the overview shot below.
  await page.evaluate(() => window.__game.regenerate('4242', 'medium'))
  await shot('sandbox-overview')
  log('6. seams: see shots/sandbox-overview.png')
}
