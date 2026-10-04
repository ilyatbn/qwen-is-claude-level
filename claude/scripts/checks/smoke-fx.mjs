#!/usr/bin/env node
/**
 * `smoke-fx` — T23.18: a smoke grenade's cloud is F's smoke (`kit.js::smokeTex` sprites in `P.smoke`, turning and
 * drifting — `look/fx/game.ts::cloudFx`), drawn by the world renderer on both tiers. It replaces `smoke-shader`
 * (T21.18's Phaser cloud quad and the three flat lobes, retired with it, R13/R15).
 *
 *   node scripts/checks/smoke-fx.mjs
 *
 * A real smoke grenade (`DEV_SMOKE=1`) at the thrower's feet; the cloud held (`holdHazards`), the scene frozen.
 *
 * - **The simulation half does not move:** smoke blinds by the server's vision multiplier. Standing in the cloud
 *   reduces `debug().vision` (control), and the number is the same on both tiers.
 * - **Both ends:** the server narrated the hazard; the world renderer laid out `CLOUD_SPRITES` sprites for it.
 * - **Covers the cloud, both tiers:** `RING_POINTS` points at `COVER` of `SMOKE_RADIUS` — the ground that blinds —
 *   are painted (the page as drawn against the effects hidden; control: the hidden frame twice).
 * - **The old flat lobes are gone:** Phaser's layer does not move with the effects hidden.
 * - **It animates** frozen (the sprites turn and drift), against the hidden frame.
 */
import { startStack, enterBattle, standStill, selectWeapon, tally, sleep, freePort, advanceFrames, drawnFrames } from './harness.mjs'
import { photo, comparePhotos, phaserPatch, phaserDelta } from './pixels.mjs'

const PORT = await freePort()
const { fail, ok, finish } = tally('smoke-fx')

/** A point counts as painted when some channel moved by more than this (the blast's and fire's value). */
const VISIBLE = 24
const RING_POINTS = 16
/** The ring's radius as a share of `SMOKE_RADIUS`: the cloud reads out to near the edge the server blinds within. */
const COVER = 0.85

const stack = await startStack({
  port: PORT,
  label: 'smoke-fx',
  env: { ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_SMOKE: '1', FIXED_SEED: '4242', WEATHER: 'off' },
})
const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'smoke-fx' })
const k = await page.evaluate(() => window.__game.constants())
const cloudSprites = await page.evaluate(async () => (await import('/src/look/fx/game.ts')).CLOUD_SPRITES)

const setHQ = (on) => page.evaluate((v) => window.__game.setHighQuality(v), on)
const freeze = (on) => page.evaluate((v) => window.__game.freeze(v), on)
const hideFx = (on) => page.evaluate((v) => window.__world.hideLayers(v ? ['fx'] : []), on)
const frame = () => drawnFrames(page, 2)

await selectWeapon(page, 'smoke')
await standStill(page)
await setHQ(false)
await page.waitForFunction(() => window.__world?.litTerrain?.()?.drawn, null, { timeout: 120_000 })
const clearVision = (await dbg()).vision
if (typeof clearVision !== 'number') fail(`debug().vision is ${clearVision} — the simulation half cannot be read`)

let narrated = 0
try {
  const aim = await page.evaluate(() => {
    const d = window.__game.debug()
    const v = d.worldView
    const cv = document.querySelector('canvas').getBoundingClientRect()
    const wx = d.player.x + 30
    const wy = d.player.y + 120
    return { x: cv.left + ((wx - v.x) / v.width) * cv.width, y: cv.top + ((wy - v.y) / v.height) * cv.height }
  })
  await page.mouse.move(aim.x, aim.y)
  await sleep(150)
  const before = (await dbg()).observed?.hazards ?? 0
  await page.evaluate(() => window.__game.fire())
  await page.waitForFunction((n) => (window.__game.debug().observed?.hazards ?? 0) > n && window.__game.debug().hazardsDrawn > 0, before, { timeout: 10_000 })
  narrated = (await dbg()).observed?.hazards ?? 0
} catch (e) {
  fail(`no smoke cloud was announced and held after a throw: ${e.message}`)
}

if (narrated > 0) {
  // --- the simulation half: what the player can see, both tiers ----------------------------
  await page.waitForFunction('window.__game.debug().vision < 1', null, { timeout: 5_000 }).catch(() => null)
  await sleep(250)
  const visionLow = (await dbg()).vision
  await setHQ(true)
  await sleep(400)
  const visionFull = (await dbg()).vision
  await setHQ(false)
  console.log(`  vision: clear ${clearVision}, in smoke low ${visionLow}, full ${visionFull} (FOV_SMOKE_MULT ${k.FOV_SMOKE_MULT})`)
  if (!(visionLow < clearVision)) fail(`standing in the cloud did not reduce vision (${clearVision} -> ${visionLow}) — the comparison below is of nothing`)
  else ok(`control: the cloud blinds its thrower (${clearVision} -> ${visionLow})`)
  if (visionFull !== visionLow) fail(`vision moved with the tier: ${visionLow} low, ${visionFull} full — a graphics setting changed what a player can see`)
  else ok(`vision is identical on both tiers (${visionFull})`)

  const held = await page.evaluate(() => window.__game.holdHazards(true))
  if (held.held !== true) fail(`holdHazards did not read back: ${JSON.stringify(held)}`)
  await freeze(true)
  await frame()
  const d = await dbg()
  const h = d.observed?.lastHazard
  const sx = (h.x - d.worldView.x) * d.zoom
  const sy = (h.y - d.worldView.y) * d.zoom
  const R = k.SMOKE_RADIUS * d.zoom
  console.log(`  cloud at screen ${sx.toFixed(0)},${sy.toFixed(0)}, radius ${R.toFixed(0)} px`)
  const fx = await page.evaluate(() => window.__world.fx())
  if (!(fx.worldDraws && fx.smoke === cloudSprites * d.hazardsDrawn)) fail(`both ends: ${d.hazardsDrawn} cloud(s) held, the world renderer laid out ${JSON.stringify(fx)} (want ${cloudSprites} sprites each)`)
  else ok(`both ends: the server narrated the cloud; ${fx.smoke} smoke sprites laid out for ${d.hazardsDrawn} cloud(s)`)
  const band = { x: Math.round(sx - R), y: Math.round(sy - R), w: Math.round(2 * R), h: Math.round(2 * R) }
  const ring = Array.from({ length: RING_POINTS }, (_, i) => {
    const a = (i / RING_POINTS) * Math.PI * 2
    return { x: sx + Math.cos(a) * R * COVER, y: sy + Math.sin(a) * R * COVER }
  }).filter((p) => p.x > 2 && p.x < 1278 && p.y > 2 && p.y < 600)
  if (ring.length < RING_POINTS / 2) fail(`only ${ring.length} of the cloud's ring points are on camera`)

  // --- the old flat lobes are gone ----------------------------------------------------------
  const onP = await phaserPatch(page, band)
  await hideFx(true)
  await frame()
  const offP = await phaserPatch(page, band)
  await hideFx(false)
  const moved = phaserDelta(onP, offP)
  if (moved > 1) fail(`Phaser's layer changed ${moved.toFixed(1)} with the effects hidden — smoke is still drawn there`)
  else ok(`the old flat cloud is gone: Phaser's layer does not move with the effects (${moved.toFixed(1)})`)

  // --- covers the cloud, both tiers -----------------------------------------------------------
  // T24.01: the pickups' name labels are Phaser's signage over the world (T23.19D F3), so a ring point under one reads
  // as "unpainted" whatever the smoke does — a supply crate landing beside the thrower put its label on point 12 (9
  // where the rest read 26–129). The labels are off for these photographs; the smoke under them is what is asked.
  await page.evaluate(() => window.__game.setItemLabelsVisible(false))
  for (const hq of [false, true]) {
    const tier = hq ? 'full' : 'low'
    await setHQ(hq)
    await frame()
    const drawn = await photo(page)
    await shot(`smoke-fx-${tier}`)
    await hideFx(true)
    await frame()
    const hidden = await photo(page)
    const hidden2 = await photo(page)
    await hideFx(false)
    const painted = await comparePhotos(page, drawn, hidden, { points: ring, thr: VISIBLE })
    const idle = await comparePhotos(page, hidden, hidden2, { points: ring, thr: VISIBLE })
    const n = painted.points.filter(Boolean).length
    console.log(`  ${tier}: ${n}/${ring.length} points at ${COVER} of the radius painted; per point ${painted.detail.map((p) => p.peak).join(' ')}`)
    if (idle.points.some(Boolean)) fail(`${tier}: control — the hidden frame twice "paints" ${idle.points.filter(Boolean).length} points`)
    if (n !== ring.length) fail(`${tier}: ${ring.length - n} of ${ring.length} points inside the blinding cloud unpainted — blinded by smoke you cannot see`)
    else ok(`${tier}: the drawn cloud covers the ground that blinds (${n} points at ${COVER} R)`)
  }
  await setHQ(false)
  await page.evaluate(() => window.__game.setItemLabelsVisible(true))

  // --- it animates, frozen ---------------------------------------------------------------------
  const STEP_FRAMES = 18
  const STEPS = 5
  const animation = async (hidden) => {
    await hideFx(hidden)
    await frame()
    const first = await photo(page, band)
    let most = 0
    let frames = 0
    for (let i = 0; i < STEPS; i++) {
      frames += (await advanceFrames(page, STEP_FRAMES, 8_000)).frames
      most = Math.max(most, (await comparePhotos(page, first, await photo(page, band))).fraction)
    }
    await hideFx(false)
    return { most, frames }
  }
  const still = await animation(true)
  const living = await animation(false)
  console.log(`  held cloud, most changed of ${STEPS} steps: drawn ${(living.most * 100).toFixed(1)}% (${living.frames} frames), hidden ${(still.most * 100).toFixed(1)}% (${still.frames})`)
  if (living.frames < STEPS * STEP_FRAMES || still.frames < STEPS * STEP_FRAMES) fail(`the page stopped drawing (${living.frames}, ${still.frames}) — nothing here says whether the cloud animates`)
  else if (!(living.most > Math.max(0.01, still.most * 3))) fail(`the cloud changed ${(living.most * 100).toFixed(1)}% at most against ${(still.most * 100).toFixed(1)}% hidden — it does not animate`)
  else ok(`the cloud animates (${(living.most * 100).toFixed(1)}% against ${(still.most * 100).toFixed(1)}% hidden)`)
  if ((await dbg()).hazardsDrawn < 1) fail('the cloud ended during the photographs — every reading above may describe nothing')
  await freeze(false)
  await page.evaluate(() => window.__game.holdHazards(false))
}

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
