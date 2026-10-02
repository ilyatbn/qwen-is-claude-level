/**
 * `fireflies` — T23.24: **small black bugs with a shine, at night only, never in space.**
 *
 * Sandbox, seed 4242, low tier (R20). Every comparison is one frozen frame (`freeze`: the scene's clock stops, and the
 * fireflies with it) read twice — as drawn, and with only the fireflies hidden (`__world.hideLayers(['fireflies'])`).
 *
 * - **Night (presence):** the renderer seeded a swarm on this map and laid some out in view (`__world.fireflies()`).
 *   At each one drawn on screen, a patch around it differs between the two reads — at least `PRESENT_MIN` of them by
 *   more than `MOVED` on some channel. **What the bug is:** across those patches some pixels go **darker** with the
 *   layer on (the ink body) and some **brighter** (the glint) — at least `INK_MIN` and `GLINT_MIN` fireflies of each.
 *   **Control region:** patches at least `CLEAR` px from every drawn firefly move by at most `CONTROL_MAX`.
 * - **Still when frozen, moving when not:** two reads of the frozen frame match; unfrozen, the drawn positions move.
 * - **Day (absence):** at noon the fade is 0, nothing is laid out, and the whole frame with the layer hidden is the
 *   frame without (max channel change ≤ `CONTROL_MAX`) — the night leg above is its presence control.
 * - **Space (absence):** on `?gravity=space` no swarm is seeded at night, and hiding the layer changes nothing.
 *
 * Shots: `fireflies-night`, `fireflies-night-hidden`, `fireflies-day`, `fireflies-space`.
 */
import { patchRGBA, toScreen } from './pixels.mjs'

/** Night and noon (`setTime`, s into the sandbox's cycle — `night-view`'s). */
const NIGHT_T = 90
const NOON_T = 0
/** A pixel "moved" past this per channel (0–255). */
const MOVED = 6
/** Half the patch around a firefly, CSS px (its quad is 12 world px each way; the low tier halves it in buffer px). */
const HALF = 7
/** Share of the on-screen fireflies whose patch must change (a firefly may sit under the HUD or the night's dark). */
const PRESENT_MIN = 0.5
/** Fireflies whose patch has an ink pixel (darker by `MOVED`) / a glint pixel (brighter by `MOVED`). */
const INK_MIN = 2
const GLINT_MIN = 2
/** Control patches sit this far (CSS px) from every drawn firefly; they may move at most `CONTROL_MAX` per channel. */
const CLEAR = 40
const CONTROL_MAX = 1

async function onScreen(page, positions) {
  const out = []
  for (const [x, y] of positions) {
    const s = await toScreen(page, x, y)
    if (s.onScreen && s.x > HALF && s.y > HALF && s.x < 1280 - HALF && s.y < 720 - HALF) out.push({ x: Math.round(s.x), y: Math.round(s.y) })
  }
  return out
}

const rect = (p) => ({ x: p.x - HALF, y: p.y - HALF, w: HALF * 2, h: HALF * 2 })

/** Per-pixel compare of two RGBA patches: darker / brighter counts past `MOVED`, and the largest channel change. */
function diff(a, b) {
  let darker = 0
  let brighter = 0
  let max = 0
  for (let i = 0; i < a.length; i += 4) {
    let lo = 0
    let hi = 0
    for (let c = 0; c < 3; c++) {
      const d = a[i + c] - b[i + c]
      lo = Math.min(lo, d)
      hi = Math.max(hi, d)
      max = Math.max(max, Math.abs(d))
    }
    if (lo < -MOVED) darker++
    if (hi > MOVED) brighter++
  }
  return { darker, brighter, max }
}

async function read(page, rects) {
  const out = []
  for (const r of rects) out.push((await patchRGBA(page, r)).rgba)
  return out
}

async function hidden(page, on) {
  await page.evaluate((v) => window.__world.hideLayers(v ? ['fireflies'] : []), on)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}

/** A grid of control patches clear of every firefly. */
function controls(spots) {
  const out = []
  for (let y = 60; y < 680; y += 80) {
    for (let x = 60; x < 1240; x += 120) if (spots.every((s) => Math.hypot(s.x - x, s.y - y) > CLEAR)) out.push({ x, y })
  }
  return out
}

/** The whole frame with and without the layer: the largest channel change anywhere (one patch, the frame). */
async function wholeFrame(page) {
  const all = { x: 0, y: 0, w: 1280, h: 720 }
  const [on] = await read(page, [all])
  await hidden(page, true)
  const [off] = await read(page, [all])
  await hidden(page, false)
  return diff(on, off).max
}

export default async function ({ page, shot, log }) {
  const problems = []
  await page.waitForFunction(() => window.__game && window.__world && window.__world.litTerrain()?.drawn, null, { timeout: 120_000 })
  await page.evaluate(() => window.__game.setHighQuality(false))
  await page.waitForFunction(() => window.__world.info().tier === 'low' && window.__world.litTerrain()?.drawn && !window.__game.debug().terrainSwapPending, null, { timeout: 60_000 })

  // ------------------------------------------------------------------ night: present, ink and glint
  await page.evaluate((t) => window.__game.setTime(t), NIGHT_T)
  await page.waitForTimeout(600)
  await page.evaluate(() => window.__game.freeze(true))
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  const night = await page.evaluate(() => window.__world.fireflies())
  log(`night: ${night?.seeded} seeded on the map, ${night?.drawn} laid out in view, fade ${night?.fade}`)
  if (!night || !(night.seeded > 0) || !(night.drawn > 0) || night.fade !== 1) problems.push(`at night: ${JSON.stringify(night && { ...night, positions: night.positions.length })}`)
  const spots = await onScreen(page, night?.positions ?? [])
  const ctl = controls(spots)
  const onA = await read(page, [...spots.map(rect), ...ctl.map(rect)])
  const onB = await read(page, [...spots.map(rect), ...ctl.map(rect)])
  await shot('fireflies-night')
  await hidden(page, true)
  const off = await read(page, [...spots.map(rect), ...ctl.map(rect)])
  await shot('fireflies-night-hidden')
  await hidden(page, false)

  let present = 0
  let ink = 0
  let glint = 0
  spots.forEach((_, k) => {
    const d = diff(onA[k], off[k])
    if (d.max > MOVED) present++
    if (d.darker > 0) ink++
    if (d.brighter > 0) glint++
  })
  log(`night: ${spots.length} on screen — ${present} patches changed by > ${MOVED} (min ${Math.ceil(spots.length * PRESENT_MIN)}), ${ink} with ink (min ${INK_MIN}), ${glint} with a glint (min ${GLINT_MIN})`)
  if (spots.length === 0) problems.push('no firefly on screen at night')
  if (present < spots.length * PRESENT_MIN) problems.push(`only ${present} of ${spots.length} fireflies change their patch`)
  if (ink < INK_MIN) problems.push(`only ${ink} fireflies show an ink body (darker pixels)`)
  if (glint < GLINT_MIN) problems.push(`only ${glint} fireflies show a glint (brighter pixels)`)
  let ctlMax = 0
  ctl.forEach((_, k) => (ctlMax = Math.max(ctlMax, diff(onA[spots.length + k], off[spots.length + k]).max)))
  log(`night control: ${ctl.length} patches ≥ ${CLEAR} px from every firefly moved by at most ${ctlMax} (max ${CONTROL_MAX})`)
  if (ctl.length < 10) problems.push(`only ${ctl.length} control patches`)
  if (ctlMax > CONTROL_MAX) problems.push(`hiding the fireflies changed the frame ${ctlMax} away from every firefly`)
  let frozenMax = 0
  onA.forEach((a, k) => (frozenMax = Math.max(frozenMax, diff(a, onB[k]).max)))
  log(`frozen: two reads differ by at most ${frozenMax}`)
  if (frozenMax > CONTROL_MAX) problems.push(`a frozen frame's fireflies moved (${frozenMax})`)

  await page.evaluate(() => window.__game.freeze(false))
  await page.waitForTimeout(700)
  const later = await page.evaluate(() => window.__world.fireflies())
  const n = Math.min(later?.positions.length ?? 0, night?.positions.length ?? 0)
  let moved = 0
  for (let k = 0; k < n; k++) if (Math.hypot(later.positions[k][0] - night.positions[k][0], later.positions[k][1] - night.positions[k][1]) > 1) moved++
  log(`unfrozen 0.7 s: ${moved} of ${n} moved, clock ${night?.clock.toFixed(2)} → ${later?.clock.toFixed(2)}`)
  if (!(n > 0 && moved >= n / 2)) problems.push(`unfrozen, only ${moved} of ${n} fireflies moved`)

  // ------------------------------------------------------------------ day: absent
  await page.evaluate((t) => window.__game.setTime(t), NOON_T)
  await page.waitForTimeout(600)
  await page.evaluate(() => window.__game.freeze(true))
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  const day = await page.evaluate(() => window.__world.fireflies())
  const dayMax = await wholeFrame(page)
  log(`day: seeded ${day?.seeded}, laid out ${day?.drawn}, fade ${day?.fade}; hiding the layer moves the frame by at most ${dayMax} (max ${CONTROL_MAX})`)
  if (!day || day.fade !== 0 || day.drawn !== 0) problems.push(`by day: ${JSON.stringify(day && { ...day, positions: day.positions.length })}`)
  if (dayMax > CONTROL_MAX) problems.push(`by day hiding the fireflies changed the frame by ${dayMax}`)
  await shot('fireflies-day')
  await page.evaluate(() => window.__game.freeze(false))

  // ------------------------------------------------------------------ space: absent at night
  const base = new URL(page.url())
  // The harness's own parameters kept (`e2e=1` and the rest), only the gravity added: it decides the generator.
  base.searchParams.set('gravity', 'space')
  await page.goto(base.href, { waitUntil: 'load' })
  await page.waitForFunction(() => !!window.__game && !!window.__world && window.__game.core?.meta?.generator === 'Space', null, { timeout: 120_000 })
  await page.waitForTimeout(1000)
  await page.evaluate((t) => window.__game.setTime(t), NIGHT_T)
  await page.waitForTimeout(600)
  await page.evaluate(() => window.__game.freeze(true))
  const space = await page.evaluate(() => window.__world.fireflies())
  const spaceMax = await wholeFrame(page)
  log(`space at night: seeded ${space?.seeded}, laid out ${space?.drawn}; hiding the layer moves the frame by at most ${spaceMax}`)
  if (!space || space.seeded !== 0 || space.drawn !== 0) problems.push(`in space: ${JSON.stringify(space && { ...space, positions: space.positions.length })}`)
  if (spaceMax > CONTROL_MAX) problems.push(`in space hiding the fireflies changed the frame by ${spaceMax}`)
  await shot('fireflies-space')
  await page.evaluate(() => window.__game.freeze(false))
  await page.evaluate(() => window.__game.setTime(null))

  if (problems.length) throw new Error(`fireflies: ${problems.join('; ')}`)
}
