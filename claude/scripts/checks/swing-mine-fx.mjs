#!/usr/bin/env node
/**
 * `swing-mine-fx` — T23.18: a melee swing's arc and a placed mine are drawn by the world renderer in F's style
 * (`look/fx/game.ts::swingFx`, `mineFx`), on the pixels — they were Phaser strokes and circles (§B6: "a swing you
 * cannot see reads as damage from nowhere"; "a mine must be visible at close range") that no check photographed.
 *
 *   node scripts/checks/swing-mine-fx.mjs
 *
 * A real match (`DEV_LOADOUT`: a shovel and a mine). Each is caught in the state the ordnance layer keeps
 * (`__world.fxFeed().zones`), the scene frozen at once — a frozen scene does not age a swing — and the page as drawn is
 * compared with the same instant, effects hidden (`__world.hideLayers(['fx'])`).
 *
 * - **The swing:** `ARC_POINTS` points on the arc at its reach are painted; the arc's centre (the swinger, inside the
 *   reach) is the control — the arc is a stroke at the reach, not a disc. Both ends: the server narrated the `melee`.
 * - **The mine:** its place is painted, its tell a warning colour (red over blue by `WARN`); a patch `CONTROL_PX`
 *   away does not move. Both ends: the server's placed − ended against the layer's count.
 * - **Neither is on Phaser's canvas any more** (the flat arc and disc retired off space).
 */
import { startStack, enterBattle, standStill, selectWeapon, tally, sleep, freePort, drawnFrames } from './harness.mjs'
import { photo, comparePhotos, phaserPatch, phaserDelta } from './pixels.mjs'

const PORT = await freePort()
const { fail, ok, finish } = tally('swing-mine-fx')

const VISIBLE = 24
const ARC_POINTS = 5
const CONTROL_PX = 90
/** A warning colour: red over blue by at least this (0–255). */
const WARN = 40

const stack = await startStack({
  port: PORT,
  label: 'swing-mine-fx',
  env: { ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_LOADOUT: '1', DEV_START_HEALTH: '150', FIXED_SEED: '4242', WEATHER: 'off' },
})
// T23.25: `&hour=1` holds F1's night sky, which this check was calibrated on. Unpinned, a round opens in moonlit day
// with the moons on their arcs, and the arc's first point (the fading tail) read 23 one run and 50 the next over the
// moving sky, the other four within 4 of each other — red 2 runs in 3 at `VISIBLE` 24.
const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana', query: '&hour=1' })
await enterBattle(page, { waitPlaying: true, label: 'swing-mine-fx' })
const freeze = (on) => page.evaluate((v) => window.__game.freeze(v), on)
const hideFx = (on) => page.evaluate((v) => window.__world.hideLayers(v ? ['fx'] : []), on)
const frame = () => drawnFrames(page, 2)
const toScreen = (d, x, y) => ({ x: (x - d.worldView.x) * d.zoom, y: (y - d.worldView.y) * d.zoom })
await page.waitForFunction(() => window.__world?.litTerrain?.()?.drawn, null, { timeout: 120_000 })

// --- the swing ------------------------------------------------------------------------------
await selectWeapon(page, 'shovel')
await standStill(page)
// Aim right and a little up from the player, wherever the camera put them (T23.10: at zoom 1 the view clamps to the
// map and the player is no longer at the centre — a fixed (900, 330) aimed the arc down into the gate they stand in).
{
  const d0 = await dbg()
  const me = d0.renderPos
  await page.mouse.move((me.x - d0.worldView.x) * d0.zoom + 160, (me.y - d0.worldView.y) * d0.zoom - 40)
}
await sleep(200)
const swingsHeard = (d) => d.swings ?? d.observed?.swings ?? 0
const heard0 = swingsHeard(await dbg())
// T23.25: **the swing is measured at a known age.** A swing lives `SWING_LIFE` (0.15 s) and is drawn at `ttl / life`
// of its brightness (`fx/game.ts::swingFx`). The scene used to be frozen one round trip after the layer first held
// the swing, so its age at the photograph was whatever the box allowed: on a loaded box (3 fps) the frame that added it
// also aged it by 0.1 s, and it was caught at 8–31 % of its life in twelve tries (peaks 8 36 14 22 87 against
// `VISIBLE`, or gone before the poll saw it). So the ordnance layer's clock is held for the swing's leg — its state's
// `update` runs with dt 0, the check's instrument only, given back below — and the swing is photographed as it arrived.
await page.evaluate(() => {
  const st = window.__world.fxFeed().zones.state
  const age = st.update
  st.update = (dt) => age.call(st, 0)
  window.__swingAge = age
})
await page.evaluate(() => window.__game.fire())
let swing = null
try {
  await page.waitForFunction(() => (window.__world.fxFeed()?.zones?.state.swings.length ?? 0) > 0, null, { timeout: 5000, polling: 'raf' })
  await freeze(true)
  swing = await page.evaluate(() => {
    const s = window.__world.fxFeed().zones.state.swings.at(-1)
    return { x: s.x, y: s.y, aim: s.aim, reach: s.reach, arc: s.arc, k: s.life > 0 ? s.ttl / s.life : 0 }
  })
  console.log(`  the swing is photographed with ${(swing.k * 100).toFixed(0)} % of its life left (the layer's clock held)`)
} catch {
  fail('no swing reached the layer within 5 s of the use')
}
if (swing) {
  await frame()
  const d = await dbg()
  const heard = swingsHeard(d) - heard0
  const fx = await page.evaluate(() => window.__world.fx())
  if (!(heard > 0 && fx.worldDraws && fx.ribbons >= 1)) fail(`both ends: ${heard} melee heard, world renderer ${JSON.stringify(fx)}`)
  else ok(`both ends: the server narrated the swing; the world renderer laid out ${fx.ribbons} ribbon(s)`)
  // The arc's leading two thirds (its tail fades in, `fadePow`), at the reach.
  const arc = Array.from({ length: ARC_POINTS }, (_, i) => {
    const t = 0.35 + (0.6 * i) / (ARC_POINTS - 1)
    const a = swing.aim - swing.arc / 2 + swing.arc * t
    return toScreen(d, swing.x + Math.cos(a) * swing.reach, swing.y + Math.sin(a) * swing.reach)
  })
  const inner = [toScreen(d, swing.x + Math.cos(swing.aim) * swing.reach * 0.35, swing.y + Math.sin(swing.aim) * swing.reach * 0.35)]
  const drawn = await photo(page)
  await shot('swing-mine-fx-swing')
  const band = { x: Math.round(Math.min(...arc.map((p) => p.x)) - 10), y: Math.round(Math.min(...arc.map((p) => p.y)) - 10), w: 0, h: 0 }
  band.w = Math.round(Math.max(...arc.map((p) => p.x)) + 10 - band.x)
  band.h = Math.round(Math.max(...arc.map((p) => p.y)) + 10 - band.y)
  const onP = await phaserPatch(page, band)
  await hideFx(true)
  await frame()
  const hidden = await photo(page)
  const offP = await phaserPatch(page, band)
  await hideFx(false)
  const on = await comparePhotos(page, drawn, hidden, { points: arc, thr: VISIBLE })
  const mid = await comparePhotos(page, drawn, hidden, { points: inner, thr: VISIBLE })
  const n = on.points.filter(Boolean).length
  console.log(`  swing at ${JSON.stringify(arc[0])}…: ${n}/${arc.length} arc points painted (peaks ${on.detail.map((p) => p.peak).join(' ')}); inside the reach peak ${mid.detail[0].peak}`)
  if (n !== arc.length) fail(`${arc.length - n} of ${arc.length} points on the swing's arc unpainted — a swing you cannot see`)
  else ok(`the swing's arc is painted at its reach (${n} points)`)
  if (mid.points[0]) fail(`inside the reach moved (${mid.detail[0].peak}) — the swing is drawn as a disc, not an arc`)
  else ok(`control: inside the reach does not move (${mid.detail[0].peak})`)
  const moved = phaserDelta(onP, offP)
  if (moved > 1) fail(`Phaser's layer moved ${moved.toFixed(1)} over the swing with the effects hidden — the old arc is still drawn`)
  else ok(`the old arc is gone from Phaser's layer (${moved.toFixed(1)})`)
  await freeze(false)
}
// The layer's clock given back (T23.25): the mine below, and the swing's own fade, run on it.
await page.evaluate(() => {
  window.__world.fxFeed().zones.state.update = window.__swingAge
  delete window.__swingAge
})

// --- the mine ---------------------------------------------------------------------------------
await selectWeapon(page, 'mine')
await standStill(page)
await page.mouse.move(640, 700)
await sleep(200)
await page.evaluate(() => window.__game.fire())
let mine = null
try {
  await page.waitForFunction(() => (window.__world.fxFeed()?.zones?.state.mines.size ?? 0) > 0, null, { timeout: 8000 })
  // Past the arming time: armed, the tell blinks red (the colour the check reads is either tell's).
  await sleep(300)
  await freeze(true)
  mine = await page.evaluate(() => [...window.__world.fxFeed().zones.state.mines.values()].at(-1))
} catch {
  fail('no mine reached the layer within 8 s of placing one')
}
if (mine) {
  await frame()
  const d = await dbg()
  const expect = d.minesPlaced - d.minesEnded
  if (d.minesDrawn !== expect) fail(`both ends: server ${d.minesPlaced} − ${d.minesEnded} = ${expect}, the layer holds ${d.minesDrawn}`)
  else ok(`both ends: server ${d.minesPlaced} placed − ${d.minesEnded} ended, the layer holds ${d.minesDrawn}`)
  const at = toScreen(d, mine.x, mine.y)
  const tell = toScreen(d, mine.x, mine.y - 2)
  const ctl = { x: at.x + CONTROL_PX, y: at.y - CONTROL_PX }
  const drawn = await photo(page)
  await shot('swing-mine-fx-mine')
  const band = { x: Math.round(at.x - 12), y: Math.round(at.y - 12), w: 24, h: 24 }
  const onP = await phaserPatch(page, band)
  await hideFx(true)
  await frame()
  const hidden = await photo(page)
  const offP = await phaserPatch(page, band)
  await hideFx(false)
  const probe = await comparePhotos(page, drawn, hidden, { points: [at, tell, ctl], thr: VISIBLE })
  const [body, light, control] = probe.detail
  console.log(`  mine at ${at.x.toFixed(0)},${at.y.toFixed(0)}: body ${JSON.stringify(body.a)} vs ${JSON.stringify(body.b)}, tell ${JSON.stringify(light.a)} vs ${JSON.stringify(light.b)}, control peak ${control.peak}`)
  if (!(probe.points[0] || probe.points[1])) fail(`the mine's place is not painted (peaks ${body.peak}, ${light.peak}) — invisible instant death (§B6)`)
  else ok(`the mine is on the screen at close range (peaks ${body.peak}, ${light.peak})`)
  if (!(light.a[0] - light.a[2] > WARN)) fail(`the mine's tell is not a warning colour: ${JSON.stringify(light.a)}`)
  else ok(`the mine's tell is a warning colour (${JSON.stringify(light.a)})`)
  if (probe.points[2]) fail(`a patch ${CONTROL_PX} px away moved (${control.peak})`)
  else ok(`control: ${CONTROL_PX} px away nothing moves (${control.peak})`)
  const moved = phaserDelta(onP, offP)
  if (moved > 1) fail(`Phaser's layer moved ${moved.toFixed(1)} over the mine with the effects hidden — the old disc is still drawn`)
  else ok(`the old mine disc is gone from Phaser's layer (${moved.toFixed(1)})`)
  await freeze(false)
}

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
