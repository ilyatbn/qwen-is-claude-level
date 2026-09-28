#!/usr/bin/env node
/**
 * `beams-fx` — T23.18: a laser beam is F1's (`ribbon([l0, l1], 6, [1.2, 3.4, 3.6], [0.05, 0.5, 0.7])` and its impact
 * glow — `look/fx/game.ts::beamFx`), drawn by the world renderer on both tiers. It replaces `beams-shader` (T21.18's
 * Phaser beam quad and the flat strokes, retired with it off space, R13/R15).
 *
 *   node scripts/checks/beams-fx.mjs
 *
 * A real laser pistol on a real server; the beam held (`holdTracers`), the scene frozen. Every photograph is the page
 * as drawn against the same instant with only the effects hidden (`__world.hideLayers(['fx'])`), the lights on.
 *
 * - **Both ends:** the server narrated a hitscan; the ordnance layer holds the beam; the world renderer laid it out.
 * - **Painted along its length, both tiers:** `ALONG` points on the middle of the segment (clear of the muzzle and the
 *   impact glows) move past `VISIBLE`; control points `OFFSET` px to the side do not move.
 * - **It is the laser's colour:** `EDGE` px off the axis — in the glow, off the white-hot core — the gain in blue and green
 *   exceeds the gain in red (F1's teal; the old flat stroke was orange).
 * - **The old art is gone:** Phaser's layer does not move with the effects hidden.
 *
 * The muzzle glow lives for the effect lights' `MUZZLE_FRAMES` lists; the scene is frozen only after it has passed (a
 * frozen scene builds no new list and would hold it).
 */
import { startStack, enterBattle, standStill, selectWeapon, tally, sleep, freePort, drawnFrames } from './harness.mjs'
import { photo, comparePhotos, phaserPatch, phaserDelta } from './pixels.mjs'
// T23.11: the sky follows the hour now (the palettes' blend, the moons on their arcs); this check was calibrated on
// F1's look with nothing in the sky moving, so it pins that hour (`worldRenderer-math.ts::hourFromUrl`).
const HOUR = '&hour=1'

const PORT = await freePort()
const { fail, ok, finish } = tally('beams-fx')

/** A point counts as painted when some channel moved by more than this. */
const VISIBLE = 24
const ALONG = 8
/** The beam's middle: from this share of its length to `1 - MIDDLE`. */
const MIDDLE = 0.3
/** Screen px off the axis for the colour points: in the teal glow, off the core. */
const EDGE = 3
/**
 * The shortest beam worth photographing: the muzzle and impact glows (world px sprites) must leave a middle. Set as
 * 220 screen px at zoom 2 — T23.10 restates it in world px (110), so at zoom 1 it is 110 screen px, not 220.
 */
const MIN_LEN_WORLD = 110
/**
 * Screen px either side of the beam for the control points: past the ribbon (6 world px) **and its bloom** — measured,
 * 40 px out the HDR core's bloom still moved the frame 38–49 on both tiers (F1's laser blooms as widely).
 */
const OFFSET = 90

const stack = await startStack({
  port: PORT,
  label: 'beams-fx',
  env: { ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_LOADOUT: '1', FIXED_SEED: '4242', WEATHER: 'off' },
})
const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana', query: HOUR })
await enterBattle(page, { waitPlaying: true, label: 'beams-fx' })

const setHQ = (on) => page.evaluate((v) => window.__game.setHighQuality(v), on)
const freeze = (on) => page.evaluate((v) => window.__game.freeze(v), on)
const hideFx = (on) => page.evaluate((v) => window.__world.hideLayers(v ? ['fx'] : []), on)
const hold = (on) => page.evaluate((v) => window.__game.holdTracers(v), on)
const frame = () => drawnFrames(page, 2)

await selectWeapon(page, 'laser_pistol')
await standStill(page)
await setHQ(false)
await page.waitForFunction(() => window.__world?.litTerrain?.()?.drawn, null, { timeout: 120_000 })
const aim = await page.evaluate(() => {
  const d = window.__game.debug()
  const v = d.worldView
  const r = document.querySelector('canvas').getBoundingClientRect()
  const wx = Math.min(d.player.x + 300, v.x + v.width - 60)
  const wy = Math.max(d.player.y - 40, v.y + 60)
  return { x: r.left + ((wx - v.x) / v.width) * r.width, y: r.top + ((wy - v.y) / v.height) * r.height }
})
await page.mouse.move(aim.x, aim.y)
await sleep(150)

const narrated0 = (await dbg()).observed?.hitscans ?? 0
await hold(true)
let beam = null
// T23.10: each shot at another angle up from the player (the zoom-2 aim, clamped to a 640-wide view, happened to find
// open air; at zoom 1 the same world direction ran into rock short of `MIN_LEN_WORLD`).
const ANGLES = [-0.13, -0.3, 0, -0.5, 0.15, -0.7, -0.2, -0.4, 0.08, -0.6]
for (let shotN = 0; shotN < 10 && !beam; shotN++) {
  const to = await page.evaluate((ang) => {
    const d = window.__game.debug()
    const v = d.worldView
    const r = document.querySelector('canvas').getBoundingClientRect()
    const wx = d.player.x + Math.cos(ang) * 300
    const wy = d.player.y + Math.sin(ang) * 300
    return { x: r.left + ((wx - v.x) / v.width) * r.width, y: r.top + ((wy - v.y) / v.height) * r.height }
  }, ANGLES[shotN])
  await page.mouse.move(to.x, to.y)
  await sleep(150)
  await page.evaluate(() => window.__game.fire())
  try {
    await page.waitForFunction(() => (window.__world.fxFeed()?.ordnance?.state.tracers.length ?? 0) > 0, null, { timeout: 3000 })
    await drawnFrames(page, 4)
    await freeze(true)
    await frame()
    beam = await page.evaluate(() => {
      const t = window.__world.fxFeed().ordnance.state.tracers.at(-1)
      const d = window.__game.debug()
      const s = (x, y) => ({ x: (x - d.worldView.x) * d.zoom, y: (y - d.worldView.y) * d.zoom })
      return { a: s(t.x0, t.y0), b: s(t.x1, t.y1), len: Math.hypot(t.x1 - t.x0, t.y1 - t.y0) * d.zoom, zoom: d.zoom }
    })
    // T23.10: measured on the part of it inside the canvas, clear of its edges — at zoom 1 a beam runs off the frame
    // (its far point, 20 px from the top edge, read 7): the beam is clipped to the inset frame first.
    {
      const M = 40
      const dx = beam.b.x - beam.a.x
      const dy = beam.b.y - beam.a.y
      let t1 = 1
      for (const [v, d, lo, hi] of [[beam.a.x, dx, M, 1280 - M], [beam.a.y, dy, M, 720 - M]]) {
        if (d > 0) t1 = Math.min(t1, (hi - v) / d)
        else if (d < 0) t1 = Math.min(t1, (lo - v) / d)
      }
      t1 = Math.max(0, t1)
      if (t1 < 1) {
        beam.b = { x: beam.a.x + dx * t1, y: beam.a.y + dy * t1 }
        beam.len *= t1
      }
    }
    if (!(beam.len > MIN_LEN_WORLD * beam.zoom)) {
      await freeze(false)
      beam = null
      await page.evaluate(() => window.__game.holdTracers(false))
      await sleep(400)
      await hold(true)
    }
  } catch {
    /* no beam this shot */
  }
}

if (!beam) fail(`no beam longer than ${MIN_LEN_WORLD} world px could be held on screen after ten shots`)
else {
  const narrated = ((await dbg()).observed?.hitscans ?? 0) - narrated0
  const fx = await page.evaluate(() => window.__world.fx())
  if (!(narrated > 0 && fx.worldDraws && fx.ribbons >= 1 && fx.soft >= 1)) fail(`both ends: narrated ${narrated} hitscan(s), world renderer ${JSON.stringify(fx)}`)
  else ok(`both ends: ${narrated} hitscan(s) narrated; the world renderer laid out ${fx.ribbons} ribbon(s) and ${fx.soft} glow(s)`)
  const { a, b: end, len: full } = beam
  // The part of the beam on screen: a shot that leaves the frame is measured on the stretch the camera shows.
  const tOut = Math.min(1, ...[end.x > 1270 ? (1270 - a.x) / (end.x - a.x) : 1, end.x < 10 ? (10 - a.x) / (end.x - a.x) : 1, end.y < 10 ? (10 - a.y) / (end.y - a.y) : 1, end.y > 590 ? (590 - a.y) / (end.y - a.y) : 1])
  const b = { x: a.x + (end.x - a.x) * tOut, y: a.y + (end.y - a.y) * tOut }
  const len = full * tOut
  const ux = (b.x - a.x) / len
  const uy = (b.y - a.y) / len
  const along = Array.from({ length: ALONG }, (_, i) => {
    const t = MIDDLE + ((1 - 2 * MIDDLE) * i) / (ALONG - 1)
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
  })
  const side = along.map((p, i) => ({ x: p.x - uy * OFFSET * (i % 2 ? 1 : -1), y: p.y + ux * OFFSET * (i % 2 ? 1 : -1) }))
  const edge = along.map((p, i) => ({ x: p.x - uy * EDGE * (i % 2 ? 1 : -1), y: p.y + ux * EDGE * (i % 2 ? 1 : -1) }))
  const inFrame = (p) => p.x > 2 && p.x < 1278 && p.y > 2 && p.y < 600
  const pts = along.filter(inFrame)
  const ctl = side.filter(inFrame)
  const rim = edge.filter(inFrame)
  console.log(`  beam ${a.x.toFixed(0)},${a.y.toFixed(0)} → ${b.x.toFixed(0)},${b.y.toFixed(0)} (${len.toFixed(0)} px); ${pts.length} points on it, ${ctl.length} beside it`)
  const band = { x: Math.round(Math.min(a.x, b.x)), y: Math.round(Math.min(a.y, b.y) - 20), w: Math.round(Math.abs(b.x - a.x)) + 1, h: Math.round(Math.abs(b.y - a.y)) + 40 }

  const onP = await phaserPatch(page, band)
  await hideFx(true)
  await frame()
  const offP = await phaserPatch(page, band)
  await hideFx(false)
  const moved = phaserDelta(onP, offP)
  if (moved > 1) fail(`Phaser's layer changed ${moved.toFixed(1)} with the effects hidden — the beam is still drawn there`)
  else ok(`the old beam is gone: Phaser's layer does not move with the effects (${moved.toFixed(1)})`)

  for (const hq of [false, true]) {
    const tier = hq ? 'full' : 'low'
    await setHQ(hq)
    await frame()
    const drawn = await photo(page)
    await shot(`beams-fx-${tier}`)
    await hideFx(true)
    await frame()
    const hidden = await photo(page)
    await hideFx(false)
    const on = await comparePhotos(page, drawn, hidden, { points: pts, thr: VISIBLE })
    const off = await comparePhotos(page, drawn, hidden, { points: ctl, thr: VISIBLE })
    const glow = await comparePhotos(page, drawn, hidden, { points: rim, thr: VISIBLE })
    const n = on.points.filter(Boolean).length
    const m = off.points.filter(Boolean).length
    const gain = glow.detail.reduce((s, p) => ({ r: s.r + p.a[0] - p.b[0], g: s.g + p.a[1] - p.b[1], b: s.b + p.a[2] - p.b[2] }), { r: 0, g: 0, b: 0 })
    console.log(`  ${tier}: ${n}/${pts.length} points on the beam painted (peaks ${on.detail.map((p) => p.peak).join(' ')}), ${m}/${ctl.length} beside it (peaks ${off.detail.map((p) => p.peak).join(' ')}); gain ${EDGE} px off the axis r ${(gain.r / rim.length).toFixed(0)} g ${(gain.g / rim.length).toFixed(0)} b ${(gain.b / rim.length).toFixed(0)}`)
    if (n !== pts.length) fail(`${tier}: ${pts.length - n} of ${pts.length} points along the beam unpainted`)
    else ok(`${tier}: the beam is painted along its whole length (${n} points)`)
    if (m > 0) fail(`${tier}: ${m} control points ${OFFSET} px beside the beam moved — the drawing is not a beam`)
    else ok(`${tier}: control — nothing moves ${OFFSET} px beside it`)
    if (!(gain.g > gain.r && gain.b > gain.r)) fail(`${tier}: the beam gained r ${gain.r}, g ${gain.g}, b ${gain.b} — not the laser's teal`)
    else ok(`${tier}: the beam is the laser's colour (green and blue gain over red)`)
  }
  await setHQ(false)
  await freeze(false)
}

await hold(false)
if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
