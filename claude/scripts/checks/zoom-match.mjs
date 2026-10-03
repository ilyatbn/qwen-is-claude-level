#!/usr/bin/env node
/**
 * `zoom-match` — T23.10C F4: **the zoom, in a real match, at both ends and on pixels.** T23.10 (R6) took the camera
 * from zoom 2 to `CAMERA_ZOOM` 1: four times the map on screen. Until this check every test of it was arithmetic on the
 * constant (`the_view_shows_four_times_the_zoom_2_area`); nothing read what a match's camera shows.
 *
 * Two humans on a `DEV_PROBE=1` server, by day (a round opens by day, so the night seeing rule hides nobody):
 *
 * 1. **The scene's end.** `debug().zoom` is `CAMERA_ZOOM`, and the camera's `worldView` is the canvas over that zoom —
 *    an area at least four times the zoom-2 view's (`ZOOM_BEFORE`, the value T23.10 retired: the basis of "four times").
 * 2. **The picture's end.** bo stands on the ground `REACH` of ana's half-view from the camera's centre — beyond the
 *    zoom-2 view's half-width, so a zoom-2 camera could not show him — and his box on ana's screen changes when he
 *    leaves (`debugPlace` far away); a box the same size across the camera's centre, with nobody in it, does not.
 *
 *   node scripts/checks/zoom-match.mjs
 */
import { startStack, enterBattle, freePort, tally, sleep, drawnFrames } from './harness.mjs'
import { photo, comparePhotos, toScreen } from './pixels.mjs'

const { fail, ok, finish } = tally('zoom-match')
/** The zoom T23.10 (R6) retired — the basis of "four times the map on screen", not a tunable. */
const ZOOM_BEFORE = 2
/** bo's distance from the camera's centre, as a share of the view's half-width: well past the zoom-2 half-view. */
const REACH = 0.8
/**
 * A box counts as drawn when this share of its pixels changes with its figure gone — by day a thin ink figure in a
 * 2 × body-width box: 7.8–7.9 % measured (two runs, seed 4242), the control box 0.0 %; the floor is half of that.
 * And the control's allowance.
 */
const DRAWN_MIN = 0.04
const BLANK_MAX = 0.01

const stack = await startStack({
  port: await freePort(),
  label: 'zoom-match',
  env: { BOT_COUNT: '0', FIXED_SEED: '4242', WEATHER: 'off', DEV_PROBE: '1', ROUND_SECONDS: '300' },
})
try {
  const clients = []
  for (const name of ['ana', 'bo']) clients.push(await stack.openClient({ name }))
  await enterBattle(clients[0].page, { expectPlayers: 2, waitPlaying: true, label: 'zoom-match/ana' })
  await enterBattle(clients[1].page, { press: false, expectPlayers: 2, waitPlaying: true, label: 'zoom-match/bo' })
  const [ana, bo] = clients.map((c) => c.page)
  await ana.waitForFunction(() => window.__game.debug().terrainReady === true, null, { timeout: 120_000 })
  const k = await ana.evaluate(() => window.__game.constants())
  for (const n of ['CAMERA_ZOOM', 'VIEWPORT_W', 'VIEWPORT_H', 'PLAYER_H', 'PLAYER_W']) {
    if (!Number.isFinite(k[n])) throw new Error(`${n} is not exposed to the client (${k[n]}) — nothing below can hold`)
  }

  // --- 1. the scene's end ---------------------------------------------------------------------------------------
  const v = await ana.evaluate(() => {
    const d = window.__game.debug()
    const c = document.querySelector('canvas').getBoundingClientRect()
    return { zoom: d.zoom, view: d.worldView, canvas: { w: c.width, h: c.height } }
  })
  const vw = v.view?.width ?? v.view?.w
  const vh = v.view?.height ?? v.view?.h
  const before = (k.VIEWPORT_W / ZOOM_BEFORE) * (k.VIEWPORT_H / ZOOM_BEFORE)
  const l1 = `zoom ${v.zoom} (CAMERA_ZOOM ${k.CAMERA_ZOOM}); worldView ${vw}×${vh} = ${(vw * vh) / before}× the zoom-${ZOOM_BEFORE} view; canvas ${v.canvas.w}×${v.canvas.h}`
  if (!(Number.isFinite(vw) && Number.isFinite(vh))) fail(`debug().worldView has no size: ${JSON.stringify(v.view)}`)
  else if (v.zoom !== k.CAMERA_ZOOM) fail(`${l1} — the camera is not at CAMERA_ZOOM`)
  else if (Math.abs(vw - v.canvas.w / v.zoom) > 1 || Math.abs(vh - v.canvas.h / v.zoom) > 1) fail(`${l1} — the view is not the canvas over the zoom`)
  else if (!(vw * vh >= 4 * before)) fail(`${l1} — less than four times the zoom-${ZOOM_BEFORE} view`)
  else ok(l1)

  // --- 2. the picture's end ---------------------------------------------------------------------------------------
  const place = async (page, p) => {
    await page.evaluate(([x, y]) => window.__game.debugPlace(x, y), [p.x, p.y])
    await page.waitForFunction(() => window.__game.debug().stand.lastPlace !== null, null, { timeout: 10_000 }).catch(() => {})
  }
  // ana on open ground, the camera settled on her; then bo on the ground REACH of the half-view from the camera's centre.
  const groundAt = (page, xs, h) =>
    page.evaluate(([xs, h]) => {
      const c = window.__game.core
      for (const x of xs) {
        if (x < 8 || x > c.width - 8) continue
        for (let y = 40; y < c.height - 4; y++) {
          if (!c.solidAt(Math.round(x), y)) continue
          let clear = true
          for (let yy = y - h * 2; yy < y && clear; yy += 2) clear = !c.solidAt(Math.round(x), yy)
          if (clear) return { x, y: y - h / 2 - 1 }
          break
        }
      }
      return null
    }, [xs, h])
  const range = (from, to, step) => Array.from({ length: Math.floor(Math.abs(to - from) / step) + 1 }, (_, i) => from + Math.sign(to - from) * i * step)
  const a = await groundAt(ana, range(Math.round(vw * 1.2), Math.round(vw * 2.5), 16), k.PLAYER_H)
  if (!a) throw new Error('no open ground for ana on seed 4242')
  await place(ana, a)
  await sleep(2000)
  await drawnFrames(ana, 10)
  const cam = await ana.evaluate(() => window.__game.debug().worldView)
  const cx = cam.x + vw / 2
  const half = vw / 2
  const old = k.VIEWPORT_W / ZOOM_BEFORE / 2
  const b = await groundAt(ana, range(Math.round(cx + half * REACH), Math.round(cx + half * REACH - half * 0.15), 4), k.PLAYER_H)
  if (!b) throw new Error(`no ground for bo near ${Math.round(cx + half * REACH)}`)
  await place(bo, b)
  await sleep(1500)
  await drawnFrames(ana, 10)
  // The crates T23.36 rains every 2 s cross the frame with beacons and canopies; nobody here measures a crate.
  const hid = await ana.evaluate(() => window.__game.setItemsVisible(false))
  if (hid !== false) fail(`the pickups did not hide for the photographs (${hid})`)
  await drawnFrames(ana, 3)
  const seen = await ana.evaluate((id) => (window.__game.debug().drawnPlayers ?? []).find((p) => p.id !== id) ?? null, await ana.evaluate(() => window.__game.debug().me))
  const view = await ana.evaluate(() => window.__game.debug().worldView)
  const vcx = view.x + vw / 2
  if (!seen) fail('ana draws no bo')
  else {
    const off = Math.abs(seen.x - vcx)
    const box = async (p) => {
      const p0 = await toScreen(ana, p.x - k.PLAYER_W, p.y - k.PLAYER_H * 0.7)
      const p1 = await toScreen(ana, p.x + k.PLAYER_W, p.y + k.PLAYER_H * 0.55)
      return { x: Math.round(p0.x), y: Math.round(p0.y), w: Math.max(6, Math.round(p1.x - p0.x)), h: Math.max(6, Math.round(p1.y - p0.y)) }
    }
    const bB = await box(seen)
    const bK = await box({ x: 2 * vcx - seen.x, y: seen.y })
    const onScreen = bB.x >= 0 && bB.x + bB.w <= v.canvas.w && bB.y >= 0 && bB.y + bB.h <= v.canvas.h
    const withBo = await photo(ana)
    await clients[0].shot('zoom-match')
    await place(bo, { x: b.x, y: b.y - vh * 1.5 })
    await sleep(1200)
    await drawnFrames(ana, 10)
    const gone = await photo(ana)
    const pB = (await comparePhotos(ana, withBo, gone, { rect: bB })).fraction
    const pK = (await comparePhotos(ana, withBo, gone, { rect: bK })).fraction
    const l2 = `bo drawn ${off.toFixed(0)} px from the camera's centre (the zoom-${ZOOM_BEFORE} half-view is ${old}); his box ${JSON.stringify(bB)} ${(pB * 100).toFixed(1)} % changes when he leaves (min ${DRAWN_MIN * 100}), the box across the centre ${(pK * 100).toFixed(1)} % (max ${BLANK_MAX * 100})`
    if (!(off > old)) fail(`${l2} — he is not past the zoom-${ZOOM_BEFORE} view, so this shows nothing about the zoom`)
    else if (!onScreen) fail(`${l2} — his box is off ana's screen`)
    else if (!(pB >= DRAWN_MIN && pK <= BLANK_MAX)) fail(l2)
    else ok(l2)
  }
} finally {
  await stack.close()
}
await finish()
