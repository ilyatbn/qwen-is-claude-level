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
 */
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
