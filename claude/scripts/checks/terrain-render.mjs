/**
 * `terrain-render` — the gate for §C0: destroying terrain must change the picture.
 *
 * This is the assertion whose absence let the bug ship. Every existing check about
 * destruction asserted on the *mask* — solid-pixel counts, checksums agreeing
 * between clients — and all of them passed while the game rendered a map that had
 * stopped being true.
 *
 * Three things this check learned the hard way, all from running it on more than
 * one seed:
 *
 *   1. **Do not carve under the player.** The ground goes, they fall, the camera
 *      follows, and 36 % of the frame changes — the delta then measures camera
 *      motion, not destruction.
 *   2. **Wait for the camera to stop** before computing a patch from `worldView`.
 *      A fixed sleep left it 141 px out on seed 1 against an 84 px patch, so the
 *      patch missed the crater entirely and the check blamed the renderer while
 *      the mask had gone 2313 solid pixels to 0.
 *   3. **Mean colour is the wrong discriminator.** A crater into dark cave
 *      backdrop barely moves the mean (21.9 on seed 777) while a crater into lit
 *      rock moves it 136. Tuning a threshold to one map is §A19 applied to a
 *      fixture. What actually separates "the terrain re-baked" from "only the
 *      props were removed" is the **fraction of the patch that changed**: a crater
 *      rewrites most of its disc, prop removal rewrites a few dozen pixels.
 */
import { samplePatch } from './pixels.mjs'

/** Fraction of pixels differing between two frames, optionally inside a rect. */
async function changedFraction(page, beforeB64, afterB64, rect) {
  return page.evaluate(
    async ([b0, b1, r]) => {
      const load = async (b) => {
        const img = new Image()
        img.src = `data:image/png;base64,${b}`
        await img.decode()
        const cv = document.createElement('canvas')
        cv.width = img.width
        cv.height = img.height
        const c = cv.getContext('2d')
        c.drawImage(img, 0, 0)
        return { d: c.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height }
      }
      const A = await load(b0)
      const B = await load(b1)
      const x0 = r ? Math.max(0, r.x) : 0
      const y0 = r ? Math.max(0, r.y) : 0
      const x1 = r ? Math.min(A.w, r.x + r.w) : A.w
      const y1 = r ? Math.min(A.h, r.y + r.h) : A.h
      let n = 0
      let tot = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * A.w + x) * 4
          tot++
          const d =
            Math.abs(A.d[i] - B.d[i]) +
            Math.abs(A.d[i + 1] - B.d[i + 1]) +
            Math.abs(A.d[i + 2] - B.d[i + 2])
          if (d > 24) n++
        }
      }
      return tot === 0 ? 0 : n / tot
    },
    [beforeB64, afterB64, rect ?? null],
  )
}

export default async function ({ page, shot, log }) {
  const seed = process.env.TERRAIN_SEED ?? '4242'
  await page.evaluate((s) => window.__game.regenerate(s, 'medium'), seed)
  await page.waitForTimeout(600)

  // Stand somewhere stable first, then pick the target FROM THE SETTLED CAMERA.
  // Choosing it beforehand put it off the bottom of the screen on seed 4242 and
  // left the view still moving on seed 1 — both are the same mistake as the
  // original bug in this check: computing screen coordinates from a camera that
  // is not where you think it is.
  const stand = await page.evaluate(() => {
    const g = window.__game
    const p = g.core.meta.spawn_points[0]
    return { x: p.x, y: p.y }
  })
  await page.evaluate((p) => window.__game.place(p.x, p.y - 20), stand)

  // Three consecutive stable samples, not one: a slow lerp can look still for a
  // single 100 ms window and then carry on.
  const settle = async () => {
    let last = null
    let stableFor = 0
    for (let i = 0; i < 90; i++) {
      const v = await page.evaluate(() => {
        const d = window.__game.debug()
        return { x: d.worldView.x, y: d.worldView.y, z: d.zoom }
      })
      if (last && Math.abs(v.x - last.x) < 0.4 && Math.abs(v.y - last.y) < 0.4) {
        if (++stableFor >= 3) return v
      } else {
        stableFor = 0
      }
      last = v
      await page.waitForTimeout(100)
    }
    throw new Error('the camera never stopped moving — any patch computed now is a guess')
  }
  const cam = await settle()

  const R = 42
  const M = R + 16 // keep the whole patch, and its control, inside the frame
  /**
   * The fraction of the crater patch that has to change for the assertion below
   * to pass, and therefore the thing the target has to be selected *for*.
   *
   * Named once and read in both places. It was spelled `0.25` at the assertion
   * only, while the selection asked an unrelated question — which is how a
   * fixture ends up choosing a target its own assertion cannot accept.
   */
  const PATCH_CHANGE_MIN = 0.25

  /**
   * **The rockiest candidate, not the first one that is merely legal.**
   *
   * This took the first `surface_points` entry that was on screen, solid and
   * 150 px from the player. That is not what the check needs: it needs a patch
   * that is *mostly solid rock*, because a crater into thin terrain over cave
   * backdrop repaints almost nothing — this file's own header says so, and it
   * is why the discriminator is a change fraction rather than a mean.
   *
   * Pass 6b added surface points on top of stamped objects, so "the first legal
   * one" moved from 74% solid to 37% solid and the crater stopped repainting
   * enough of its own patch. Measured, baseline against HEAD:
   *
   *   f1d2d2a  target (288,381)  solid-in-patch 74%  ->  patch changed 100.0%  ok
   *   5d14aef  target (432,736)  solid-in-patch 37%  ->  patch changed   0.5%  FAILED
   *
   * The map is free to move. A fixture that picks by "first match" is not
   * pinned to the map so much as to the map's iteration order, which is worse.
   * So: score every candidate by exactly what the assertion needs, and take the
   * best one.
   */
  const target = await page.evaluate(
    ([c, st, m, r]) => {
      const g = window.__game
      let best = null
      for (const p of g.core.meta.surface_points) {
        const t = { x: p.x, y: p.y + 40 }
        if (!g.core.solidAt(t.x, t.y)) continue
        const sx = (t.x - c.x) * c.z
        const sy = (t.y - c.y) * c.z
        if (sx < m || sx > 1280 - m || sy < m || sy > 720 - m) continue
        if (Math.abs(t.x - st.x) < 150) continue // do not undermine the player
        // How much of the patch this crater would actually be able to repaint.
        // Sampled on a 3 px lattice: 784 reads per candidate is cheap, and the
        // number is the one the assertion will be judged on.
        let solid = 0
        let total = 0
        for (let dy = -r; dy <= r; dy += 3) {
          for (let dx = -r; dx <= r; dx += 3) {
            total++
            if (g.core.solidAt(t.x + dx, t.y + dy)) solid++
          }
        }
        const solidFrac = solid / total
        if (!best || solidFrac > best.solidFrac) best = { x: t.x, y: t.y, sx, sy, solidFrac }
      }
      return best
    },
    [cam, stand, M, R],
  )
  if (!target) throw new Error('no on-screen rock clear of the player — fixture cannot test this')
  // Say what was chosen and why. Six fixtures broke silently in T16.02 and four
  // were caught only by their own vacuity guards; one line of output here turns
  // the next such break into a diagnosis instead of an investigation.
  log(
    `target world (${target.x},${target.y}) screen (${Math.round(target.sx)},` +
      `${Math.round(target.sy)}) — ${(target.solidFrac * 100).toFixed(0)}% of its patch is solid`,
  )
  // **Fail rather than proceed with a poor one** (D-29). A candidate whose patch
  // is barely rock cannot repaint `PATCH_CHANGE_MIN` of itself however healthy
  // the renderer is, and running the assertion anyway reports a renderer bug
  // that is really a fixture with nowhere to aim. Twice the assertion's own
  // threshold, so the margin is derived rather than picked.
  if (target.solidFrac < PATCH_CHANGE_MIN * 2) {
    throw new Error(
      `the rockiest on-screen target is only ${(target.solidFrac * 100).toFixed(0)}% solid — ` +
        `no crater here can repaint the ${(PATCH_CHANGE_MIN * 100).toFixed(0)}% this check ` +
        'asserts, so the fixture has nowhere to aim on this map',
    )
  }

  const screen = { x: target.sx, y: target.sy }
  const patch = { x: Math.round(screen.x - R), y: Math.round(screen.y - R), w: R * 2, h: R * 2 }
  // The control goes on the side AWAY from the player. Put it towards them and it
  // lands on an animating sprite, which reads as "the control also changed" — 6.6 %
  // on seed 99, and a control that moves for its own reasons is not a control.
  // NEVER clamp a control towards its subject. Clamping put it at x=10 on seed
  // 31337 — inside the crater — and it then reported "the control changed 100%",
  // which reads as a broken renderer and is a broken fixture.
  const away = target.x >= stand.x ? 1 : -1
  const candidates = [screen.x + away * 230, screen.x - away * 230]
  const cx = candidates.find((c) => c - 30 > 4 && c + 30 < 1276)
  if (cx === undefined) {
    throw new Error('no on-screen control clear of the crater — fixture cannot test this')
  }
  const control = { x: Math.round(cx - 30), y: patch.y, w: 60, h: 60 }

  const before = await samplePatch(page, patch)
  const controlBefore = await samplePatch(page, control)
  const fullBefore = (await page.screenshot()).toString('base64')
  await shot('terrain-render-before')

  await page.evaluate((t) => window.__game.carve(t.x, t.y, 60), target)
  await page.waitForTimeout(600)

  const after = await samplePatch(page, patch)
  const controlAfter = await samplePatch(page, control)
  const fullAfter = (await page.screenshot()).toString('base64')
  await shot('terrain-render-after')

  // The view must not have moved: a translating frame makes every colour delta
  // meaningless, and that is what a fixed sleep produced on seed 1.
  const spread = await changedFraction(page, fullBefore, fullAfter)
  if (spread > 0.15) {
    throw new Error(
      `${(spread * 100).toFixed(1)}% of the frame changed — the view is moving, so any ` +
        'delta here measures camera motion rather than the crater',
    )
  }

  // The discriminator. A re-baked crater rewrites most of its disc; removing the
  // props that stood on it rewrites a handful of pixels. Falsifying the drain
  // leaves this at a few percent while the mean still moves 15-16, which is why
  // the mean alone could pass against the bug.
  const inPatch = await changedFraction(page, fullBefore, fullAfter, patch)
  const inControl = await changedFraction(page, fullBefore, fullAfter, control)
  log(
    `frame ${(spread * 100).toFixed(1)}%  patch ${(inPatch * 100).toFixed(1)}%  ` +
      `control ${(inControl * 100).toFixed(1)}%  mean ${(after.lum - before.lum).toFixed(1)}`,
  )
  if (inPatch < PATCH_CHANGE_MIN) {
    throw new Error(
      `only ${(inPatch * 100).toFixed(1)}% of the crater patch changed — the mask was ` +
        'carved but the chunk was never re-baked',
    )
  }
  if (inControl > 0.05) {
    throw new Error(`the control region changed by ${(inControl * 100).toFixed(1)}% — not a control`)
  }

  // No mean-colour assertion here on purpose. It needs a threshold, and any
  // threshold is tuned to one map's lighting: 136 on lit rock, 21.9 into dark
  // cave backdrop, and the falsified build still scored 15-16. The change
  // FRACTION separates those cases without a magic number, so it is the whole
  // discriminator and the mean is logged for humans only.

  // The mask must agree with the picture, or the renderer is drawing a hole
  // nothing can walk through.
  const solid = await page.evaluate((t) => window.__game.core.solidAt(t.x, t.y), target)
  if (solid) throw new Error('the crater is drawn but the mask still says solid')

  // Layer parity (§C1). The sandbox's world layers must be exactly the shared
  // stack's, so a layer added to one scene shows up here.
  //   -30,-29,-28 sky   0 terrain   9 teleport pads   10 decorations   19 chutes
  //   20 world items   30 actors   38 sandbox hazard gfx   39 weather vignette
  //   40 particles   50 lightmap
  //
  // 19 and 20 arrived with T13.05. They are listed here because `WorldView` owns
  // the item layer, so the sandbox gets it too — that is the point of §C1, and
  // the reason this list grew rather than the game's list being special-cased.
  // The layer is empty in the sandbox (nothing spawns items without a server);
  // an empty shared layer is the correct outcome, a missing one is the bug.
  // 9 is T15.01's teleport pads (§C5). It is here as well as in the game's list
  // because `WorldView` owns the layer, which is the whole point of §C1.
  const EXPECTED = [-30, -29, -28, -22, -21, -20, 0, 9, 10, 19, 20, 30, 38, 39, 40, 50]
  const depths = await page.evaluate(() => window.__game.sceneDepths())
  if (!Array.isArray(depths) || depths.length === 0) {
    throw new Error('sceneDepths() returned nothing — this check could not fail, so it proves nothing')
  }
  if (depths.join(',') !== EXPECTED.join(',')) {
    throw new Error(
      `the sandbox builds world layers [${depths.join(',')}], expected [${EXPECTED.join(',')}]`,
    )
  }
  log(`layer set: [${depths.join(',')}]`)
}
