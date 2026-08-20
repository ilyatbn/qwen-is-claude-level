/**
 * `night_darkens_the_world` — the gate for night visibility (§A15, §A16).
 *
 * This asserts on **rendered terrain pixels**, because every proxy for it failed:
 * `darkness` was right, the FoV formula was right, `drawsLastFrame` said 1, and the
 * world stayed fully lit. A counter reports that work was attempted; only pixels
 * report that it happened.
 *
 * Two traps this deliberately avoids:
 *   - A whole-frame luminance mean looks healthy while the world stays lit, because
 *     the sky dominates the average and the sky *does* darken.
 *   - Sampling near the player proves nothing: they stand in their own pool of
 *     light. Distance from the player is the axis that matters.
 */
export default async function ({ page, shot, log }) {
  const dbg = () => page.evaluate(() => window.__game.debug())

  /**
   * Luminance over a grid across the whole frame. A single row is not enough: it
   * may cross terrain only near the player, which is precisely the region that
   * proves nothing.
   */
  const grid = async () => {
    const png = (await page.screenshot()).toString('base64')
    return page.evaluate(async (b64) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const cv = document.createElement('canvas')
      cv.width = img.width
      cv.height = img.height
      const ctx = cv.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(0, 0, img.width, img.height).data
      const pts = []
      // Skip the top-left control panel, which is DOM over the canvas.
      for (let y = 8; y < img.height; y += 8) {
        for (let x = 4; x < img.width; x += 8) {
          if (x < 380 && y < 240) continue
          const i = (y * img.width + x) * 4
          pts.push({ x, y, l: 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] })
        }
      }
      return pts
    }, png)
  }

  await page.evaluate(() => window.__game.regenerate('4242', 'medium'))
  await page.waitForTimeout(400)

  await page.evaluate(() => window.__game.setTime(25))
  await page.waitForTimeout(400)
  const day = await grid()
  const dayDbg = await dbg()
  if (dayDbg.lightmapFilled) {
    throw new Error('daylight must skip the lightmap entirely — stats.filled was true')
  }
  log(`day:   darkness ${dayDbg.darkness.toFixed(2)}  lightmap filled ${dayDbg.lightmapFilled}`)
  await shot('night-day')

  await page.evaluate(() => window.__game.setTime(90))
  await page.waitForTimeout(400)
  const night = await grid()
  const nightDbg = await dbg()
  if (!nightDbg.lightmapFilled) throw new Error('night did not fill the lightmap')

  const px = (nightDbg.player.x - nightDbg.worldView.x) * nightDbg.zoom
  const py = (nightDbg.player.y - nightDbg.worldView.y) * nightDbg.zoom

  // Terrain only: rock sits well below the bright day sky, so a day-luminance
  // window separates the two without needing the mask.
  const near = []
  const mid = []
  const far = []
  const byDist = []
  for (let i = 0; i < day.length; i++) {
    const p = day[i]
    if (!(p.l > 20 && p.l < 130)) continue
    const ratio = night[i].l / p.l
    const dist = Math.hypot(p.x - px, p.y - py)
    byDist.push({ dist, ratio })
    if (dist < 150) near.push(ratio)
    // The band that discriminates. A "night does not darken anything" bug and a
    // "the lit pool swallows the screen" bug both leave near-vs-far looking
    // healthy; only the middle distance tells them apart.
    else if (dist > 250 && dist < 400) mid.push(ratio)
    else if (dist > 450) far.push(ratio)
  }
  if (near.length < 20 || mid.length < 20 || far.length < 20) {
    throw new Error(
      `not enough terrain samples (near ${near.length}, mid ${mid.length}, far ${far.length})`,
    )
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length

  const nearRatio = mean(near)
  const midRatio = mean(mid)
  const farRatio = mean(far)

  // The rendered lit radius, straight off the screen: the distance at which
  // terrain stops keeping most of its daylight brightness.
  byDist.sort((a, b) => a.dist - b.dist)
  let litRadius = 0
  for (let i = 0; i + 8 < byDist.length; i++) {
    const window = byDist.slice(i, i + 8).reduce((s2, v) => s2 + v.ratio, 0) / 8
    if (window > 0.6) litRadius = byDist[i].dist
    else break
  }
  const wantRadius = nightDbg.fov * nightDbg.zoom
  log(
    `night: darkness ${nightDbg.darkness.toFixed(2)}  fov ${nightDbg.fov} world px ` +
      `(${nightDbg.fov * nightDbg.zoom} screen px)`,
  )
  log(`  terrain kept ${(nearRatio * 100).toFixed(0)}% of its brightness near the player`)
  log(`  terrain kept ${(midRatio * 100).toFixed(0)}% at 250-400 px (the discriminating band)`)
  log(`  terrain kept ${(farRatio * 100).toFixed(0)}% of its brightness far from the player`)
  log(`  lit radius measured ${litRadius.toFixed(0)} px, FoV asks for ${wantRadius.toFixed(0)} px`)
  await shot('night-night')

  // 1. Night must materially darken the world away from the player.
  if (!(farRatio < 0.5)) {
    throw new Error(
      `night does not darken distant terrain: kept ${(farRatio * 100).toFixed(0)}% of daylight`,
    )
  }
  // 2. The player's own surroundings must be lighter than the distance — that is
  //    what makes the FoV a pool of light rather than a global dimmer.
  if (!(nearRatio > farRatio + 0.25)) {
    throw new Error(
      `no visible FoV pool: near ${(nearRatio * 100).toFixed(0)}% vs far ${(farRatio * 100).toFixed(0)}%`,
    )
  }
  // 3. The pool must be the size the FoV asked for. This is the §A16 assertion:
  //    FOV_NIGHT was authored for a 1x camera, and at CAMERA_ZOOM 2 it covered
  //    twice the screen fraction intended — every other number stayed correct
  //    while night stopped costing anything.
  if (!(midRatio < 0.55)) {
    throw new Error(
      `the lit pool swallows the screen: terrain at 250-400 px still keeps ` +
        `${(midRatio * 100).toFixed(0)}% of daylight. FOV_NIGHT is too large for CAMERA_ZOOM ` +
        `${nightDbg.zoom} (see docs/70 §A16)`,
    )
  }
  if (litRadius > wantRadius * 1.6) {
    throw new Error(
      `lit radius ${litRadius.toFixed(0)} px far exceeds the ${wantRadius.toFixed(0)} px the FoV asked for`,
    )
  }
  log('night darkens the world, and the player carries a hole in it')
}
