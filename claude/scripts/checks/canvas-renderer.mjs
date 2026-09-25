/**
 * `canvas-renderer` — T21.33: the picture the owner's browser actually draws.
 *
 * Every other browser check runs WebGL (swiftshader). The owner's headed Chrome under WSLg hands
 * Phaser no GL context, so `Phaser.AUTO` falls back to the **Canvas** renderer, and nothing had
 * ever looked at that. It had a solid navy bar across the sky (the ridge's foot:
 * `fillGradientStyle` is WebGL-only), white mountains (`setTint` is WebGL-only) and a transparent
 * seam at every ridge wrap. This check forces Canvas with `?renderer=canvas` and asks the frame.
 *
 * ## Pixels are read off the game canvas itself
 *
 * On Canvas the game canvas *is* a 2d canvas, so `getImageData` on it is the rendered frame, in
 * viewport px, with no DOM overlay and no client-rect conversion to get wrong. That is also the
 * owner's own measurement (`getContext('2d')` answers, `webgl` does not), and it is asserted first:
 * a check that silently ran WebGL would pass against the bug.
 *
 * ## Controls
 *
 * - **Control frame**: the same view with the parallax band hidden. Every region is compared
 *   against it, so "sky-coloured" means "the colour the sky is when no mountain is drawn".
 * - **Presence**: the top of the foot must differ from that frame — "the bottom rows look like sky"
 *   is otherwise satisfied by a foot that is not drawn at all.
 * - **Control region**: open sky below the foot must *not* change when the band is hidden.
 * - **Drift**: two frames with nothing toggled, so the fixture's own motion is measured, not assumed.
 */

import { drawnFrames } from './harness.mjs'

/** Install the page-side sampler once: frames stay in the page, only numbers come back. */
async function installSampler(page) {
  await page.evaluate(() => {
    const cv = document.querySelector('canvas')
    const ctx = cv.getContext('2d')
    const frames = {}
    const px = (f, x, y) => {
      const i = (y * cv.width + x) * 4
      return [f[i], f[i + 1], f[i + 2]]
    }
    const maxd = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
    window.__canvasCheck = {
      snap(name) {
        frames[name] = ctx.getImageData(0, 0, cv.width, cv.height).data
      },
      /** Mean largest-channel difference between two frames over rows y0..y1 and `cols`. */
      diff(a, b, y0, y1, cols) {
        let s = 0
        let n = 0
        for (let y = Math.max(0, y0); y <= Math.min(cv.height - 1, y1); y++) {
          for (const x of cols) {
            s += maxd(px(frames[a], x, y), px(frames[b], x, y))
            n++
          }
        }
        return n ? s / n : NaN
      },
      /** Of the pixels the band changed, how many are the tint and how many are white. */
      colours(on, off, y0, y1, cols, tint) {
        const t = [(tint >> 16) & 255, (tint >> 8) & 255, tint & 255]
        let changed = 0
        let tinted = 0
        let white = 0
        const sample = []
        for (let y = y0; y <= y1; y++) {
          for (const x of cols) {
            const p = px(frames[on], x, y)
            if (maxd(p, px(frames[off], x, y)) <= 30) continue
            changed++
            if (maxd(p, t) <= 40) tinted++
            if (Math.min(...p) >= 235) white++
            if (sample.length < 3) sample.push(p)
          }
        }
        return { changed, tinted, white, sample }
      },
      /** Largest-channel difference between column `x` and its neighbours `x ± k`, over rows. */
      column(name, x, k, y0, y1) {
        let s = 0
        let n = 0
        for (let y = y0; y <= y1; y++) {
          const c = px(frames[name], x, y)
          s += Math.max(maxd(c, px(frames[name], x - k, y)), maxd(c, px(frames[name], x + k, y)))
          n++
        }
        return s / n
      },
    }
  })
}

/** Viewport columns whose world pixels are air over rows y0..y1, away from the player. */
async function airColumns(page, y0, y1) {
  return page.evaluate(
    ([a, b]) => {
      const g = window.__game
      const d = g.debug()
      const v = d.worldView
      const z = d.zoom
      const W = g.constants().VIEWPORT_W
      const playerX = (d.player.x - v.x) * z
      const cols = []
      for (let x = 2; x < W - 2; x += 2) {
        if (Math.abs(x - playerX) < 48) continue
        let clear = true
        for (let y = a; y <= b && clear; y += 4) {
          if (g.core.solidAt(Math.round(v.x + x / z), Math.round(v.y + y / z))) clear = false
        }
        if (clear) cols.push(x)
      }
      return cols
    },
    [y0, y1],
  )
}

/**
 * Rendered frames between two samples of a settled camera (T22.14D): ~100 ms at 60 fps.
 */
const SETTLE_FRAMES = 6

/**
 * Poll until the camera stops moving — never a flat sleep. **Across drawn frames**
 * (T22.14D): two samples 100 ms apart were "settled" when they agreed, so a page that drew
 * nothing between them — a stalled frame under load — read as a still camera, and the foot
 * was sampled mid-pan (1 red in 22 runs under the full suite). Each interval now spans
 * `SETTLE_FRAMES` rendered frames; `drawnFrames` throws if the page stops drawing.
 */
async function settle(page) {
  let last = await page.evaluate(() => window.__game.debug().worldView)
  for (let i = 0; i < 80; i++) {
    await page.waitForTimeout(100)
    await drawnFrames(page, SETTLE_FRAMES)
    const now = await page.evaluate(() => window.__game.debug().worldView)
    if (Math.abs(now.y - last.y) < 0.5 && Math.abs(now.x - last.x) < 0.5) return now
    last = now
  }
  throw new Error('the camera never settled — every region below would be sampled from a moving frame')
}

export default async function ({ page, shot, log }) {
  // 0. This is the Canvas renderer, measured the way the owner measured it.
  const kind = await page.evaluate(() => {
    const cv = document.querySelector('canvas')
    return { twoD: !!cv.getContext('2d'), webgl: !!cv.getContext('webgl'), w: cv.width, h: cv.height }
  })
  if (!kind.twoD || kind.webgl) {
    throw new Error(`?renderer=canvas did not give a Canvas renderer: ${JSON.stringify(kind)}`)
  }
  log(`renderer: 2d context ${kind.twoD}, webgl ${kind.webgl}, canvas ${kind.w}x${kind.h}`)
  await installSampler(page)

  await page.evaluate(() => window.__game.regenerate('4242', 'medium'))
  await page.waitForTimeout(500)
  await page.evaluate(() => {
    window.__game.setTime(0.3 * 120)
    window.__game.setParallaxClock(0)
  })

  // Open the air around the ridge base so the background can be seen, and stand the player
  // on the floor of the hole: the camera then frames the base near the top of the screen with
  // the whole foot, and open sky below it, on screen.
  const opened = await page.evaluate(() => {
    const g = window.__game
    const d = g.debug()
    const base = d.parallax.ridge.worldBase
    const cx = d.worldView.x + d.worldView.w / 2
    const r = 40
    let n = 0
    for (let wy = base - 300; wy <= base + 150; wy += r * 0.75) {
      for (let wx = cx - 760; wx <= cx + 760; wx += r) {
        g.carve(Math.round(wx), Math.round(wy), r)
        n++
      }
    }
    g.place(Math.round(cx), Math.round(base + 100))
    return { base, carves: n }
  })
  log(`opened ${opened.carves} carves around the ridge base at world row ${opened.base.toFixed(1)}`)
  await settle(page)

  const K = await page.evaluate(() => window.__game.constants().VIEWPORT_H)

  // 1. The foot under the near ridge fades to sky — it is not a solid bar.
  {
    const d = await page.evaluate(() => window.__game.debug())
    const p = d.parallax
    if (!p.skirt?.visible) throw new Error(`the foot is not drawn here (${JSON.stringify(p.skirt)}) — nothing to assert`)
    const top = Math.round((p.skirt.y - p.view.top) * d.zoom)
    const h = Math.round(p.skirt.h * d.zoom)
    if (top < 8 || top + h + 48 > K) {
      throw new Error(`the foot sits at viewport rows ${top}..${top + h}; the fixture needs it and the sky below on screen`)
    }
    const cols = await airColumns(page, top - 8, top + h + 48)
    if (cols.length < 60) throw new Error(`only ${cols.length} open columns through the foot — the camera is looking at rock`)
    log(`foot at viewport rows ${top}..${top + h} (zoom ${d.zoom}), ${cols.length} open columns`)

    await page.evaluate(() => window.__canvasCheck.snap('on'))
    await page.waitForTimeout(300)
    await page.evaluate(() => window.__canvasCheck.snap('on2'))
    await shot('canvas-renderer-on')
    await page.evaluate(() => window.__game.setParallaxVisible(false))
    await page.waitForTimeout(300)
    await page.evaluate(() => window.__canvasCheck.snap('off'))
    await shot('canvas-renderer-hidden')
    await page.evaluate(() => window.__game.setParallaxVisible(true))
    await page.waitForTimeout(300)

    const band = Math.max(2, Math.round(h * 0.15))
    const r = await page.evaluate(
      ([t, hh, b, c]) => {
        const s = window.__canvasCheck
        return {
          top: s.diff('on', 'off', t + 1, t + b, c),
          bottom: s.diff('on', 'off', t + hh - b, t + hh - 1, c),
          below: s.diff('on', 'off', t + hh + 8, t + hh + 40, c),
          drift: s.diff('on', 'on2', t - 8, t + hh + 40, c),
        }
      },
      [top, h, band, cols],
    )
    log(
      `on vs hidden: foot top ${r.top.toFixed(1)}, foot bottom ${r.bottom.toFixed(1)}, ` +
        `sky below ${r.below.toFixed(1)}; drift ${r.drift.toFixed(1)}`,
    )
    // Presence: the foot is there at its top, or "the bottom looks like sky" proves nothing.
    if (r.top < 12) {
      throw new Error(`the top of the foot differs from the hidden frame by only ${r.top.toFixed(1)} — no foot is drawn`)
    }
    // The bug: a solid bar is as far from the sky at its bottom as at its top.
    if (r.bottom > r.top * 0.35) {
      throw new Error(
        `the rows at the bottom of the foot differ from the sky by ${r.bottom.toFixed(1)} against ` +
          `${r.top.toFixed(1)} at its top — it is a solid bar, not a fade (the Canvas renderer ignores fillGradientStyle)`,
      )
    }
    // No sky between the ridge and its foot. Looked at, not assumed: the first fixed Canvas frame
    // had a one-row light line across the whole width exactly at the base. Every row from the
    // ridge body into the foot must differ from the hidden frame, like the rows on either side.
    const rows = await page.evaluate(
      ([t, c]) => {
        const out = []
        for (let y = t - 6; y <= t + 6; y++) out.push(+window.__canvasCheck.diff('on', 'off', y, y, c).toFixed(1))
        return out
      },
      [top, cols],
    )
    log(`rows ${top - 6}..${top + 6} across the base, on vs hidden: ${JSON.stringify(rows)}`)
    const gap = Math.min(...rows)
    if (gap < r.top * 0.5) {
      throw new Error(
        `row ${top - 6 + rows.indexOf(gap)} at the ridge base differs from the sky by only ${gap} against ` +
          `${r.top.toFixed(1)} in the foot — a line of sky runs between the ridge and its foot`,
      )
    }
    // Control region: below the foot nothing of the band is drawn, so hiding it changes nothing.
    if (r.below > r.drift + 3) {
      throw new Error(
        `hiding the band changed the open sky below the foot by ${r.below.toFixed(1)} (drift ${r.drift.toFixed(1)}) — ` +
          'the frames are not comparable, or something is painting there',
      )
    }

    // 2. The ridge is its tint, not the white it was baked in (Canvas has no `setTint`).
    const c = await page.evaluate(
      ([t, cs, tint]) => window.__canvasCheck.colours('on', 'off', t - 6, t - 1, cs, tint),
      [top, cols, p.ridgeTint],
    )
    log(
      `ridge rows above the base: ${c.changed} px changed by the band, ${c.tinted} the near tint ` +
        `#${p.ridgeTint.toString(16).padStart(6, '0')}, ${c.white} white; sample ${JSON.stringify(c.sample)}`,
    )
    if (c.changed < 200) throw new Error(`the band changed only ${c.changed} px just above its base — no ridge is drawn`)
    if (c.white > c.changed * 0.02 || c.tinted < c.changed * 0.6) {
      throw new Error(
        `of ${c.changed} ridge px, ${c.tinted} are the near tint and ${c.white} are white — the ridge is not tinted ` +
          '(the Canvas renderer ignores setTint)',
      )
    }
  }

  // 3. No seam where the ridge texture wraps. At zoom 1 the view (VIEWPORT_W world px) is wider than
  //    the texture, so every ridge has a wrap on screen whatever the camera's x.
  {
    const z0 = await page.evaluate(() => window.__game.debug().zoom)
    await page.evaluate(() => window.__game.setZoom(1))
    await settle(page)
    await page.waitForTimeout(300)
    const d = await page.evaluate(() => window.__game.debug())
    const p = d.parallax
    const near = p.seams.length - 1
    const base = Math.round(p.ridge.top + p.ridge.h)
    const y0 = base - 4
    const y1 = base - 1
    if (d.zoom !== 1 || y0 < 0 || y1 >= K) throw new Error(`zoom ${d.zoom}, base row ${base}: cannot sample the seam`)
    const cols = new Set(await airColumns(page, y0 - 8, y1))
    await page.evaluate(() => window.__canvasCheck.snap('seam'))
    await shot('canvas-renderer-seam')
    const K4 = 4
    const results = []
    for (const sx of p.seams[near]) {
      for (const x of [Math.floor(sx), Math.ceil(sx)]) {
        // `airColumns` steps by 2, so accept a column whose even neighbours are open.
        const open = [x - K4, x + K4].every((c) => cols.has(c - (c % 2)))
        if (!open || x - K4 < 0 || x + K4 >= kind.w) continue
        const v = await page.evaluate(
          ([xx, k, a, b]) => window.__canvasCheck.column('seam', xx, k, a, b),
          [x, K4, y0, y1],
        )
        results.push({ x, v })
      }
    }
    await page.evaluate((z) => window.__game.setZoom(z), z0)
    log(`near ridge seams at viewport x ${JSON.stringify(p.seams[near].map((s) => +s.toFixed(1)))}, sampled ${JSON.stringify(results.map((r) => ({ x: r.x, v: +r.v.toFixed(1) })))}`)
    if (results.length === 0) throw new Error('no near-ridge wrap seam landed on open sky — nothing was sampled')
    const worst = results.reduce((a, b) => (b.v > a.v ? b : a))
    if (worst.v > 10) {
      throw new Error(
        `the near ridge's wrap column at viewport x ${worst.x} differs from its neighbours by ${worst.v.toFixed(1)} — ` +
          'a seam runs down the ridge where its texture wraps',
      )
    }
  }
}
