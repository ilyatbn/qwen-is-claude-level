/**
 * The M9 checkpoint: a round with sound, at night.
 *
 * **T23.07: one world, not three themes (R5).** The client draws one palette whatever the map's
 * theme, so the three-theme arm — and its "props are drawn" line, with the `decor` atlas — retired;
 * one map (seed 1) is kept. The theme is still simulation (it picks the stamped objects), so it is
 * not asserted here either way.
 *
 * This is the only check in the suite whose real acceptance criterion is a human
 * judgement, so it does two different jobs. The numbers below are things a test
 * can decide — the world renders, night is darker than day,
 * the cues fire. Whether it is a game worth playing is decided by looking at the
 * screenshots it leaves behind, which is why it takes six of them.
 *
 * Themes are seeded from the map (`docs/12` §4), so seeds 1, 2 and 3 are
 * grassland, desert and frost.
 */
const THEMES = [{ seed: '1', name: 'standard' }]

/**
 * Mean luminance of the lower half of the frame — terrain, not sky (§A15).
 *
 * Read from a **screenshot**, not from the live canvas: Phaser's WebGL context
 * does not preserve its drawing buffer, so `drawImage`-ing it into a 2D canvas
 * returns zeros. That is the same readback trap `night_darkens_the_world.mjs`
 * documents, and I walked straight into it by writing a second way to sample
 * pixels instead of using the one that already worked.
 */
async function terrainLuminance(page) {
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
    let sum = 0
    let n = 0
    // Lower half only, and clear of the HUD strip at the bottom.
    for (let y = Math.floor(img.height / 2); y < img.height - 40; y += 6) {
      for (let x = 4; x < img.width; x += 6) {
        const i = (y * img.width + x) * 4
        sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
        n++
      }
    }
    return n ? sum / n : 0
  }, png)
}

export default async function ({ page, shot, log }) {
  // One gesture, once: everything after this can make noise.
  await page.keyboard.press('Shift')
  await page.waitForTimeout(900)

  for (const t of THEMES) {
    await page.evaluate((seed) => window.__game.regenerate(seed, 'medium'), t.seed)
    await page.waitForTimeout(1000)

    const meta = await page.evaluate(() => {
      const g = window.__game
      const d = g.debug()
      const sp = g.core.meta.spawn_points[0]
      if (sp) g.place(sp.x, sp.y - 40)
      return { traversable: d.traversable }
    })
    await page.waitForTimeout(500)

    // Day.
    await page.evaluate(() => window.__game.setTime(25))
    await page.waitForTimeout(500)
    const day = await terrainLuminance(page)
    await shot(`m9-${t.name}-day`)

    // Night, with a shot fired so the frame has light in it.
    await page.evaluate(() => window.__game.setTime(90))
    await page.waitForTimeout(500)
    await page.evaluate(() => window.__game.clearCues())
    await page.evaluate(() => window.__game.fire())
    await page.waitForTimeout(700)
    const night = await terrainLuminance(page)
    const cues = await page.evaluate(() => window.__game.audio().cues)
    await shot(`m9-${t.name}-night`)

    log(
      `${t.name}: traversable ${meta.traversable.toFixed(3)}, ` +
        `terrain lum day ${day.toFixed(1)} night ${night.toFixed(1)}, ` +
        `cues [${cues.join(', ')}]`,
    )

    // Night must actually cost you something — this is the pillar §A16 restored.
    if (!(night < day * 0.75)) {
      throw new Error(`${t.name}: night ${night.toFixed(1)} is not darker than day ${day.toFixed(1)}`)
    }
    if (cues.length === 0) throw new Error(`${t.name}: firing at night made no sound`)
  }

  log('one world, night that costs you something, and sound')
}
