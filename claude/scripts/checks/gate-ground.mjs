/**
 * T21.28 — the ground under a teleport gate is rock, **in rendered pixels**.
 * T21.40 — and the gate is drawn 80 % of its old size, **in rendered pixels**.
 *
 * Reported from play with a screenshot: *"the teleport is floating because a
 * couple pixels are touching it in the center but the rest are in the air"*. The
 * generator now fills ground under every column of the gate's drawn base
 * (`PAD_ART_W`), and this asks the picture rather than the mask (`docs/72` §C2):
 * for every pad, a patch under the **left and right ends** of the drawn base —
 * the overhang the report is about, outside the `PAD_W` pad strip — must look like
 * rock and not like open air.
 *
 * **The references come from the live mask, the verdict from the pixels.** The
 * frost theme's rock and sky are close in colour, so "rock" and "air" are not
 * fixed colours: for each pad the check finds a rect the mask says is solid (under
 * the pad) and one it says is open (above the arch), samples both, and requires
 * them to differ by `DISTINCT` before it trusts either.
 *
 * **Below the edge band.** The terrain bake paints a bright band on the top
 * `EDGE_BAND_PX` solid rows of every sky-facing surface — snow, on the frost theme
 * — and the first version of this check picked that snow as its "rock" reference,
 * because the mask calls it solid: every distance was then measured against
 * white. Every patch now starts two bands down, one band of margin for the soft
 * edge the bake draws inside it (measured about six world rows of white on seed
 * 4242's frost rock, against a band of five).
 *
 * **No pad may be perched (T21.40).** The owner's ruling, 2026-09-15: *"just place
 * them somewhere else then like a floating island or just dont place any more if
 * there's no proper space"*. The generator no longer falls back to an unseated
 * spot, so a pad perched past the fill's reach is a failure, not a report. A map
 * carries 0 or at least 2 pads; this seed must carry enough to assert.
 *
 * **The size check (T21.40)**: *"reduce its size by 20% its kinda large"*. One pad
 * is photographed twice in one frozen frame, with the pad layer shown and hidden,
 * and the columns that changed are the gate as drawn. Their width in world px is
 * compared with what the **old** gate drew — `OLD_GATE_W` wide, of which the art's
 * opaque columns are the part that can change a pixel — times `SHRINK`. Measured
 * against the art on disk, not against `PAD_ART_W`: a constant that moved while
 * the picture did not (or the reverse) is what this exists to catch.
 *
 * **One frame, one sky.** Each pad's four patches are separate screenshots, so the camera
 * is snapped onto the gate and the scene frozen across them, and the day clock is pinned
 * to daylight. Before this the check slept 600 ms behind an easing camera under a live
 * sky, and went red once in a `--jobs 4` gate and once alone after the first fix.
 *
 * Falsified by turning the fill off at `generate_full`'s call site: the on-ground
 * pads then have air under their ends and the pixels say so. The size check is
 * falsified by restoring `PAD_ART_W` to 64.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { toScreen, samplePatch, colourDelta, photo, PIXEL_MOVED } from './pixels.mjs'
import { constants as rustConstants } from '../lib/rust-constants.mjs'

/** Colour distance at which the rock and air references count as distinguishable. */
const DISTINCT = 20
const MIN_CONCLUSIVE = 3
const STRIP = 6
const ROWS = 4
/**
 * The gate's drawn width before T21.40, in world px — T21.28's `PAD_ART_W`. A basis,
 * not a tunable: it is the size the owner looked at and called "kinda large".
 */
const OLD_GATE_W = 64
/** The owner's ruling: 20 % smaller. */
const SHRINK = 0.8
/** How far the measured ratio may sit from `SHRINK` (soft edges, sub-pixel scale). */
const SHRINK_TOLERANCE = 0.06
/** Art alpha above which a column counts as opaque enough to change a pixel. */
const ART_ALPHA = 32

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { PNG } = createRequire(join(root, 'client/package.json'))('pngjs')

/** The fraction of the committed gate art's width holding any opaque pixel. */
function artOpaqueFraction() {
  const png = PNG.sync.read(readFileSync(join(root, 'assets/images/gate.png')))
  let lo = png.width
  let hi = -1
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++)
      if (png.data[(y * png.width + x) * 4 + 3] > ART_ALPHA) {
        lo = Math.min(lo, x)
        hi = Math.max(hi, x)
      }
  return { fraction: hi < lo ? 0 : (hi - lo + 1) / png.width, artW: png.width, artH: png.height }
}

export default async function ({ page, shot, log }) {
  const k = rustConstants()
  const artW = k.get('PAD_ART_W')
  const reach = k.get('STANDING_GROUND_FILL_DEPTH')
  const playerH = k.get('PLAYER_H')
  const subjectTop = 2 * k.get('EDGE_BAND_PX')
  const pads = await page.evaluate(() => window.__game.core.meta.teleport_pads)
  const padsMin = k.get('TELEPORT_PADS_MIN')
  if (!pads || (pads.length > 0 && pads.length < padsMin) || pads.length > k.get('TELEPORT_PADS')) {
    throw new Error(`expected 0 or ${padsMin}..=${k.get('TELEPORT_PADS')} pads in core.meta, got ${pads?.length}`)
  }
  if (pads.length < MIN_CONCLUSIVE) {
    throw new Error(`this seed carries ${pads.length} pads, fewer than the ${MIN_CONCLUSIVE} this check asserts — pick another seed`)
  }

  /** Is every pixel of a world rect solid (true), open (false), or mixed (null)? */
  const maskRect = (x0, y0, w, h) =>
    page.evaluate(
      ([x0, y0, w, h]) => {
        let solid = 0
        for (let y = y0; y < y0 + h; y++)
          for (let x = x0; x < x0 + w; x++) solid += window.__game.core.solidAt(x, y) ? 1 : 0
        return solid === w * h ? true : solid === 0 ? false : null
      },
      [x0, y0, w, h],
    )
  /** The deepest air under any column of a drawn base, from the live mask. */
  const worstGap = (x, y) =>
    page.evaluate(
      ([x, y, w]) => {
        let worst = 0
        for (let col = x - Math.floor(w / 2); col < x - Math.floor(w / 2) + w; col++) {
          let d = 0
          while (d < 400 && !window.__game.core.solidAt(col, y + 1 + d)) d++
          worst = Math.max(worst, d)
        }
        return worst
      },
      [x, y, artW],
    )
  /** A world rect → the mean colour of its rendered pixels, or null off screen. */
  const patch = async (wx0, wy0, ww, wh) => {
    const a = await toScreen(page, wx0, wy0)
    const b = await toScreen(page, wx0 + ww, wy0 + wh)
    if (!a.onScreen || !b.onScreen) return null
    return samplePatch(page, {
      x: Math.round(a.x),
      y: Math.round(a.y),
      w: Math.max(2, Math.round(b.x - a.x)),
      h: Math.max(2, Math.round(b.y - a.y)),
    })
  }

  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

  /**
   * The gate's drawn width in world px: the extent of the columns that change when
   * the pad layer is hidden, inside a box around the pad, in one frozen frame.
   */
  const drawnGateWidth = async (x, y) => {
    const half = OLD_GATE_W // a box twice the old gate's width: room for either size
    const a = await toScreen(page, x - half, y - 2 * OLD_GATE_W)
    const b = await toScreen(page, x + half, y)
    if (!a.onScreen || !b.onScreen) return null
    const rect = { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(b.x - a.x), h: Math.round(b.y - a.y) }
    await page.evaluate(() => window.__game.freeze(true))
    let on, off
    try {
      await frames()
      on = await photo(page, rect)
      const hidden = await page.evaluate(() => window.__game.showPads(false))
      if (hidden.visible !== false) throw new Error('showPads(false) did not hide the pad layer')
      await frames()
      off = await photo(page, rect)
    } finally {
      await page.evaluate(() => window.__game.showPads(true))
      await page.evaluate(() => window.__game.freeze(false))
    }
    const cols = await page.evaluate(
      async ([sa, sb, thr]) => {
        const load = async (src) => {
          const img = new Image()
          img.src = `data:image/png;base64,${src}`
          await img.decode()
          const cv = document.createElement('canvas')
          cv.width = img.width
          cv.height = img.height
          const ctx = cv.getContext('2d')
          ctx.drawImage(img, 0, 0)
          return { d: ctx.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height }
        }
        const A = await load(sa)
        const B = await load(sb)
        let lo = A.w
        let hi = -1
        for (let yy = 0; yy < A.h; yy++)
          for (let xx = 0; xx < A.w; xx++) {
            const i = (yy * A.w + xx) * 4
            const peak = Math.max(Math.abs(A.d[i] - B.d[i]), Math.abs(A.d[i + 1] - B.d[i + 1]), Math.abs(A.d[i + 2] - B.d[i + 2]))
            if (peak > thr) {
              lo = Math.min(lo, xx)
              hi = Math.max(hi, xx)
            }
          }
        return { lo, hi, w: A.w }
      },
      [on, off, PIXEL_MOVED],
    )
    if (cols.hi < cols.lo) return { world: 0, screenCols: 0, scale: a.scale }
    const screenCols = cols.hi - cols.lo + 1
    return { world: screenCols / a.scale, screenCols, scale: a.scale }
  }

  // Daylight, pinned, as `clouds` and `cloud-rain` pin it. The sandbox sky runs a 120 s
  // cycle from page load, so "air" was whatever colour the sky had reached by the time a
  // pad was photographed: measured, rock and air sat 34–108 apart in one run and 23–49 in
  // another, and pad 2's right end read "to rock 33.1, to air 26.4" in the dim one.
  await page.evaluate(() => window.__game.setTime(0.3 * 120))

  const art = artOpaqueFraction()
  let asserted = 0
  let sized = false
  const failures = []
  for (const pad of pads) {
    const { x, y } = pad.pos
    const worst = await worstGap(x, y)
    if (worst > reach) {
      failures.push(`pad ${pad.id} at (${x}, ${y}): perched ${worst} px past the fill's ${reach} — T21.40 allows none`)
      continue
    }
    // Stand on the gate, then **snap the camera onto it and hold it there**. This slept
    // 600 ms and let the follow camera ease over: measured, alone, the camera was still
    // travelling while the four patches were photographed one after another — 42 world px
    // on pad 2 (478 -> 435), the pad a `--jobs 4` gate failed on ("to rock 84.3, to air
    // 67.6"). Each patch then sampled a different frame. Snapped, baked, then frozen.
    await page.evaluate(([px, py]) => window.__game.place(px, py), [x, y - playerH / 2 - 1])
    await page.evaluate(([px, py]) => window.__game.watch(px, py), [x, y])
    await frames()
    await page.waitForFunction(() => window.__game.debug().pending === 0, null, { timeout: 10_000 })

    if (!sized) {
      const m = await drawnGateWidth(x, y)
      if (m) {
        sized = true
        const expectedOld = OLD_GATE_W * art.fraction
        const ratio = m.world / expectedOld
        log(
          `gate size: drawn ${m.world.toFixed(1)} world px (${m.screenCols} screen cols at ${m.scale.toFixed(2)}x); ` +
            `the old gate drew ${expectedOld.toFixed(1)} (${OLD_GATE_W} x art opaque ${art.fraction.toFixed(3)} of ${art.artW}x${art.artH}); ` +
            `ratio ${ratio.toFixed(3)}, want ${SHRINK} ± ${SHRINK_TOLERANCE}`,
        )
        if (Math.abs(ratio - SHRINK) > SHRINK_TOLERANCE) {
          failures.push(
            `the gate is drawn at ${(ratio * 100).toFixed(1)} % of its old size, not ${SHRINK * 100} % ` +
              `(${m.world.toFixed(1)} world px against ${expectedOld.toFixed(1)})`,
          )
        }
      }
    }

    // The references, chosen by the mask. Rock: the first fully solid strip under
    // the pad centre, below the outline. Air: above the arch, which is under two
    // gate-widths tall.
    let rockY = null
    for (let ry = y + subjectTop; ry < y + subjectTop + 60; ry += 2) {
      if ((await maskRect(x - STRIP / 2, ry, STRIP, ROWS)) === true) {
        rockY = ry
        break
      }
    }
    const airY = y - artW * 2
    if (rockY === null || (await maskRect(x - STRIP / 2, airY, STRIP, ROWS)) !== false) {
      log(`pad ${pad.id}: no clean rock or air reference in the mask — inconclusive`)
      continue
    }
    // Four photographs of **one** frame: the scene is frozen across them, and the camera is
    // read at both ends so a frame that moved anyway is reported rather than judged.
    let rock, air, left, right, camA, camB
    await page.evaluate(() => window.__game.freeze(true))
    try {
      await frames()
      camA = await page.evaluate(() => window.__game.debug().camera)
      rock = await patch(x - STRIP / 2, rockY, STRIP, ROWS)
      air = await patch(x - STRIP / 2, airY, STRIP, ROWS)
      left = await patch(x - Math.floor(artW / 2) + 1, y + subjectTop, STRIP, ROWS)
      right = await patch(x - Math.floor(artW / 2) + artW - 1 - STRIP, y + subjectTop, STRIP, ROWS)
      camB = await page.evaluate(() => window.__game.debug().camera)
    } finally {
      await page.evaluate(() => window.__game.freeze(false))
    }
    const camMoved = Math.hypot(camB.x - camA.x, camB.y - camA.y)
    if (camMoved > 0) {
      failures.push(`pad ${pad.id} at (${x}, ${y}): the camera moved ${camMoved.toFixed(1)} world px while its patches were photographed — they are not one frame`)
      continue
    }
    if (!left || !right || !rock || !air) {
      log(`pad ${pad.id} at (${x}, ${y}): a patch was off screen — inconclusive`)
      continue
    }
    const separation = colourDelta(rock, air)
    if (separation < DISTINCT) {
      log(`pad ${pad.id}: rock and air differ by only ${separation.toFixed(1)} — inconclusive`)
      continue
    }
    asserted++
    for (const [side, p] of [['left', left], ['right', right]]) {
      const toRock = colourDelta(p, rock)
      const toAir = colourDelta(p, air)
      log(`pad ${pad.id} ${side}: to rock ${toRock.toFixed(1)}, to air ${toAir.toFixed(1)} (refs ${separation.toFixed(1)} apart)`)
      if (toRock >= toAir) {
        failures.push(
          `pad ${pad.id} at (${x}, ${y}): under the ${side} end of the drawn base looks like ` +
            `air (to rock ${toRock.toFixed(1)}, to air ${toAir.toFixed(1)})`,
        )
      }
    }
    await shot(`gate-ground-pad${pad.id}`)
  }

  await page.evaluate(() => {
    window.__game.watch(null)
    window.__game.setTime(null)
  })

  if (!sized) failures.push('no pad was on screen to measure the gate size — the size check measured nothing')
  // Failures first: a pad skipped for a moving camera is not asserted, and the count
  // alone would name the symptom ("only 0 pads") instead of the cause.
  if (failures.length) throw new Error(failures.join('\n'))
  if (asserted < MIN_CONCLUSIVE) {
    throw new Error(`only ${asserted} pads were asserted (need ${MIN_CONCLUSIVE}) — nothing measured`)
  }
  log(`all ${asserted} asserted pads stand on rock under both ends of their drawn base`)
}
