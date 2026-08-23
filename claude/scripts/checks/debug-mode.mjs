#!/usr/bin/env node
/**
 * T14.07 / §C12 — debug mode is off in a normal game, and `F1` turns it on.
 *
 *   node scripts/checks/debug-mode.mjs
 *   node scripts/e2e.mjs debug-mode
 *
 * ## Sampled from the frame, with a control
 *
 * §C12's claim is about what a player *sees*: the aim ring and the overlays are
 * gone in normal play and the crosshair stays. Both halves are pixels, so both
 * are sampled — the ring's own annulus, and the crosshair's centre — and the
 * control is the same two patches with debug mode on. A check that only asserted
 * "the flag is false" would pass for a build that draws the ring anyway.
 */
import { samplePatch } from './pixels.mjs'
import { startStack, enterBattle, tally, sleep, standStill } from './harness.mjs'

const PORT = 3127
const { fail, ok, finish } = tally('debug-mode')

const stack = await startStack({
  port: PORT,
  label: 'debug-mode',
  env: { ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_LOADOUT: '1' },
})
const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'debug-mode' })
await standStill(page)

const k = await page.evaluate(() => window.__game.constants())

/**
 * Two patches on the player: the crosshair's own square, and a slice of the aim
 * ring's annulus well away from it.
 *
 * Both are computed from the **camera**, so they land on the player wherever the
 * camera happens to have clamped — a fixed screen point is a fixture that expires
 * the moment the map changes, which is how four of these checks broke this week.
 */
const patches = async () => {
  // Waited for, not read once: `player` comes from the core's own state and
  // `worldView` from the camera, and either can still be undefined a beat after
  // the round starts. Reading them early produced a rect at (NaN, NaN), which is
  // a guard firing on the harness rather than on the game.
  await page.waitForFunction(
    () => {
      const d = window.__game?.debug?.()
      const v = d?.worldView
      // `GameScene` spells it `width`/`height`; `SandboxScene` spells it `w`/`h`.
      // Reading only one of them is an assertion that cannot succeed (§B15) —
      // this waited fifteen seconds for `w > 0` on a field called `width`.
      return Boolean(d?.player && v && (v.width ?? v.w ?? 0) > 0)
    },
    null,
    { timeout: 15_000 },
  )
  const g = await page.evaluate(() => {
    const d = window.__game.debug()
    const raw = d.worldView
    const v = { x: raw.x, y: raw.y, w: raw.width ?? raw.w, h: raw.height ?? raw.h }
    const cv = document.querySelector('canvas')
    const r = cv.getBoundingClientRect()
    const sx = (wx) => r.left + ((wx - v.x) / v.w) * r.width
    const sy = (wy) => r.top + ((wy - v.y) / v.h) * r.height
    return { px: d.player.x, py: d.player.y, sx: sx(d.player.x), sy: sy(d.player.y), scale: r.width / v.w }
  })
  // Pick a point **on the ring, over open air**, and sample there.
  //
  // Two fixed choices were tried and both are assumptions about the terrain:
  // straight up runs off the top of the frame when the camera is clamped, and
  // straight down is inside the ground the player is standing on — where both
  // frames are rock and the digests match whether the ring was drawn or not.
  // The ring is a circle; ask which part of it is against sky.
  const spot = await page.evaluate(
    ([radius, w, h]) => {
      const d = window.__game.debug()
      const raw = d.worldView
      const v = { x: raw.x, y: raw.y, w: raw.width ?? raw.w, h: raw.height ?? raw.h }
      const cv = document.querySelector('canvas')
      const r = cv.getBoundingClientRect()
      const core = window.__game.core
      const sx = (wx) => r.left + ((wx - v.x) / v.w) * r.width
      const sy = (wy) => r.top + ((wy - v.y) / v.h) * r.height
      // Left and right first: at ring radius those are level with the player and
      // are open air whenever they can walk, which is now guaranteed by the spawn
      // rule. Then the diagonals, then straight up.
      const angles = [Math.PI, 0, -Math.PI * 0.75, -Math.PI * 0.25, -Math.PI / 2]
      for (const a of angles) {
        const wx = d.player.x + Math.cos(a) * radius
        const wy = d.player.y + Math.sin(a) * radius
        // The whole patch over air, sampled at its corners in world space.
        const half = (radius * 0.12) | 0
        let air = true
        for (const dx of [-half, half]) {
          for (const dy of [-half, half]) {
            if (core.solidAt(Math.round(wx + dx), Math.round(wy + dy))) air = false
          }
        }
        if (!air) continue
        const px = sx(wx)
        const py = sy(wy)
        if (px - w / 2 < 0 || py - h / 2 < 0) continue
        if (px + w / 2 > window.innerWidth || py + h / 2 > window.innerHeight) continue
        return { x: Math.round(px - w / 2), y: Math.round(py - h / 2), w, h }
      }
      return null
    },
    [k.AIM_RADIUS, 16, 16],
  )
  const body = { x: Math.round(g.sx - 7), y: Math.round(g.sy - 7), w: 14, h: 14 }
  return { ring: spot, body, view: g }
}

/** Every rect has to be on the frame, or nothing below measures anything. */
const onFrame = async (r) =>
  page.evaluate(
    (rect) =>
      rect.x >= 0 &&
      rect.y >= 0 &&
      rect.x + rect.w <= window.innerWidth &&
      rect.y + rect.h <= window.innerHeight,
    r,
  )

const rects = await patches()
if (!rects.ring) {
  fail('no point on the aim ring is over open air and on the frame — nothing below measures anything')
  await finish(() => stack.close())
}
for (const [name, r] of [
  ['ring', rects.ring],
  ['body', rects.body],
]) {
  if (!(await onFrame(r))) {
    fail(`the ${name} patch (${r.x}, ${r.y}) is off the frame — nothing below measures anything`)
    await finish(() => stack.close())
  }
}

// --- normal play: no ring, no overlays, no counter --------------------------
const off = await dbg()
if (off.debugMode?.on) {
  fail('debug mode is on before anything asked for it — §C12 says off by default')
} else {
  ok('control: debug mode is off at the start')
}
if (off.debugMode?.overlays) fail('the T3.11 overlays are on with debug mode off')
else ok('and the overlays are off with it')

const ringOff = await samplePatch(page, rects.ring)
const bodyOff = await samplePatch(page, rects.body)
const fpsShown = () =>
  page.evaluate(() => {
    const el = document.getElementById('debug-fps')
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.width > 1 && r.height > 1
  })
if (await fpsShown()) fail('the FPS counter is on the screen in normal play')
else ok('and the FPS counter is not on the screen')
await shot('debug-off')

// --- F1 turns it on, and the ring appears -----------------------------------
await page.keyboard.press('F1')
await sleep(400)
const on = await dbg()
if (!on.debugMode?.on) {
  fail('F1 did not turn debug mode on')
} else {
  ok('F1 turns it on')
  if (!on.debugMode.overlays) fail('debug mode is on but the overlays are not — §C12 folds them in')
  else ok('and the overlays come with it, from the same toggle')

  const ringOn = await samplePatch(page, rects.ring)
  const bodyOn = await samplePatch(page, rects.body)
  const ringMoved = ringOn.digest !== ringOff.digest
  const bodyMoved = bodyOn.digest !== bodyOff.digest
  if (ringMoved) {
    ok(`the aim ring's own patch changed when debug mode came on (lum ${ringOff.lum.toFixed(1)} → ${ringOn.lum.toFixed(1)})`)
  } else {
    fail('debug mode is on and the aim ring is still not drawn')
  }
  // The control: something that is drawn in both modes. If it moved too, the
  // whole frame moved and the reading above is about the camera, not the ring.
  if (!bodyMoved) {
    ok('control: the player patch is unchanged, so the difference is the ring')
  } else {
    fail('the control patch moved too — the frame shifted and the ring reading proves nothing')
  }

  if (await fpsShown()) ok(`the FPS counter is on the screen, reading ${on.debugMode.fps.toFixed(0)}`)
  else fail('debug mode is on and the FPS counter is not drawn')

  // Measured from real frame deltas, so it must be a plausible frame rate rather
  // than 0 or a smoothed engine figure that lags a stall (§A38).
  if (on.debugMode.fps > 5 && on.debugMode.fps < 250) {
    ok(`and it reads a plausible rate (${on.debugMode.fps.toFixed(1)} fps)`)
  } else {
    fail(`the FPS counter reads ${on.debugMode.fps} — that is not a frame rate`)
  }
  await shot('debug-on')
}

// --- it must not change the simulation --------------------------------------
//
// The same fixed input sequence with it on and with it off. A debug mode that
// changed physics would be a debug mode you cannot debug with.
/**
 * Hold one direction and report the walking speed it reaches.
 *
 * The two runs go **opposite ways**, and that is not cosmetic: the first run
 * moves the player, and on this map that can be into a wall — measured as 48 px
 * and then 0 px, with the check reporting a terrain feature as a simulation
 * difference. Whichever way you have just come from has room in it.
 */
const runInputs = async (key) => {
  await standStill(page)
  const start = (await dbg()).player
  await page.keyboard.down(key)
  // The **peak** speed reached during the hold, not the speed at the end of it.
  //
  // Distance was tried first and is the wrong measure entirely: the two runs
  // start in different places, so on any ground that is not flat they cover
  // different distances for terrain reasons — 114 px and 49 px, reported as
  // "debug mode is changing the simulation". `WALK_SPEED` is a property of the
  // simulation and is the same on a slope.
  //
  // But the speed *at the end* is not that either: walk into a wall three
  // hundred milliseconds in and the reading is 0 for a run that walked perfectly
  // well. The peak is what the player reached before the terrain intervened.
  let peak = 0
  for (let i = 0; i < 10; i++) {
    await sleep(70)
    peak = Math.max(peak, Math.abs((await dbg()).player?.vx ?? 0))
  }
  await page.keyboard.up(key)
  await sleep(400)
  const end = (await dbg()).player
  return { vx: peak, dx: end.x - start.x }
}
const withDebug = await runInputs('d')
await page.keyboard.press('F1')
await sleep(300)
if ((await dbg()).debugMode?.on) fail('a second F1 did not turn it off')
else ok('a second F1 turns it off')
const withoutDebug = await runInputs('a')

// Loose, because the ground is not flat and the two runs start in different
// places — but a *simulation* difference would be a different order of
// magnitude, not a few pixels of slope.
// The control: **both** runs have to have actually walked. Without it "0 vs 0"
// is a pass, and a player wedged against terrain would certify that debug mode
// changes nothing by changing nothing about anything.
//
// On the **speed**, not the distance, because speed is what is compared. A run
// that reached `WALK_SPEED` and then met a ledge has travelled 10 px and is a
// perfectly good sample of how fast walking is; asking it to have covered ground
// as well fails on terrain, which is the thing this whole check is trying not to
// measure.
const walk = k.WALK_SPEED
if (withDebug.vx < walk * 0.5 || withoutDebug.vx < walk * 0.5) {
  fail(
    `the player never got walking in one of the two runs (${withDebug.vx.toFixed(0)} px/s, ` +
      `${withoutDebug.vx.toFixed(0)} px/s against WALK_SPEED ${walk}) — it is boxed in, ` +
      'so the comparison is vacuous',
  )
} else {
  const drift = Math.abs(withDebug.vx - withoutDebug.vx)
  // Pinned to the shipped constant (§A19), and to each other. A tenth of
  // `WALK_SPEED` is far tighter than any simulation difference would be and far
  // looser than the sampling jitter between two browser reads.
  if (drift < walk * 0.1) {
    ok(
      `the same input produced the same speed (${withDebug.vx.toFixed(0)} vs ` +
        `${withoutDebug.vx.toFixed(0)} px/s, WALK_SPEED ${walk})`,
    )
  } else {
    fail(
      `walking reached ${withDebug.vx.toFixed(0)} px/s with debug on and ` +
        `${withoutDebug.vx.toFixed(0)} px/s with it off — debug mode is changing the simulation`,
    )
  }
}

// --- and the flag is written where a scene change will find it -------------
//
// Not a page reload: that drops the socket and the seat, and it tests the
// browser rather than the game. §C12's claim is about a *scene* change, which
// rebuilds every DOM-owning object and re-reads this — `initialEnabled` is
// unit-tested against exactly this value.
await page.keyboard.press('F1')
await sleep(250)
const persisted = await page.evaluate(() => sessionStorage.getItem('debug-mode'))
if (!(await dbg()).debugMode?.on) {
  fail('could not turn it back on to check what it persists')
} else if (persisted !== '1') {
  fail(`debug mode is on and sessionStorage holds "${persisted}" — a new scene would come up off`)
} else {
  ok('the flag is written to sessionStorage, so a new scene comes up with it on')
  await page.keyboard.press('F1')
  await sleep(250)
  const off2 = await page.evaluate(() => sessionStorage.getItem('debug-mode'))
  if (off2 !== '0') fail(`turning it off left "${off2}" behind`)
  else ok('and turning it off is persisted too')
}

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
