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
  /**
   * The widest band of screen columns near the top of the frame whose world
   * pixels are **all air**, to the right of the sandbox control panel.
   *
   * Chosen by content rather than by a fixed rectangle. The old fixed strip —
   * x 50-95 %, y 10-70 — was pure sky against the map the generator used to make
   * and is mostly *rock* against the current one, so every phase's "sky tone" was
   * dominated by terrain that barely changes with the time of day. Morning and
   * day came out 11.3 apart against a threshold of 12: the sky was fine and the
   * sampler was pointed at a cliff.
   */
  /**
   * The widest run of open sky on screen, searched over **y as well as x**.
   *
   * It scanned one fixed strip, `y = 8..68`, and took the widest air run in it.
   * That is a bet that the camera happens to be looking at sky at the very top
   * of the frame — and pass 6b moved the spawn points (objects push spawn
   * candidates away under `OBJECT_CLEAR_OF_SPAWN`), so the camera now starts
   * somewhere with terrain rising into that strip and the check reported "the
   * camera is looking at rock" about a perfectly good sky.
   *
   * What the check actually needs is one rect of open sky, the same one for
   * every phase. Which *height* it sits at was never part of that requirement,
   * so searching for it removes a pin without weakening anything.
   */
  const findSkyBand = () =>
    page.evaluate(() => {
      const g = window.__game.debug()
      const v = g.worldView
      const core = window.__game.core
      const cv = document.querySelector('canvas')
      const r = cv.getBoundingClientRect()
      const H = 60 // band height, screen px
      const airColumn = (sx, top) => {
        const wx = v.x + (sx / r.width) * v.w
        for (let sy = top; sy <= top + H; sy += 6) {
          const wy = v.y + (sy / r.height) * v.h
          if (core.solidAt(Math.round(wx), Math.round(wy))) return false
        }
        return true
      }
      let overall = null
      // Down to the middle of the frame. Below that is the ground under any
      // camera, and a "sky" band there would be sampling the backdrop.
      for (let top = 8; top + H < r.height * 0.5; top += 24) {
        let best = null
        let run = null
        // Start right of the control panel, which is a DOM overlay and not sky.
        for (let sx = Math.floor(r.width * 0.32); sx < r.width - 4; sx += 4) {
          if (airColumn(sx, top)) {
            run ??= { x0: sx, x1: sx }
            run.x1 = sx
          } else {
            if (run && (!best || run.x1 - run.x0 > best.x1 - best.x0)) best = run
            run = null
          }
        }
        if (run && (!best || run.x1 - run.x0 > best.x1 - best.x0)) best = run
        if (best && (!overall || best.x1 - best.x0 > overall.w)) {
          overall = { x: Math.round(r.left + best.x0), y: Math.round(r.top + top), w: best.x1 - best.x0, h: H }
        }
      }
      return overall
    })

  /**
   * Mean colour of `band`, measured from an actual screenshot.
   *
   * `gl.readPixels` on Phaser's canvas returns zeros — the drawing buffer is not
   * preserved between frames — so the honest measurement is the same PNG a person
   * would look at, decoded through an offscreen 2D canvas.
   */
  const skyTone = async (band) => {
    const png = (await page.screenshot()).toString('base64')
    return page.evaluate(
      async ([b64, b]) => {
        const img = new Image()
        img.src = `data:image/png;base64,${b64}`
        await img.decode()
        const cv = document.createElement('canvas')
        cv.width = img.width
        cv.height = img.height
        const ctx = cv.getContext('2d')
        ctx.drawImage(img, 0, 0)
        const d = ctx.getImageData(b.x, b.y, b.w, b.h)
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
      },
      [png, band],
    )
  }

  await page.evaluate(() => window.__game.regenerate('4242', 'medium'))
  await page.waitForTimeout(400)

  const phases = [
    ['morning', 0.05],
    ['day', 0.3],
    ['evening', 0.52],
    ['night', 0.75],
  ]

  // One band for every phase: the camera does not move between them, so a
  // per-phase band would let a moving sampler explain a colour difference.
  const band = await findSkyBand()
  if (!band || band.w < 160) {
    throw new Error(
      `no band of open sky wide enough to sample (${band ? band.w : 0} px) — the camera is looking at rock`,
    )
  }
  log(`sky band: x ${band.x}..${band.x + band.w}, y ${band.y}..${band.y + band.h}`)

  const tones = []
  for (const [name, u] of phases) {
    await page.evaluate((t) => window.__game.setTime(t), u * 120)
    await page.waitForTimeout(350)
    const d = await dbg()
    const tone = await skyTone(band)
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
