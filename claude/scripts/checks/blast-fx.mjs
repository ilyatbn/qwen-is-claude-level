#!/usr/bin/env node
/**
 * `blast-fx` — T23.18: an explosion is F's (`kit.js::explosion`: plume, fireball, glow, shock ring, sparks), drawn by
 * the world renderer into its HDR scene (`client/src/look/fx/`), on both tiers. It replaces `explosion-shader`
 * (T21.18's Phaser blast quad and flat flash, both retired, R13/R15).
 *
 *   node scripts/checks/blast-fx.mjs
 *
 * One real bazooka blast on a real server, held (`holdImpacts`) and posed at known ages (`advanceImpacts`, the
 * state's own `ageImpacts`), the scene frozen. Every photograph is the page as drawn — world canvas under Phaser's —
 * against the same frozen instant with only the effects hidden (`__world.hideLayers(['fx'])`): **the effect lights
 * stay on in both** (T23.09C F4's debt, owed to T23.18: the blast is gated lit, on the world it is drawn over).
 *
 * - **Both ends:** the server narrated the explosion; the layer holds the blast; the world renderer laid out its
 *   fireball (`__world.fx().discs`) and draws the scene's effects (`worldDraws`).
 * - **The old flat flash is gone:** Phaser's own layer (over black and white, `phaserPatch`) does not change when
 *   the effects are hidden — nothing of the blast is drawn there.
 * - **The simulation half, lit, on both tiers:** at a quarter of its life every one of `RING_POINTS` points just
 *   inside the blast radius is painted (a channel moves past `VISIBLE`) over the world canvas as drawn, and most by the
 *   fire itself (`FIRE_VISIBLE`, its basis at the constant). Control: two photographs of the hidden frame paint none.
 * - **Bloom present, and absent in the control:** early, the pixels above `BLOOM_LUMA` in the blast's box against the
 *   same box with the effects hidden.
 * - **It lingers** past the flat flash's 0.35 s (the plume), and **animates as it ages** (the fire boils): the most
 *   changed of five small age steps, against the same steps with the effects hidden. T23.19D (R27): the boil is part
 *   of the blast's age now (it passes through F1's still at its peak), so a blast held at one age is still — the leg
 *   used to hold the age and watch a clock-driven boil.
 */
import { startStack, enterBattle, standStill, selectWeapon, tally, sleep, freePort, drawnFrames } from './harness.mjs'
import { photo, comparePhotos, phaserPatch, phaserDelta } from './pixels.mjs'
import { BLOOM_LUMA } from '../lib/look-compare.mjs'

const PORT = await freePort()
const { fail, ok, finish } = tally('blast-fx')

/** A point counts as painted when some channel moved by more than this (`explosion-shader`'s value). */
const VISIBLE = 24
const RING_POINTS = 12
/**
 * **Painted by the fire, not only its glow:** at least `FIRE_POINTS` of the ring move by more than `FIRE_VISIBLE`.
 * Measured (blast-fx, T23.18): the drawn blast moves 10/12 points past 128 on both tiers (the other two 59–85, where
 * the front's noise dips); planted at half the scale (`BLAST_REACH` × 2) its glow and light still paint all 12 past
 * `VISIBLE` but none past 128 (peaks 30–102). So the plain count cannot see the fireball's size and this one can.
 */
const FIRE_VISIBLE = 128
const FIRE_POINTS = 9
/** Bloom: the early blast must put at least this many more above-threshold pixels in its box than the hidden frame. */
const BLOOM_MIN_PX = 200

const stack = await startStack({
  port: PORT,
  label: 'blast-fx',
  env: { ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_LOADOUT: '1', DEV_START_HEALTH: '150', FIXED_SEED: '4242', WEATHER: 'off' },
})
const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'blast-fx' })
const k = await page.evaluate(() => window.__game.constants())

const setHQ = (on) => page.evaluate((v) => window.__game.setHighQuality(v), on)
const freeze = (on) => page.evaluate((v) => window.__game.freeze(v), on)
const hideFx = (on) => page.evaluate((v) => window.__world.hideLayers(v ? ['fx'] : []), on)
const hold = (on) => page.evaluate((v) => window.__game.holdImpacts(v), on)
const advance = (s) => page.evaluate((v) => window.__game.advanceImpacts(v), s)
const frame = () => drawnFrames(page, 2)
const compare = (a, b, points = [], rect = null) => comparePhotos(page, a, b, { points, thr: VISIBLE, rect })

await selectWeapon(page, 'bazooka')
await standStill(page)
await setHQ(false)
await page.waitForFunction(() => window.__world?.litTerrain?.()?.drawn, null, { timeout: 120_000 })

const aim = await page.evaluate(() => {
  const d = window.__game.debug()
  const v = d.worldView
  const cv = document.querySelector('canvas').getBoundingClientRect()
  const wx = d.player.x + 220
  const wy = d.player.y + 90
  return { x: cv.left + ((wx - v.x) / v.width) * cv.width, y: cv.top + ((wy - v.y) / v.height) * cv.height }
})
await page.mouse.move(aim.x, aim.y)
await sleep(200)

const before = (await dbg()).observed?.explosions ?? 0
const held = await hold(true)
if (held.held !== true) fail(`holdImpacts did not read back: ${JSON.stringify(held)}`)
await page.evaluate(() => window.__game.fire())
let arrived = false
try {
  await page.waitForFunction((n) => (window.__game.debug().observed?.explosions ?? 0) > n && window.__game.debug().blastsAt.length > 0, before, { timeout: 10_000 })
  arrived = true
} catch {
  fail('no explosion was narrated and recorded within 10 s of the shot')
}

if (arrived) {
  await freeze(true)
  await frame()
  const d = await dbg()
  const b = d.blastsAt[d.blastsAt.length - 1]
  const narrated = (d.observed?.explosions ?? 0) - before
  const cx = (b.x - d.worldView.x) * d.zoom
  const cy = (b.y - d.worldView.y) * d.zoom
  const R = b.r * d.zoom
  console.log(`  blast at screen ${cx.toFixed(0)},${cy.toFixed(0)}, radius ${b.r} world (${R.toFixed(0)} px), held at age ${b.age}; narrated ${narrated}`)
  if (cx < R * 2 || cx > 1280 - R * 2 || cy < R * 2 || cy > 600 - R) fail(`the blast is too near the edge to photograph (${cx.toFixed(0)},${cy.toFixed(0)})`)
  const band = { x: Math.round(cx - R * 1.5), y: Math.round(cy - R * 1.5), w: Math.round(R * 3), h: Math.round(R * 3) }

  // --- early: both ends, the flat flash gone, bloom ----------------------------------
  const early = k.BLAST_SHADER_LIFE * 0.08
  await advance(early)
  await frame()
  const fx = await page.evaluate(() => window.__world.fx())
  if (!(narrated > 0 && fx.worldDraws && fx.discs >= 1 && fx.smoke >= 1)) fail(`both ends: narrated ${narrated}, world renderer ${JSON.stringify(fx)} — no F explosion laid out`)
  else ok(`both ends: the server narrated ${narrated} explosion(s); the world renderer laid out ${fx.discs} disc(s), ${fx.smoke} plume sprites, ${fx.ribbons} sparks`)
  const onP = await phaserPatch(page, band)
  const onFrame = await photo(page)
  await shot('blast-fx-early')
  await hideFx(true)
  await frame()
  const offP = await phaserPatch(page, band)
  const offFrame = await photo(page)
  await hideFx(false)
  const phaserMoved = phaserDelta(onP, offP)
  if (phaserMoved > 1) fail(`Phaser's layer changed ${phaserMoved.toFixed(1)} when the effects were hidden — something of the blast is still drawn there (the retired flat flash?)`)
  else ok(`the old flat flash is gone: Phaser's layer over the blast does not move with the effects (${phaserMoved.toFixed(1)})`)
  const bloom = await page.evaluate(
    async ([a, b2, r, thr]) => {
      const load = async (src) => {
        const img = new Image()
        img.src = `data:image/png;base64,${src}`
        await img.decode()
        const cv = document.createElement('canvas')
        cv.width = img.width
        cv.height = img.height
        const ctx = cv.getContext('2d')
        ctx.drawImage(img, 0, 0)
        return ctx.getImageData(r.x, r.y, r.w, r.h).data
      }
      const count = (d) => {
        let n = 0
        for (let i = 0; i < d.length; i += 4) if (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] > thr) n++
        return n
      }
      return { on: count(await load(a)), off: count(await load(b2)) }
    },
    [onFrame, offFrame, band, BLOOM_LUMA],
  )
  console.log(`  bloom: ${bloom.on} px above luma ${BLOOM_LUMA} in the blast's box drawn, ${bloom.off} with the effects hidden`)
  if (!(bloom.on - bloom.off >= BLOOM_MIN_PX)) fail(`the early blast puts only ${bloom.on - bloom.off} px over the bloom threshold (want ≥ ${BLOOM_MIN_PX})`)
  else ok(`bloom present around the blast (${bloom.on} px) and absent in the control frame (${bloom.off})`)

  // --- a quarter of its life: the front covers the blast radius, lit, both tiers -------
  const quarter = k.BLAST_SHADER_LIFE * 0.25
  await advance(quarter - early)
  const ring = Array.from({ length: RING_POINTS }, (_, i) => {
    const a = (i / RING_POINTS) * Math.PI * 2
    return { x: cx + Math.cos(a) * (R - 1), y: cy + Math.sin(a) * (R - 1) }
  })
  const lights = await page.evaluate(() => window.__world.lights()?.length ?? 0)
  for (const hq of [false, true]) {
    const tier = hq ? 'full' : 'low'
    await setHQ(hq)
    await frame()
    const drawn = await photo(page)
    await hideFx(true)
    await frame()
    const hidden = await photo(page)
    const hidden2 = await photo(page)
    await hideFx(false)
    const painted = await compare(drawn, hidden, ring)
    const idle = await compare(hidden, hidden2, ring)
    const n = painted.points.filter(Boolean).length
    const hot = painted.detail.filter((p) => p.peak > FIRE_VISIBLE).length
    console.log(`  ${tier}: ${n}/${RING_POINTS} blast-radius points painted, lit (${lights} effect lights held); per point ${painted.detail.map((p) => p.peak).join(' ')}`)
    if (idle.points.some(Boolean)) fail(`${tier}: control — two photographs of the hidden frame "paint" ${idle.points.filter(Boolean).length} points`)
    if (n !== RING_POINTS) {
      const dark = painted.detail.filter((_, i) => !painted.points[i])
      fail(`${tier}: ${RING_POINTS - n} of ${RING_POINTS} points just inside the blast radius unpainted with the effect lights on — ${dark.map((p) => `(${p.x},${p.y}) peak ${p.peak}`).join('; ')}`)
    } else ok(`${tier}: the drawn blast covers its blast radius with its own light on (${n}/${RING_POINTS}, faintest peak ${Math.min(...painted.detail.map((p) => p.peak))})`)
    if (hot < FIRE_POINTS) fail(`${tier}: only ${hot}/${RING_POINTS} blast-radius points are painted by the fire (> ${FIRE_VISIBLE}; want ≥ ${FIRE_POINTS}) — the glow reaches the radius, the fireball does not`)
    else ok(`${tier}: the fireball itself reaches the radius (${hot}/${RING_POINTS} points past ${FIRE_VISIBLE})`)
    if (hq) await shot('blast-fx-quarter-full')
  }
  await setHQ(false)

  // --- it animates as it ages -----------------------------------------------------------
  // Five steps of a frame each (`SIM_DT`): a blast seen at 60 fps. Hidden first (its steps are undone by nothing, so the
  // drawn run starts a little older — both are well inside the fire's life).
  const STEPS = 5
  const animation = async (hidden) => {
    await hideFx(hidden)
    await frame()
    const first = await photo(page, band)
    let most = 0
    for (let i = 0; i < STEPS; i++) {
      await advance(k.SIM_DT)
      await frame()
      most = Math.max(most, (await comparePhotos(page, first, await photo(page, band))).fraction)
    }
    await hideFx(false)
    return { most }
  }
  const still = await animation(true)
  const living = await animation(false)
  console.log(`  aging blast, most changed of ${STEPS} one-frame age steps: drawn ${(living.most * 100).toFixed(1)}%, hidden ${(still.most * 100).toFixed(1)}%`)
  if (!(living.most > Math.max(0.01, still.most * 3))) fail(`the blast changed ${(living.most * 100).toFixed(1)}% at most as it aged, against ${(still.most * 100).toFixed(1)}% hidden — it does not animate`)
  else ok(`the blast animates as it ages (${(living.most * 100).toFixed(1)}% against ${(still.most * 100).toFixed(1)}% hidden)`)

  // --- it lingers past the flat flash ----------------------------------------------------
  const late = k.BLAST_SHADER_LIFE * 0.6
  const posed = await advance(late - quarter - 2 * STEPS * k.SIM_DT)
  await frame()
  const lOn = await photo(page)
  await hideFx(true)
  await frame()
  const lOff = await photo(page)
  await hideFx(false)
  const linger = (await compare(lOn, lOff, [], band)).fraction
  console.log(`  at ${late.toFixed(2)} s (flat flashes alive ${posed.impacts}): ${(linger * 100).toFixed(1)}% of the blast's box painted`)
  if (posed.impacts !== 0) fail(`the flash record is still alive at ${late.toFixed(2)} s — the linger below proves nothing`)
  if (!(linger > 0.02)) fail(`the blast does not linger after the flash (${(linger * 100).toFixed(1)}% of its box)`)
  else ok(`the blast lingers after the flash (${(linger * 100).toFixed(1)}% of its box painted)`)
  await shot('blast-fx-late')
  await freeze(false)
}

await hold(false)
await setHQ(false)
if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
