#!/usr/bin/env node
/**
 * `spectate-banner` — T23.29 (5): **the spectate line and the event banner do not overlap.** T23.26E's GPU shots caught
 * a meteor shower's "CLEARING / METEOR SHOWER 0:03" drawn over "SPECTATING Bot N …" at the top of a spectator's screen.
 *
 * A real server with the meteor shower forced (`WEATHER=meteor`), two bots and ana (who starts the round), and a
 * spectator (`&spectate=1`). Once the spectator's banner is up:
 *
 * - **Both are there** (the presence control): the banner is displayed with text, the spectate line has text, and
 *   both boxes have size.
 * - **They do not overlap**: the boxes as drawn (`getBoundingClientRect`) share no pixel, the line below the banner.
 * - **And on pixels**: the line's box in the spectator's frame changes when the line is hidden (it is drawn where its
 *   box says, so the geometry above is the picture's).
 *
 *   node scripts/checks/spectate-banner.mjs
 */
import { startStack, enterBattle, freePort, tally, sleep } from './harness.mjs'
import { photo, comparePhotos } from './pixels.mjs'

const { fail, ok, finish } = tally('spectate-banner')
/** The line's box counts as drawn when this share of its pixels changes with it removed (light text on the game). */
const DRAWN_MIN = 0.05

const stack = await startStack({
  port: await freePort(),
  label: 'spectate-banner',
  env: { BOT_COUNT: '2', FIXED_SEED: '4242', WEATHER: 'meteor', DEV_WARMUP_SECONDS: '2', ROUND_SECONDS: '300', DEV_START_HEALTH: '100000' },
})
let watcher = null
let ana = null
try {
  watcher = await stack.openClient({ name: 'watcher', query: '&spectate=1' })
  ana = await stack.openClient({ name: 'ana' })
  await enterBattle(ana.page, { waitPlaying: true, expectPlayers: 3, label: 'spectate-banner/ana' })
  const w = watcher.page
  await w.waitForFunction(() => {
    const d = window.__game.debug()
    return d.phase === 'playing' && d.spectating === true && (document.getElementById('spectate-line')?.textContent ?? '') !== ''
  }, null, { timeout: 60_000 })
  // The shower's telegraph puts the banner up; forced, the first one comes within the effect schedule's first beat.
  const up = await w
    .waitForFunction(() => {
      const b = document.getElementById('hud-banner')
      return !!b && b.style.display !== 'none' && (b.textContent ?? '').trim() !== ''
    }, null, { timeout: 120_000, polling: 250 })
    .then(() => true)
    .catch(() => false)
  if (!up) fail('the event banner never came up on the spectator with the meteor shower forced — nothing to measure')
  else {
    await sleep(300) // a frame or two for the line to take its place under the banner
    const boxes = await w.evaluate(() => {
      const r = (id) => {
        const e = document.getElementById(id)
        if (!e) return null
        const b = e.getBoundingClientRect()
        return { x: b.left, y: b.top, w: b.width, h: b.height, text: (e.textContent ?? '').trim() }
      }
      return { banner: r('hud-banner'), line: r('spectate-line') }
    })
    const { banner: B, line: L } = boxes
    const l1 = `banner ${JSON.stringify(B)}; spectate line ${JSON.stringify(L)}`
    if (!B || !L || !(B.w > 0 && B.h > 0 && L.w > 0 && L.h > 0) || !B.text || !L.text) fail(`${l1} — one of the two is not drawn (the presence control)`)
    else {
      const overlap = B.x < L.x + L.w && L.x < B.x + B.w && B.y < L.y + L.h && L.y < B.y + B.h
      if (overlap) fail(`${l1} — the two boxes overlap`)
      else if (!(L.y >= B.y + B.h)) fail(`${l1} — apart, but the line is not below the banner`)
      else ok(`the spectate line sits ${(L.y - (B.y + B.h)).toFixed(1)} px below the banner: ${l1}`)
      // Pixels: the line's box with the line, and without it (the same instant, nothing else changed).
      const rect = { x: Math.floor(L.x), y: Math.floor(L.y), w: Math.ceil(L.w), h: Math.ceil(L.h) }
      await w.evaluate(() => window.__game.freeze(true))
      await sleep(150)
      const withLine = await photo(w)
      await watcher.shot('spectate-banner')
      await w.evaluate(() => { document.getElementById('spectate-line').style.visibility = 'hidden' })
      await sleep(100)
      const without = await photo(w)
      await w.evaluate(() => { document.getElementById('spectate-line').style.visibility = '' })
      await w.evaluate(() => window.__game.freeze(false))
      const p = (await comparePhotos(w, withLine, without, { rect })).fraction
      const m = `pixels: the line's box ${(p * 100).toFixed(1)} % changes with the line hidden (min ${DRAWN_MIN * 100})`
      if (p >= DRAWN_MIN) ok(m)
      else fail(m)
    }
  }
  for (const c of [watcher, ana]) if (c?.pageErrors?.length) fail(`${c.name}: page errors: ${c.pageErrors.join(' | ')}`)
} catch (e) {
  fail(`${e?.stack ?? e}`)
} finally {
  await stack.close()
}
await finish()
