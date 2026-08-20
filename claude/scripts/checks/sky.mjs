/** Screenshot the sky at each phase and assert it actually changes. */
export default async function ({ page, shot, log }) {
  const dbg = () => page.evaluate(() => window.__game.debug())

  /**
   * Mean colour of a strip of sky, measured from an actual screenshot.
   *
   * `gl.readPixels` on Phaser's canvas returns zeros — the drawing buffer is not
   * preserved between frames — so the honest measurement is the same PNG a person
   * would look at, decoded through an offscreen 2D canvas.
   */
  const skyTone = async () => {
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
      // A strip to the right of the control panel and above the terrain.
      const d = ctx.getImageData(Math.floor(img.width * 0.5), 10, Math.floor(img.width * 0.45), 60)
      let r = 0
      let g = 0
      let bl = 0
      const n = d.data.length / 4
      for (let i = 0; i < d.data.length; i += 4) {
        r += d.data[i]
        g += d.data[i + 1]
        bl += d.data[i + 2]
      }
      return [r / n, g / n, bl / n]
    }, png)
  }

  await page.evaluate(() => window.__game.regenerate('4242', 'medium'))
  await page.waitForTimeout(400)

  const phases = [
    ['morning', 0.05],
    ['day', 0.3],
    ['evening', 0.52],
    ['night', 0.75],
  ]

  const tones = []
  for (const [name, u] of phases) {
    await page.evaluate((t) => window.__game.setTime(t), u * 120)
    await page.waitForTimeout(350)
    const d = await dbg()
    const tone = await skyTone()
    tones.push({ name, tone, phase: d.skyPhase, darkness: d.darkness })
    log(
      `${name.padEnd(8)} u=${u} phase=${d.skyPhase.padEnd(9)} ` +
        `darkness=${d.darkness.toFixed(2)} sky rgb=(${tone.map((v) => v.toFixed(0)).join(',')})`,
    )
    await shot(`sky-${name}`)
  }

  const lum = (t) => 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2]
  const day = tones.find((t) => t.name === 'day')
  const night = tones.find((t) => t.name === 'night')
  if (!(lum(day.tone) > lum(night.tone) + 40)) {
    throw new Error(
      `night is not measurably darker than day: ${lum(day.tone).toFixed(0)} vs ${lum(night.tone).toFixed(0)}`,
    )
  }
  log(`day luminance ${lum(day.tone).toFixed(0)} vs night ${lum(night.tone).toFixed(0)}`)

  // Every phase must look different from every other; a sky that only has two
  // states is not the five-phase sky the amendment asks for.
  for (let i = 0; i < tones.length; i++) {
    for (let j = i + 1; j < tones.length; j++) {
      const d = Math.hypot(...tones[i].tone.map((v, k) => v - tones[j].tone[k]))
      if (d < 12) {
        throw new Error(`${tones[i].name} and ${tones[j].name} look the same (distance ${d.toFixed(1)})`)
      }
    }
  }
  log('all four sampled phases are visually distinct')
}
