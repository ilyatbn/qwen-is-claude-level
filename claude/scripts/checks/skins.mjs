/**
 * T10.05 — the skins menu shows the game's own art, and the choice sticks.
 *
 * Two failures this guards against, both of which have already happened here:
 *
 * 1. **§B12** — a preview routed through the real sprite path that still draws a
 *    placeholder, because the atlas was never loaded. The code is right and the
 *    picture is five identical grey boxes, so `previewIsAtlas` is asserted
 *    directly rather than inferred from "we called PlayerView".
 * 2. **§A39** — the menu's Skins button called `scene.start('Skins')` when no
 *    such scene existed, so clicking it did nothing at all. The check therefore
 *    arrives *through the menu* rather than at `?skins=1`.
 *
 * **T20.12 adds the accessories**, and they are asserted on **rendered pixels**
 * rather than on `debug()`: a hat that is stored, reported and never drawn is the
 * §B21 shape this file's first failure already was, one field over. `PlayerView`
 * has no setter for any appearance field, so a picker that only re-rendered its
 * DOM would report the new hat and keep showing the old one — which is a picture
 * only a screenshot can tell apart from a working one.
 */
import { samplePatch, colourDelta } from './pixels.mjs'

export default async function ({ page, shot, log }) {
  const dbg = () => page.evaluate(() => window.__skins.debug())

  // Arrive the way a player does. If the Skins button is dead again, this hangs
  // here rather than passing against a scene reached by a URL nobody types.
  await page.evaluate(() => document.querySelector('#skins')?.click())
  await page.waitForFunction('!!window.__skins', null, { timeout: 20_000 })
  await page.waitForTimeout(600)

  const start = await dbg()
  log(`${start.skinCount} characters, ${start.stoneCount} tombstones`)
  if (start.skinCount < 2) throw new Error(`only ${start.skinCount} character skins to choose from`)
  if (start.stoneCount < 2) throw new Error(`only ${start.stoneCount} tombstone skins`)

  // §B12: real art, not the placeholder that would look like a working picker.
  if (!start.previewIsAtlas) {
    throw new Error('the character preview is drawing a placeholder, not the atlas')
  }

  // §B3 asks for the *walk* cycle, not a still frame — the frame has to actually
  // change. Sampled over time rather than asserted from "we asked it to play",
  // because a stalled animation and a running one look identical to the caller.
  const frames = new Set()
  for (let i = 0; i < 8; i++) {
    frames.add((await dbg()).previewFrame)
    await page.waitForTimeout(90)
  }
  if (frames.size < 2) {
    throw new Error(`the preview is a still frame: only ever showed ${[...frames]}`)
  }
  log(`preview cycles through ${frames.size} frames`)

  // The greyed-out section must be present *and* inert (§B3). Absent reads as
  // forgotten; enabled reads as broken.
  if (!start.weaponsDisabled) throw new Error('the weapon section is not disabled')
  if (start.weaponsShown === 0) throw new Error('the weapon section drew nothing at all')
  log(`weapons shown ${start.weaponsShown / 2}, section disabled`)

  // Cycling changes what is named, and persists. The control is the *first*
  // half: a step that saved correctly but never redrew would still pass a
  // storage-only assertion.
  await page.evaluate(() => window.__skins.step('skinId', 1))
  await page.waitForTimeout(300)
  const next = await dbg()
  if (next.skinId === start.skinId) throw new Error('stepping the character changed nothing')
  if (next.skinName === start.skinName) {
    throw new Error(`both characters are named ${next.skinName} — the picker cannot be read`)
  }
  if (next.stored.skin !== String(next.skinId)) {
    throw new Error(`chose skin ${next.skinId} and stored ${next.stored.skin}`)
  }
  log(`character ${start.skinName} → ${next.skinName}, stored ${next.stored.skin}`)

  await page.evaluate(() => window.__skins.step('tombstoneSkinId', 1))
  await page.waitForTimeout(300)
  const stone = await dbg()
  if (stone.stoneName === next.stoneName) throw new Error('stepping the tombstone changed nothing')
  if (stone.stored.stone !== String(stone.tombstoneSkinId)) {
    throw new Error(`chose stone ${stone.tombstoneSkinId} and stored ${stone.stored.stone}`)
  }
  log(`tombstone ${next.stoneName} → ${stone.stoneName}, stored ${stone.stored.stone}`)

  // Wrapping: the last id steps to 0 rather than off the end.
  for (let i = 0; i < stone.stoneCount; i++) {
    await page.evaluate(() => window.__skins.step('tombstoneSkinId', 1))
  }
  await page.waitForTimeout(200)
  const wrapped = await dbg()
  if (wrapped.tombstoneSkinId !== stone.tombstoneSkinId) {
    throw new Error(`a full cycle landed on ${wrapped.tombstoneSkinId}, not ${stone.tombstoneSkinId}`)
  }
  log(`a full cycle of ${stone.stoneCount} returns to ${wrapped.stoneName}`)

  await hatsAndGlasses({ page, shot, log, dbg })

  await shot('skins')

  // Esc goes back one step (§B3), and the choice survives the trip.
  await page.keyboard.press('Escape')
  await page.waitForFunction('!!window.__menu', null, { timeout: 10_000 })
  const kept = await page.evaluate(() => ({
    skin: localStorage.getItem('deepcut.skin'),
    stone: localStorage.getItem('deepcut.stone'),
  }))
  if (kept.skin !== String(wrapped.skinId) || kept.stone !== String(wrapped.tombstoneSkinId)) {
    throw new Error(`leaving the menu lost the choice: ${JSON.stringify(kept)}`)
  }
  log(`back at the menu, keeping skin ${kept.skin} and stone ${kept.stone}`)
}

/**
 * Hats and sunglasses, on the pixels (T20.12).
 *
 * The preview is drawn at 3x on a flat background at a known place, so a patch
 * over the character's head is the region where a hat is and nothing else is.
 * Three assertions, each with the control the rule asks for:
 *
 *  - **A hat appears**, against the same head with no hat — the control frame.
 *  - **Two hats differ**, or the picker has one option. `tombstoneTextures`'
 *    stated rule, made observable.
 *  - **The glasses are not the hat**: a second patch lower down moves when the
 *    glasses change and the head patch does not, which is the control *region*.
 */
async function hatsAndGlasses({ page, shot, log, dbg }) {
  const counts = await dbg()
  log(`${counts.hatCount} hats, ${counts.glassesCount} glasses`)
  if (counts.hatCount < 3) throw new Error(`only ${counts.hatCount} hats to choose from`)
  if (counts.glassesCount < 3) throw new Error(`only ${counts.glassesCount} glasses`)

  const setTo = async (field, id) => {
    // Step rather than assign: `step` is the only path the buttons use, so this
    // drives what a player drives.
    for (let i = 0; i < 40; i++) {
      const now = (await dbg())[field]
      if (now === id) return
      await page.evaluate(([f, d]) => window.__skins.step(f, d), [field, 1])
      await page.waitForTimeout(40)
    }
    throw new Error(`could not step ${field} to ${id}`)
  }

  // **Measure the bands while both are on.** They are the extents of the drawn
  // images, so with nothing equipped they are zero and the two rects collapse
  // onto each other — which passed the "the hat moved" assertion and then failed
  // the control, reporting the same delta twice. Measured here, then held fixed
  // for every sample below.
  await setTo('hatId', 1)
  await setTo('glassesId', 1)
  await page.waitForTimeout(250)

  // Where the preview is: `SkinsScene` puts it at (0.34w, 0.46h) at `previewScale`,
  // and the accessories sit where `PlayerView` put them. Derived from the canvas
  // and the renderer rather than spelled, so it follows the layout instead of
  // expiring against it.
  const rects = await page.evaluate(() => {
    const cv = document.querySelector('canvas')
    const r = cv.getBoundingClientRect()
    const g = window.__skins.debug()
    // From the layout and the sprite, not from a coordinate typed here: the
    // preview sits at (0.34w, 0.46h) at scale 3, the body's origin is
    // `(0.5, anchorY)`, and the two accessory bands are computed the same way
    // `PlayerView` computes them. A hardcoded rect is a check that expires the
    // next time the layout or the overshoot moves.
    // **Game units to CSS pixels.** Phaser's `Scale.FIT` draws a 1280x720 buffer
    // into whatever box the page gives it, so every offset below has to be scaled
    // by the ratio — a first draft skipped it, sampled a patch of empty sky and
    // reported 0.0 movement for a hat that was plainly on the screenshot.
    const k = r.width / cv.width
    const x = r.left + r.width * 0.34
    // **The container's origin, not the sprite's top edge.** `hatBottom` and
    // `glassesMid` are already measured from the container origin, so adding the
    // sprite's top offset counted it twice — a first draft did, sampled a patch
    // 120 px above the character, and reported a hat that the screenshot plainly
    // showed as "not drawn".
    const y = r.top + r.height * 0.46
    const s = g.previewScale * k
    return {
      // The hat perches above the sprite's top edge, anchored by its bottom.
      head: {
        x: Math.round(x - 30 * k),
        y: Math.round(y + g.hatBottom * s - g.hatH * s),
        w: Math.round(60 * k),
        h: Math.max(8, Math.round(g.hatH * s)),
      },
      // The glasses band, centred lower and disjoint from the hat's — asserted
      // in `skins-math.test.ts`, which is what lets this be a control region.
      face: {
        x: Math.round(x - 30 * k),
        y: Math.round(y + (g.glassesMid - g.glassesH / 2) * s),
        w: Math.round(60 * k),
        h: Math.max(8, Math.round(g.glassesH * s)),
      },
    }
  })

  log(`sampling hat band ${JSON.stringify(rects.head)} and face band ${JSON.stringify(rects.face)}`)

  await setTo('hatId', 0)
  await setTo('glassesId', 0)
  await page.waitForTimeout(250)
  const bare = { head: await samplePatch(page, rects.head), face: await samplePatch(page, rects.face) }

  await setTo('hatId', 1)
  await page.waitForTimeout(250)
  const hat1 = { head: await samplePatch(page, rects.head), face: await samplePatch(page, rects.face) }

  const hatMoved = colourDelta(bare.head, hat1.head)
  const faceMoved = colourDelta(bare.face, hat1.face)
  log(`hat on: head moved ${hatMoved.toFixed(1)}, face (control region) ${faceMoved.toFixed(1)}`)
  if (hatMoved < 3) {
    throw new Error(
      `putting on ${(await dbg()).hatName} changed the head by ${hatMoved.toFixed(1)} pixels — ` +
        'the hat is stored and reported and not drawn',
    )
  }
  if (faceMoved >= hatMoved) {
    throw new Error(
      `the face moved ${faceMoved.toFixed(1)} and the head ${hatMoved.toFixed(1)} — the whole ` +
        'preview is changing, so nothing is attributable to the hat',
    )
  }

  await setTo('hatId', 2)
  await page.waitForTimeout(250)
  const hat2head = await samplePatch(page, rects.head)
  const between = colourDelta(hat1.head, hat2head)
  log(`hat 1 → hat 2: the head moved ${between.toFixed(1)}`)
  if (between < 3) {
    throw new Error(
      `two hats render ${between.toFixed(1)} apart — they differ in palette rather than ` +
        'silhouette, which is a picker with one option',
    )
  }

  await setTo('glassesId', 1)
  await page.waitForTimeout(250)
  const withGlasses = await samplePatch(page, rects.face)
  const glassesMoved = colourDelta(hat1.face, withGlasses)
  log(`glasses on: the face moved ${glassesMoved.toFixed(1)}`)
  if (glassesMoved < 3) {
    throw new Error(
      `putting on ${(await dbg()).glassesName} changed the face by ${glassesMoved.toFixed(1)} pixels`,
    )
  }
  await shot('skins-accessories')

  // And the choice is in storage, through the same keys everything else reads.
  const stored = (await dbg()).stored
  const chosen = await dbg()
  if (stored.hat !== String(chosen.hatId) || stored.glasses !== String(chosen.glassesId)) {
    throw new Error(
      `chose hat ${chosen.hatId}/glasses ${chosen.glassesId} and stored ${JSON.stringify(stored)}`,
    )
  }
  log(`stored hat ${stored.hat} (${chosen.hatName}), glasses ${stored.glasses} (${chosen.glassesName})`)
}
