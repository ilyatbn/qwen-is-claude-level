/**
 * `terrain-render` — the gate for §C0: destroying terrain must change the picture.
 *
 * This is the assertion whose absence let the bug ship. Every existing check about
 * destruction asserted on the *mask* — solid-pixel counts, checksums agreeing
 * between clients — and all of them passed while the game rendered a map that had
 * stopped being true. The mask was right. The canvas was stale.
 *
 * Run against the **sandbox**, which now builds through the same `WorldView` the
 * game does (§C1). That is the point of the migration: one stack means this check
 * covers both scenes. The layer-parity assertion below is what keeps that honest —
 * if the two scenes ever diverge again, it fails here rather than in a playtest.
 */
import { samplePatch, assertChanged, assertUnchanged } from './pixels.mjs'

export default async function ({ page, shot, log }) {
  await page.evaluate(() => window.__game.regenerate('4242', 'medium'))
  await page.waitForTimeout(600)

  // Carve where there is rock, not where a coordinate happened to look good. A
  // hardcoded point has been open sky twice on this project (T11.10, and again in
  // checksum.rs when the default scale moved) and the test then failed claiming
  // something else entirely.
  const target = await page.evaluate(() => {
    const g = window.__game
    const pts = g.core.meta.surface_points
    const p = pts[Math.floor(pts.length / 2)]
    return { x: p.x, y: p.y + 40 } // below the surface, so a circle bites rock
  })

  // Put the camera on it: a screenshot that does not contain its subject is not
  // evidence (§A22).
  await page.evaluate((t) => window.__game.place(t.x, t.y - 120), target)
  await page.waitForTimeout(500)

  const screen = await page.evaluate((t) => {
    const cam = window.__game.debug().worldView
    const z = window.__game.debug().zoom
    return { x: (t.x - cam.x) * z, y: (t.y - cam.y) * z }
  }, target)

  const R = 42
  const patch = { x: Math.round(screen.x - R), y: Math.round(screen.y - R), w: R * 2, h: R * 2 }
  // The control sits well away from the crater but still on terrain, so "the
  // frame changed everywhere" cannot masquerade as "the crater appeared".
  const control = { x: Math.max(0, patch.x - 300), y: patch.y, w: 60, h: 60 }

  if (patch.x < 0 || patch.y < 0 || patch.x + patch.w > 1280 || patch.y + patch.h > 720) {
    throw new Error(`the carve target is off-screen at ${JSON.stringify(patch)} — nothing to sample`)
  }

  const before = await samplePatch(page, patch)
  const controlBefore = await samplePatch(page, control)
  await shot('terrain-render-before')

  await page.evaluate((t) => window.__game.carve(t.x, t.y, 60), target)
  await page.waitForTimeout(600)

  const after = await samplePatch(page, patch)
  const controlAfter = await samplePatch(page, control)
  await shot('terrain-render-after')

  const r = assertChanged(before, after, {
    label: 'the carved crater',
    control: { before: controlBefore, after: controlAfter },
    // 40, not 10. Falsifying the drain leaves this region moving 15.5 anyway —
    // the props standing on the crater are removed by a different code path, and
    // their disappearance alone clears a threshold of 10. So a 10 would have
    // passed against the very bug this check exists for. With the drain: 96.9.
    minDelta: 40,
  })
  log(`crater changed by ${r.delta.toFixed(1)}; control held at ${r.controlDelta.toFixed(1)}`)

  // The mask must agree with the picture. Asserting only the pixels would pass for
  // a renderer that draws a hole nothing can walk through.
  const solid = await page.evaluate((t) => window.__game.core.solidAt(t.x, t.y), target)
  if (solid) throw new Error('the crater is drawn but the mask still says solid')

  // Layer parity, the half this page can prove (§C1).
  //
  // The full assertion is "both scenes build the same world layers", and it wants
  // two live scenes. `?game=1` cannot build a world without a server, so the
  // cross-scene comparison belongs in a check that runs one — it is done at the
  // milestone verification, not here. What IS proved here: the sandbox's world
  // layers are exactly the shared stack's, so a layer added inline to the sandbox
  // fails immediately.
  const sandboxDepths = await page.evaluate(() => window.__game.sceneDepths())
  if (!Array.isArray(sandboxDepths) || sandboxDepths.length === 0) {
    throw new Error('sceneDepths() returned nothing — this check could not fail, so it proves nothing')
  }
  // Measured, not guessed — my first version of this asserted a set I had
  // reasoned out of the DEPTH table and it was wrong three ways: the sky is three
  // sub-layers (-30/-29/-28), the cave backdrop is baked into the chunks rather
  // than being a scene layer (§A14), and 38 is the sandbox's own hazard graphics.
  //   -30,-29,-28 sky   0 terrain   10 decorations   30 actors
  //   38 sandbox hazard gfx   40 particles   50 lightmap
  const EXPECTED = [-30, -29, -28, 0, 10, 30, 38, 40, 50]
  const got = sandboxDepths.join(',')
  if (got !== EXPECTED.join(',')) {
    throw new Error(
      `the sandbox builds world layers [${got}], expected [${EXPECTED.join(',')}]. ` +
        'A layer added to one scene and not the shared stack is §C0 starting again.',
    )
  }
  log(`layer set: [${got}]`)

  // Locate rock for the second carve rather than offsetting blindly. Picking
  // `target.x + 140` put it in open air: the carve removed nothing, the mean
  // barely moved, and the failure read as "the renderer dropped a carve" when
  // nothing had been carved. That is the checksum-test trap (T11.10) a third time.
  const second = await page.evaluate((t) => {
    const g = window.__game
    const d = g.debug()
    const onScreen = (p) => {
      const sx = (p.x - d.worldView.x) * d.zoom
      const sy = (p.y - d.worldView.y) * d.zoom
      return sx > 60 && sx < 1220 && sy > 60 && sy < 660
    }
    for (const p of g.core.meta.surface_points) {
      const c = { x: p.x, y: p.y + 40 }
      if (Math.hypot(c.x - t.x, c.y - t.y) < 130) continue // clear of the first crater
      if (!g.core.solidAt(c.x, c.y)) continue
      if (!g.core.solidAt(c.x + 30, c.y + 10)) continue
      if (!onScreen(c)) continue
      return c
    }
    return null
  }, target)
  if (!second) throw new Error('no second solid on-screen target — the fixture cannot test this')

  const toScreen = async (w) =>
    page.evaluate((p) => {
      const d = window.__game.debug()
      return { x: (p.x - d.worldView.x) * d.zoom, y: (p.y - d.worldView.y) * d.zoom }
    }, w)

  const s2 = await toScreen(second)
  const patch2 = { x: Math.round(s2.x - 40), y: Math.round(s2.y - 40), w: 80, h: 80 }

  // A fresh control for this assertion, placed away from BOTH craters. Reusing
  // the first control failed here: the located second target happened to sit near
  // it, so the "control" was inside the blast and reported the frame as changing
  // everywhere. A control chosen before you know where the subject is, is not a
  // control.
  const far = (cx) =>
    Math.abs(cx - s2.x) > 220 && Math.abs(cx - screen.x) > 220 && cx > 40 && cx < 1180
  const ctrlX = [s2.x - 300, s2.x + 300, screen.x - 320, screen.x + 320].find(far)
  if (ctrlX === undefined) {
    throw new Error('no on-screen control region clear of both craters')
  }
  const control2 = { x: Math.round(ctrlX), y: patch2.y, w: 60, h: 60 }
  const control2Before = await samplePatch(page, control2)

  const beforeTwo = await samplePatch(page, patch2)
  await page.evaluate((t) => {
    // Both in the same tick, so the second lands while the first is still queued.
    window.__game.carve(t.x, t.y, 40)
    window.__game.carve(t.x + 30, t.y + 10, 40)
  }, second)
  await page.waitForTimeout(700)
  const afterTwo = await samplePatch(page, patch2)
  const control2After = await samplePatch(page, control2)

  assertChanged(beforeTwo, afterTwo, {
    label: 'two carves in one frame',
    control: { before: control2Before, after: control2After },
    minDelta: 8,
  })
  // Both must be in the mask too, or one was dropped before it ever reached the
  // renderer and the pixels only prove the other one landed.
  const bothGone = await page.evaluate(
    (t) => !window.__game.core.solidAt(t.x, t.y) && !window.__game.core.solidAt(t.x + 30, t.y + 10),
    second,
  )
  if (!bothGone) throw new Error('one of the back-to-back carves never reached the mask')
  log('back-to-back carves both reached the renderer and the mask')
  await shot('terrain-render-two')
}
