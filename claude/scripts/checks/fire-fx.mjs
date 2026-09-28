#!/usr/bin/env node
/**
 * `fire-fx` — T23.18: fire is F's (`kit.js::explosion`'s fire as a flame's tongue, with the flamethrower sprite's
 * glow; the crowd blended by its brightest, not summed — `look/fx/`), drawn by the world renderer on both tiers. It
 * replaces `fire-shader` (T21.18's Phaser flame quads and T21.36's flat discs, retired with it, R13/R15).
 *
 *   node scripts/checks/fire-fx.mjs
 *
 * A real molotov on a real server; the field settles, the scene is frozen. Every photograph is the page as drawn
 * against the same frozen instant with only the effects hidden (`__world.hideLayers(['fx'])`), the effect lights on.
 *
 * - **Both ends:** the server lit `MOLOTOV_FLAMES`; the world renderer laid out one fire per flame the layer holds.
 * - **The simulation half, both tiers:** a flame hurts anyone within `FLAME_RADIUS` of its centre, so every point just
 *   inside every on-camera flame's damage circle (`RING_POINTS` each) is painted by the fire (`VISIBLE`, its basis at
 *   the constant). Control: the hidden frame twice.
 * - **The old flat fire is gone:** Phaser's layer over the field does not move with the effects hidden.
 * - **It animates** frozen (the fire flows), against the hidden frame.
 */
import { startStack, enterBattle, standStill, selectWeapon, tally, sleep, freePort, advanceFrames, drawnFrames } from './harness.mjs'
import { photo, comparePhotos, phaserPatch, phaserDelta } from './pixels.mjs'

const PORT = await freePort()
const { fail, ok, finish } = tally('fire-fx')

/**
 * A ring point counts as painted **by the fire itself** — not only by its glow and light — when some channel moved by
 * more than this. Measured (fire-fx, T23.18, `FLAME_HEAT` 0.55): the drawn fire's faintest point 99 (low) / 76 (full);
 * planted with the tongue at under half its width (`FLAME_REACH` 0.9), the glow and light still move points, the faintest
 * 32 / 21 — and at `explosion-shader`'s 24 that plant paints 172 and 182 of 192. Between the two faintest.
 */
const VISIBLE = 48
const RING_POINTS = 8

const stack = await startStack({
  port: PORT,
  label: 'fire-fx',
  env: { ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_LOADOUT: '1', DEV_START_HEALTH: '150', FIXED_SEED: '4242', WEATHER: 'off' },
})
const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'fire-fx' })
const k = await page.evaluate(() => window.__game.constants())

const setHQ = (on) => page.evaluate((v) => window.__game.setHighQuality(v), on)
const freeze = (on) => page.evaluate((v) => window.__game.freeze(v), on)
const hideFx = (on) => page.evaluate((v) => window.__world.hideLayers(v ? ['fx'] : []), on)
const frame = () => drawnFrames(page, 2)

await selectWeapon(page, 'molotov')
await standStill(page)
await setHQ(false)
await page.waitForFunction(() => window.__world?.litTerrain?.()?.drawn, null, { timeout: 120_000 })
// Up and to the right, as `fire-visible` throws: aimed low, a molotov lands at the thrower's feet.
await page.mouse.move(1060, 200)
await sleep(400)

const lit0 = (await dbg()).flamesSpawned ?? 0
await page.evaluate(() => window.__game.fire())
let lit = 0
for (let i = 0; i < 60 && lit < k.MOLOTOV_FLAMES; i++) {
  await sleep(200)
  lit = ((await dbg()).flamesSpawned ?? 0) - lit0
}
if (lit < k.MOLOTOV_FLAMES) fail(`the molotov lit ${lit} flame(s), expected MOLOTOV_FLAMES (${k.MOLOTOV_FLAMES})`)
else ok(`the server lit ${lit} flames`)
let prev = ''
for (let i = 0; i < 25; i++) {
  await sleep(200)
  const now = JSON.stringify((await dbg()).flamesDrawnAt ?? [])
  if (now !== '[]' && now === prev) break
  prev = now
}

await freeze(true)
await frame()
const d = await dbg()
const R = k.FLAME_RADIUS * d.zoom
const held = (d.flamesDrawnAt ?? []).length
const fx = await page.evaluate(() => window.__world.fx())
// One tongue (a disc blended by the brightest) per flame the layer holds.
if (!(fx.worldDraws && fx.flames === held && held > 0)) fail(`both ends: the layer holds ${held} flames, the world renderer laid out ${JSON.stringify(fx)}`)
else ok(`both ends: ${held} flames held, ${fx.flames} fires laid out by the world renderer`)
const onScreen = (d.flamesDrawnAt ?? [])
  .map((f) => ({ x: (f.x - d.worldView.x) * d.zoom, y: (f.y - d.worldView.y) * d.zoom }))
  .filter((p) => p.x > R + 2 && p.x < 1280 - R - 2 && p.y > R + 2 && p.y < 600 - R)
console.log(`  ${held} flame(s) held by the layer, ${onScreen.length} on camera; damage radius ${R.toFixed(1)} screen px`)
if (onScreen.length < 2) {
  fail(`only ${onScreen.length} flame(s) on camera — nothing below would be a claim about fire`)
} else {
  const xs = onScreen.map((p) => p.x)
  const ys = onScreen.map((p) => p.y)
  const pad = Math.ceil(R * 2)
  const bx = Math.max(0, Math.floor(Math.min(...xs) - pad))
  const by = Math.max(0, Math.floor(Math.min(...ys) - pad * 2))
  const band = { x: bx, y: by, w: Math.min(1280, Math.ceil(Math.max(...xs) + pad)) - bx, h: Math.min(600, Math.ceil(Math.max(...ys) + pad)) - by }
  const ring = onScreen.flatMap((p) =>
    Array.from({ length: RING_POINTS }, (_, i) => {
      const a = (i / RING_POINTS) * Math.PI * 2
      return { x: p.x + Math.cos(a) * (R - 1), y: p.y + Math.sin(a) * (R - 1) }
    }),
  )

  // --- the old flat fire is gone -------------------------------------------------------
  const onP = await phaserPatch(page, band)
  await hideFx(true)
  await frame()
  const offP = await phaserPatch(page, band)
  await hideFx(false)
  const moved = phaserDelta(onP, offP)
  if (moved > 1) fail(`Phaser's layer changed ${moved.toFixed(1)} with the effects hidden — fire is still drawn there`)
  else ok(`the old flat fire is gone: Phaser's layer over the field does not move with the effects (${moved.toFixed(1)})`)

  // --- the damage circles are covered, both tiers ---------------------------------------
  for (const hq of [false, true]) {
    const tier = hq ? 'full' : 'low'
    await setHQ(hq)
    await frame()
    const drawn = await photo(page)
    await shot(`fire-fx-${tier}`)
    await hideFx(true)
    await frame()
    const hidden = await photo(page)
    const hidden2 = await photo(page)
    await hideFx(false)
    const painted = await comparePhotos(page, drawn, hidden, { points: ring, thr: VISIBLE })
    const idle = await comparePhotos(page, hidden, hidden2, { points: ring, thr: VISIBLE })
    const n = painted.points.filter(Boolean).length
    const peaks = painted.detail.map((p) => p.peak).sort((x, y) => x - y)
    console.log(`  ${tier}: damage-circle points painted ${n}/${ring.length}; peaks min ${peaks[0]} p10 ${peaks[Math.floor(peaks.length * 0.1)]} p25 ${peaks[Math.floor(peaks.length * 0.25)]} median ${peaks[Math.floor(peaks.length / 2)]}`)
    if (idle.points.some(Boolean)) fail(`${tier}: control — the hidden frame twice "paints" ${idle.points.filter(Boolean).length} points`)
    if (n !== ring.length) {
      const dark = painted.detail.filter((_, i) => !painted.points[i])
      fail(`${tier}: ${ring.length - n} of ${ring.length} points just inside a flame's damage circle unpainted — burned by fire you cannot see: ${dark.slice(0, 6).map((p) => `(${p.x},${p.y}) peak ${p.peak}`).join('; ')}`)
    } else ok(`${tier}: every point just inside every on-camera damage circle is painted (${ring.length})`)
  }
  await setHQ(false)

  // --- it animates, frozen ----------------------------------------------------------------
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
  console.log(`  frozen fire, most changed of ${STEPS} steps: drawn ${(living.most * 100).toFixed(1)}% (${living.frames} frames), hidden ${(still.most * 100).toFixed(1)}% (${still.frames})`)
  if (living.frames < STEPS * STEP_FRAMES || still.frames < STEPS * STEP_FRAMES) fail(`the page stopped drawing (${living.frames}, ${still.frames}) — nothing here says whether the fire animates`)
  else if (!(living.most > Math.max(0.01, still.most * 3))) fail(`the fire changed ${(living.most * 100).toFixed(1)}% at most against ${(still.most * 100).toFixed(1)}% hidden — it does not animate`)
  else ok(`the fire animates (${(living.most * 100).toFixed(1)}% against ${(still.most * 100).toFixed(1)}% hidden)`)
}

await freeze(false)
if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
