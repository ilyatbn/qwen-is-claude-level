/** The lightmap: free in daylight, dark at night, and lit around the player. */
export default async function ({ page, shot, log }) {
  const dbg = () => page.evaluate(() => window.__game.debug())

  const tone = async (region) => {
    const png = (await page.screenshot()).toString('base64')
    return page.evaluate(
      async ([b64, r]) => {
        const img = new Image()
        img.src = `data:image/png;base64,${b64}`
        await img.decode()
        const cv = document.createElement('canvas')
        cv.width = img.width
        cv.height = img.height
        cv.getContext('2d').drawImage(img, 0, 0)
        const d = cv.getContext('2d').getImageData(r.x, r.y, r.w, r.h)
        let sum = 0
        for (let i = 0; i < d.data.length; i += 4) {
          sum += 0.2126 * d.data[i] + 0.7152 * d.data[i + 1] + 0.0722 * d.data[i + 2]
        }
        return sum / (d.data.length / 4)
      },
      [png, region],
    )
  }

  // The far corner, well outside any FoV circle centred on the player.
  const CORNER = { x: 1080, y: 600, w: 180, h: 100 }
  // Around screen centre, where the player is.
  const CENTRE = { x: 590, y: 310, w: 100, h: 100 }

  await page.evaluate(() => window.__game.regenerate('4242', 'medium'))
  await page.waitForTimeout(400)

  // --- Daylight: the pass must cost literally nothing ----------------------
  await page.evaluate(() => window.__game.setTime(30))
  await page.waitForTimeout(300)
  let d = await dbg()
  const dayCorner = await tone(CORNER)
  log(`day:   darkness ${d.darkness.toFixed(2)}  lightmap draws ${d.lightmapDraws}  corner lum ${dayCorner.toFixed(0)}`)
  if (d.lightmapDraws !== 0) {
    throw new Error(`daylight must skip the lightmap entirely, got ${d.lightmapDraws} draws`)
  }
  await shot('lightmap-day')

  // --- Night: dark away from the player, lit around them -------------------
  await page.evaluate(() => window.__game.setTime(90))
  await page.waitForTimeout(400)
  d = await dbg()
  const nightCorner = await tone(CORNER)
  const nightCentre = await tone(CENTRE)
  log(
    `night: darkness ${d.darkness.toFixed(2)}  fov ${d.fov.toFixed(0)}  ` +
      `draws ${d.lightmapDraws}  corner lum ${nightCorner.toFixed(0)}  centre lum ${nightCentre.toFixed(0)}`,
  )
  if (d.lightmapDraws < 1) throw new Error('night drew no lights')
  if (!(nightCorner < dayCorner * 0.6)) {
    throw new Error(`night corner not dark enough: ${nightCorner.toFixed(0)} vs day ${dayCorner.toFixed(0)}`)
  }
  if (!(nightCentre > nightCorner + 8)) {
    throw new Error(
      `the player's surroundings are not lit: centre ${nightCentre.toFixed(0)} vs corner ${nightCorner.toFixed(0)}`,
    )
  }
  await shot('lightmap-night')

  // --- Fog shrinks the FoV -------------------------------------------------
  const fovBefore = (await dbg()).fov
  await page.evaluate(() => window.__game.setFog(true))
  await page.waitForTimeout(300)
  const fovFog = (await dbg()).fov
  log(`fog:   fov ${fovBefore.toFixed(0)} -> ${fovFog.toFixed(0)}`)
  if (!(fovFog < fovBefore * 0.6)) throw new Error('fog did not shrink the FoV')
  await shot('lightmap-fog')
  await page.evaluate(() => window.__game.setFog(false))

  // --- F4 overlays ---------------------------------------------------------
  await page.evaluate(() => window.__game.setTime(30))
  await page.keyboard.press('F4')
  await page.waitForTimeout(300)
  if (!(await dbg()).overlays) throw new Error('F4 did not enable overlays')
  log('F4: overlays on')
  await shot('overlays')
}
