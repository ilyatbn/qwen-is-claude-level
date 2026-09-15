/**
 * T21.28 — the ground under a teleport gate is rock, **in rendered pixels**.
 *
 * Reported from play with a screenshot: *"the teleport is floating because a
 * couple pixels are touching it in the center but the rest are in the air"*. The
 * generator now fills ground under every column of the gate's drawn base
 * (`PAD_ART_W`), and this asks the picture rather than the mask (`docs/72` §C2):
 * for every pad, a patch under the **left and right ends** of the drawn base —
 * the overhang the report is about, outside the 40 px pad strip — must look like
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
 * **Pads perched past the fill's reach are reported, not asserted.** When the map
 * cannot seat a pad on ground the generator tops up from a looser tier
 * (`meta.rs::seat_then_top_up`), and the sweep counts those; the mask says which
 * they are, and at least `MIN_CONCLUSIVE` pads must be asserted.
 *
 * Falsified by turning the fill off at `generate_full`'s call site: the on-ground
 * pads then have air under their ends and the pixels say so.
 */
import { toScreen, samplePatch, colourDelta } from './pixels.mjs'
import { constants as rustConstants } from '../lib/rust-constants.mjs'

/** Colour distance at which the rock and air references count as distinguishable. */
const DISTINCT = 20
const MIN_CONCLUSIVE = 3
const STRIP = 6
const ROWS = 4

export default async function ({ page, shot, log }) {
  const k = rustConstants()
  const artW = k.get('PAD_ART_W')
  const reach = k.get('STANDING_GROUND_FILL_DEPTH')
  const playerH = k.get('PLAYER_H')
  const subjectTop = 2 * k.get('EDGE_BAND_PX')
  const pads = await page.evaluate(() => window.__game.core.meta.teleport_pads)
  if (!pads || pads.length !== k.get('TELEPORT_PADS')) {
    throw new Error(`expected ${k.get('TELEPORT_PADS')} pads in core.meta, got ${pads?.length}`)
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
        for (let col = x - w / 2; col < x + w / 2; col++) {
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

  let asserted = 0
  const failures = []
  for (const pad of pads) {
    const { x, y } = pad.pos
    const worst = await worstGap(x, y)
    if (worst > reach) {
      log(`pad ${pad.id} at (${x}, ${y}): perched ${worst} px past the fill's ${reach} — reported, not asserted`)
      continue
    }
    // Stand on the gate so the camera centres on it, then let it render.
    await page.evaluate(([px, py]) => window.__game.place(px, py), [x, y - playerH / 2 - 1])
    await page.waitForTimeout(600)

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
    const rock = await patch(x - STRIP / 2, rockY, STRIP, ROWS)
    const air = await patch(x - STRIP / 2, airY, STRIP, ROWS)
    const left = await patch(x - artW / 2 + 1, y + subjectTop, STRIP, ROWS)
    const right = await patch(x + artW / 2 - 1 - STRIP, y + subjectTop, STRIP, ROWS)
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

  if (asserted < MIN_CONCLUSIVE) {
    throw new Error(`only ${asserted} pads were asserted (need ${MIN_CONCLUSIVE}) — nothing measured`)
  }
  if (failures.length) throw new Error(failures.join('\n'))
  log(`all ${asserted} asserted pads stand on rock under both ends of their drawn base`)
}
