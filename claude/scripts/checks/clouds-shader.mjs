/**
 * T21.18 item 1 — clouds.
 *
 * The coordinator did not like the sprite clouds: *"i dont really like the
 * current clouds so disable them and make them shaders too if High Quality is
 * enabled."* So this check asserts **two** pictures, and the first of them is a
 * deliberate visible loss:
 *
 * - High Quality **off**: the cloud band is empty. Nothing the parallax layer
 *   owns is painted up there any more.
 * - High Quality **on**: a shader paints clouds in that band, and they move.
 *
 * ## Why "gone" needs more care than "there"
 *
 * An assertion that a region stopped changing is satisfied by a black screen, a
 * scene that never booted, and a sampler pointed at the wrong rectangle. So
 * every "the clouds are gone" reading here is taken **at the same moment** as a
 * reading of the ridge band, which the same toggle still has to move. If the
 * frame were blank or the toggle dead, the ridge control would say so first.
 *
 * ## Why the band is found rather than fixed
 *
 * The parallax layers sit *behind* the terrain, so a strip that happens to be
 * pointed at rock shows the same pixels whether a cloud is drawn or not.
 * `living-sky` pays for this lesson twice over; the carve-and-find-open-sky
 * machinery below is its, for the same reason.
 *
 * ## Why motion is measured over small patches
 *
 * A drifting field has a nearly constant mean over a wide rectangle — what
 * leaves one side arrives at the other. `fog-shader` reported a working shader
 * drifting by 0.5, the same as a static rectangle, before it was cut into
 * patches. The control is the same measurement with the drift clock **pinned**:
 * a frozen sky that still "moves" means something else in the patch is
 * animating, and the motion claim would be measuring that instead.
 *
 * ## ...and why "it moves" is not enough on its own
 *
 * **Measured, by planting it.** Freezing `offset` — the drift and the camera
 * parallax, the whole reason a cloud crosses the sky — left the patch
 * measurement at 5.47 against a floor of 2, because the deck's *shapes* still
 * evolve and that alone clears the bar. So a check carrying only that assertion
 * reports "the clouds animate" for a deck nailed to the screen.
 *
 * What separates them is **which way** the picture moved. §4b profiles the
 * clouds' own contribution along x — the frame with them minus the frame without
 * them, so the sun and the gradient cancel — and finds the horizontal shift that
 * best lines up two moments. Reshaping in place has no best shift; drifting
 * does, and its size is `CLOUD_DRIFT` times the interval.
 */
import { samplePatch } from './pixels.mjs'

/**
 * Fraction of the cloud band the parallax toggle may still move with High
 * Quality off.
 *
 * The scene is frozen — `setTime` and `setParallaxClock` are both pinned — so
 * the honest answer is zero and this is headroom for PNG round-tripping, not a
 * budget for a faint cloud. Before this task it measured a third of the band.
 */
const GONE_CEILING = 0.004

/** How much of the band the shader must paint, so "it draws" is not a rounding error. */
const DRAWN_FLOOR = 0.04

/** The ridge band must still move by this much, or the frame is blank and nothing above holds. */
const CONTROL_FLOOR = 0.02

/** Luminance a patch must travel between two frames for the clouds to count as moving. */
const DRIFT_FLOOR = 2.0

/** ...and how still the same patches must be with the drift clock pinned. */
const FROZEN_CEILING = 0.6

/**
 * How much of the drift `CLOUD_DRIFT` predicts must actually show up in the
 * picture.
 *
 * Loose on purpose: the deck reshapes as well as sliding, so the best-matching
 * shift is the drift blurred by that, not the drift exactly. What this is for is
 * telling a deck that crosses the sky from one that only boils in place — and
 * the plant that motivated it recovered a shift of exactly 0.
 */
const DRIFT_SHIFT_FLOOR = 0.4
/**
 * ...and how much more than predicted it may be.
 *
 * Wide, and deliberately so. The near deck runs at `NEAR_SPEED` of the far one
 * and the shared wind warp travels at its own rate, so what this recovers is a
 * mixture rather than `CLOUD_DRIFT` itself — measured, 27 px against a predicted
 * 12 on seed 4242, reproducibly, because both clock values are pinned. It is a
 * ballpark, and its job is to catch a drift wired to nothing or to something
 * wildly wrong, not to pin the constant.
 */
const DRIFT_SHIFT_CEILING = 3.5

/** Fraction of pixels differing between two screenshots inside a rect. */
async function changedFraction(page, b0, b1, rect) {
  return page.evaluate(
    async ([x0, x1, r]) => {
      const load = async (b) => {
        const img = new Image()
        img.src = `data:image/png;base64,${b}`
        await img.decode()
        const cv = document.createElement('canvas')
        cv.width = img.width
        cv.height = img.height
        const c = cv.getContext('2d')
        c.drawImage(img, 0, 0)
        return c.getImageData(r.x, r.y, r.w, r.h).data
      }
      const a = await load(x0)
      const b = await load(x1)
      let n = 0
      for (let i = 0; i < a.length; i += 4) {
        if (
          Math.abs(a[i] - b[i]) > 6 ||
          Math.abs(a[i + 1] - b[i + 1]) > 6 ||
          Math.abs(a[i + 2] - b[i + 2]) > 6
        ) {
          n++
        }
      }
      return n / (a.length / 4)
    },
    [b0, b1, rect],
  )
}

/**
 * The clouds' own contribution along x: one mean per column.
 *
 * **The frame with them minus the frame without**, so everything that is not a
 * cloud — the gradient, the sun, the HUD — cancels to zero and cannot anchor the
 * alignment below. A profile taken off the raw frame would be dominated by the
 * sun sitting in the same strip, which does not move, and would report a drift
 * of zero for any cloud at all.
 */
async function cloudProfile(page, rect, withoutB64) {
  const withB64 = (await page.screenshot()).toString('base64')
  return page.evaluate(
    async ([a64, b64, r]) => {
      const load = async (b) => {
        const img = new Image()
        img.src = `data:image/png;base64,${b}`
        await img.decode()
        const cv = document.createElement('canvas')
        cv.width = img.width
        cv.height = img.height
        const c = cv.getContext('2d')
        c.drawImage(img, 0, 0)
        return c.getImageData(r.x, r.y, r.w, r.h).data
      }
      const a = await load(a64)
      const b = await load(b64)
      const out = new Array(r.w).fill(0)
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w; x++) {
          const i = (y * r.w + x) * 4
          out[x] +=
            Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
        }
      }
      return out.map((v) => v / r.h)
    },
    [withB64, withoutB64, rect],
  )
}

/**
 * The horizontal shift that best lines up two profiles, and what the mismatch is
 * there against not shifting at all.
 *
 * A positive shift means the picture moved **left** between the two, which is
 * the way a field sampled at `uv.x + offset` travels as `offset` grows.
 */
function bestShift(a, b, max) {
  let best = { shift: 0, err: Infinity }
  let zero = Infinity
  for (let s = -max; s <= max; s++) {
    let sum = 0
    let n = 0
    for (let i = Math.max(0, -s); i < Math.min(a.length, a.length - s); i++) {
      sum += Math.abs(a[i + s] - b[i])
      n++
    }
    if (n < a.length / 2) continue
    const err = sum / n
    if (s === 0) zero = err
    if (err < best.err) best = { shift: s, err }
  }
  return { ...best, zero }
}

export default async function ({ page, shot, log }) {
  const dbg = () => page.evaluate(() => window.__game.debug())

  await page.evaluate(() => window.__game.regenerate('4242', 'medium'))
  await page.waitForTimeout(700)
  // Noon: the phase where a cloud is brightest against the sky, so "nothing is
  // drawn" is the hardest claim to make by accident.
  //
  // **Both clocks frozen.** The sky gradient swings the whole way from blue to
  // black on its own, and the cloud field drifts; either one moving between two
  // screenshots would be read as the clouds changing. `fog-shader` freezes the
  // same two for the same reason.
  await page.evaluate(() => {
    window.__game.setTime(0.3 * 120)
    window.__game.setParallaxClock(0)
  })
  await page.waitForTimeout(400)

  // Open a window through the foreground, so the background bands can be seen at
  // all. `living-sky` pays for the same thing: the sandbox spawn puts solid rock
  // across the whole ridge strip at every zoom, and no camera move fixes it.
  //
  // **Carved only to the RIGHT of the player, and sampled only there.** Carving
  // the ground out from under them drops them and the camera follows: measured,
  // one centred carve moved the view down 29 px before the sample, and carving
  // again to compensate just dug the shaft deeper — three passes took the camera
  // from y 729 to y 850 and the ridge band was still pointed at rock. Opening
  // the right-hand side leaves the player standing on what they started on, so
  // the view is where the carve assumed it was.
  const CARVE_FROM = 0.56
  const opened = await page.evaluate((from) => {
    const g = window.__game
    const v = g.debug().worldView
    const radius = Math.ceil(0.07 * v.h) + 8
    let n = 0
    for (let fy = 0.03; fy <= 0.9; fy += 0.06) {
      const wy = v.y + fy * v.h
      for (let wx = v.x + from * v.w; wx <= v.x + v.w; wx += radius) {
        g.carve(Math.round(wx), Math.round(wy), radius)
        n++
      }
    }
    return { carves: n, radius, cameraY: Math.round(v.y) }
  }, CARVE_FROM)
  await page.waitForTimeout(700)
  const settled = await page.evaluate(() => Math.round(window.__game.debug().worldView.y))
  log(
    `opened the right of the view with ${opened.carves} carves of r=${opened.radius}; ` +
      `camera y ${opened.cameraY} -> ${settled}`,
  )
  if (Math.abs(settled - opened.cameraY) > 8) {
    throw new Error(
      `the camera moved ${settled - opened.cameraY} px while the hole was opened, so the bands ` +
        `found below are not the bands that were carved`,
    )
  }

  // The widest run of columns that is open air all the way down through each
  // band, in client coordinates.
  const band = await page.evaluate((from) => {
    const v = window.__game.debug().worldView
    const core = window.__game.core
    const r = document.querySelector('canvas').getBoundingClientRect()
    const airRun = (fy0, fy1) => {
      const y0 = r.height * fy0
      const y1 = r.height * fy1
      const clear = (sx) => {
        const wx = v.x + (sx / r.width) * v.w
        for (let sy = y0; sy <= y1; sy += 6) {
          const wy = v.y + (sy / r.height) * v.h
          if (core.solidAt(Math.round(wx), Math.round(wy))) return false
        }
        return true
      }
      let best = null
      let run = null
      // Only the carved half: left of it the player is still standing on rock.
      for (let sx = Math.floor(r.width * (from + 0.04)); sx < r.width - 4; sx += 4) {
        if (clear(sx)) {
          run ??= { x0: sx, x1: sx }
          run.x1 = sx
        } else {
          if (run && (!best || run.x1 - run.x0 > best.x1 - best.x0)) best = run
          run = null
        }
      }
      if (run && (!best || run.x1 - run.x0 > best.x1 - best.x0)) best = run
      if (!best) return null
      return {
        x: Math.round(r.left + best.x0),
        y: Math.round(r.top + y0),
        w: best.x1 - best.x0,
        h: Math.round(y1 - y0),
      }
    }
    return { cloud: airRun(0.08, 0.4), ridge: airRun(0.64, 0.85) }
  }, CARVE_FROM)
  for (const key of ['cloud', 'ridge']) {
    if (!band[key] || band[key].w < 120) {
      throw new Error(
        `no run of open sky wide enough to sample the ${key} band ` +
          `(${band[key] ? band[key].w : 0} px) — the camera is looking at rock`,
      )
    }
  }
  log(`cloud band x ${band.cloud.x}..${band.cloud.x + band.cloud.w}, ridge band x ${band.ridge.x}`)

  /**
   * What the parallax layer contributes to each band, right now.
   *
   * Both bands from one toggle, so the ridge reading is the control *for this
   * measurement* rather than for one taken a second earlier.
   */
  const contribution = async () => {
    const withL = (await page.screenshot()).toString('base64')
    await page.evaluate(() => window.__game.setParallaxVisible(false))
    await page.waitForTimeout(300)
    const withoutL = (await page.screenshot()).toString('base64')
    await page.evaluate(() => window.__game.setParallaxVisible(true))
    await page.waitForTimeout(300)
    return {
      cloud: await changedFraction(page, withL, withoutL, band.cloud),
      ridge: await changedFraction(page, withL, withoutL, band.ridge),
    }
  }

  // --- 1. High Quality off: the sprite clouds are gone ----------------------
  const off = await page.evaluate(() => window.__game.setHighQuality(false))
  if (off.setting) throw new Error('High Quality would not turn off')
  if (off.shaderClouds) throw new Error('the cloud shader is drawing with High Quality off')
  await page.waitForTimeout(400)
  await shot('clouds-off')

  const plain = await contribution()
  log(
    `High Quality off: hiding the band changes ${(plain.cloud * 100).toFixed(2)}% of the cloud ` +
      `strip and ${(plain.ridge * 100).toFixed(1)}% of the ridge strip`,
  )
  if (plain.ridge < CONTROL_FLOOR) {
    throw new Error(
      `the control failed first: hiding the parallax band changed only ` +
        `${(plain.ridge * 100).toFixed(1)}% of the RIDGE strip, so either the frame is blank or ` +
        `the toggle is dead — and "the clouds are gone" below would be satisfied by both`,
    )
  }
  if (plain.cloud > GONE_CEILING) {
    throw new Error(
      `with High Quality off the parallax toggle still changes ` +
        `${(plain.cloud * 100).toFixed(1)}% of the cloud band — the sprite clouds are still ` +
        `being drawn, and they were asked to stop`,
    )
  }

  // --- 2. High Quality on: a shader paints them -----------------------------
  const before = await dbg()
  const on = await page.evaluate(() => window.__game.setHighQuality(true))
  if (!on.setting) throw new Error('the setting would not turn on')
  if (!on.shaderClouds) {
    throw new Error(
      'High Quality is on and the cloud shader is not drawing — either this machine has no ' +
        'WebGL, or the shader is not wired',
    )
  }
  await page.waitForTimeout(500)
  await shot('clouds-on')

  const shaded = await contribution()
  log(
    `High Quality on: hiding the band changes ${(shaded.cloud * 100).toFixed(1)}% of the cloud ` +
      `strip and ${(shaded.ridge * 100).toFixed(1)}% of the ridge strip`,
  )
  if (shaded.cloud < DRAWN_FLOOR) {
    throw new Error(
      `the shader clouds cover only ${(shaded.cloud * 100).toFixed(1)}% of the band — that is ` +
        `not a sky with clouds in it`,
    )
  }

  // --- 3. The sky itself did not move ---------------------------------------
  //
  // Clouds are decoration. Day/night, the lightmap's radius and the fog are
  // simulation, and a graphics toggle that moved any of them would be changing
  // the game rather than the picture.
  const after = await dbg()
  for (const key of ['skyPhase', 'darkness', 'fov', 'fogAlpha', 'fogStrength']) {
    const a = before[key]
    const b = after[key]
    const same = typeof a === 'number' ? Math.abs(a - b) < 1e-6 : a === b
    if (!same) {
      throw new Error(`turning High Quality on moved ${key}: ${a} -> ${b}. Clouds are decoration`)
    }
  }
  log(`sky unchanged across the toggle: phase ${after.skyPhase}, darkness ${after.darkness.toFixed(3)}, fov ${after.fov}`)

  // --- 4. And they animate ---------------------------------------------------
  //
  // Small patches, and a frozen control. See the header.
  const spots = [0.15, 0.35, 0.55, 0.75].flatMap((fx) =>
    [0.25, 0.6].map((fy) => ({
      x: Math.round(band.cloud.x + band.cloud.w * fx),
      y: Math.round(band.cloud.y + band.cloud.h * fy),
      w: 28,
      h: 28,
    })),
  )
  const travel = async (label, settle) => {
    const a = await Promise.all(spots.map((s) => samplePatch(page, s)))
    await page.waitForTimeout(settle)
    const b = await Promise.all(spots.map((s) => samplePatch(page, s)))
    const moved = a.map((s, i) => Math.abs(s.lum - b[i].lum))
    const worst = Math.max(...moved)
    log(`${label}: patch luminance moved by up to ${worst.toFixed(2)} over ${settle} ms`)
    return worst
  }

  const frozen = await travel('clock pinned', 1200)
  if (frozen > FROZEN_CEILING) {
    throw new Error(
      `with the drift clock pinned the cloud patches still moved by ${frozen.toFixed(2)} — ` +
        `something else in them is animating, so the drift reading below would measure that`,
    )
  }

  await page.evaluate(() => window.__game.setParallaxClock(null))
  await page.waitForTimeout(300)
  const moving = await travel('clock running', 1200)
  if (moving < DRIFT_FLOOR) {
    throw new Error(
      `the shader clouds moved by only ${moving.toFixed(2)} over 1.2 s against a frozen ` +
        `${frozen.toFixed(2)} — a still cloud is a painted backdrop, not weather`,
    )
  }

  // --- 4b. ...and they cross the sky, rather than boiling in place ----------
  //
  // See the header: freezing `offset` leaves §4 happily passing, because the
  // shapes still evolve. This is the assertion that plant fails.
  {
    // **Both moments are pinned, not waited for.** Wall-clock drift depends on
    // how long a screenshot took — measured, that put the field 24 px along
    // where `CLOUD_DRIFT` predicted 12, which is the shape of assertion that
    // fails on a loaded box rather than on a bug. Pinning the clock makes the
    // interval exact, and it advances the shapes exactly as much as real time
    // would.
    const dt = 2.0
    const drift = await page.evaluate(() => window.__game.constants().CLOUD_DRIFT)
    const strip = {
      x: band.cloud.x,
      y: Math.round(band.cloud.y + band.cloud.h * 0.15),
      w: band.cloud.w,
      h: Math.round(band.cloud.h * 0.6),
    }
    // One "without" frame serves both moments: with the clouds hidden nothing
    // left in the strip moves, which §4's pinned control has just measured.
    await page.evaluate(() => window.__game.setParallaxVisible(false))
    await page.waitForTimeout(300)
    const without = (await page.screenshot()).toString('base64')
    await page.evaluate(() => window.__game.setParallaxVisible(true))
    await page.waitForTimeout(300)

    await page.evaluate(() => window.__game.setParallaxClock(0))
    await page.waitForTimeout(300)
    const p0 = await cloudProfile(page, strip, without)
    await page.evaluate((t) => window.__game.setParallaxClock(t), dt)
    await page.waitForTimeout(300)
    const p1 = await cloudProfile(page, strip, without)

    const want = drift * dt
    const got = bestShift(p0, p1, Math.ceil(want * 4))
    log(
      `over ${dt} s the cloud field lines up best ${got.shift} px to the left ` +
        `(CLOUD_DRIFT predicts ${want.toFixed(1)}); mismatch ${got.err.toFixed(2)} there ` +
        `against ${got.zero.toFixed(2)} unshifted`,
    )
    if (got.shift < want * DRIFT_SHIFT_FLOOR) {
      throw new Error(
        `the cloud field lines up best at a shift of ${got.shift} px where CLOUD_DRIFT over ` +
          `${dt} s predicts ${want.toFixed(1)} — the deck is changing shape without crossing ` +
          `the sky, which is what a dead drift looks like`,
      )
    }
    if (got.shift > want * DRIFT_SHIFT_CEILING) {
      throw new Error(
        `the cloud field lines up best ${got.shift} px along where CLOUD_DRIFT over ${dt} s ` +
          `predicts ${want.toFixed(1)} — whatever is moving the deck, it is not that constant`,
      )
    }
    if (got.err >= got.zero) {
      throw new Error(
        `shifting the profile by ${got.shift} px matched no better than not shifting it ` +
          `(${got.err.toFixed(2)} against ${got.zero.toFixed(2)}) — there is no drift in this ` +
          `picture to find`,
      )
    }
  }

  // --- 5. ...and back off, which must empty the band again -------------------
  const back = await page.evaluate(() => window.__game.setHighQuality(false))
  if (back.shaderClouds) throw new Error('the cloud shader is still drawing with the toggle off')
  await page.evaluate(() => window.__game.setParallaxClock(0))
  await page.waitForTimeout(400)
  const again = await contribution()
  log(`back off: cloud strip ${(again.cloud * 100).toFixed(2)}%, ridge strip ${(again.ridge * 100).toFixed(1)}%`)
  if (again.cloud > GONE_CEILING) {
    throw new Error(
      `turning High Quality off left ${(again.cloud * 100).toFixed(1)}% of the cloud band being ` +
        `painted — the shader is not being hidden`,
    )
  }
  if (again.ridge < CONTROL_FLOOR) {
    throw new Error(`the ridge control collapsed to ${(again.ridge * 100).toFixed(1)}% on the way out`)
  }

  await page.evaluate(() => window.__game.setParallaxClock(null))
  await page.evaluate(() => window.__game.setTime(null))
}
