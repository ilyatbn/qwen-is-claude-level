#!/usr/bin/env node
/**
 * Record a live bot match for the trailer (M99, T99.02).
 *
 *   node promo/capture-match.mjs <name> [seconds] [zoom] [url]
 *
 * Needs a server started with frenzied, armed bots (promo/README.md):
 *   DEV_BOT_FRENZY=1 DEV_LOADOUT=1 BOT_COUNT=5 BOT_SKILL=1 ./target/release/game-server
 * and the client dev server (`npm --prefix client run dev`).
 *
 * A "director" runs in the page: every frame it scores each fighter by how much is
 * happening near them (other fighters close by, effect lights — blasts, fire, muzzle
 * flashes) and eases the camera toward the busiest spot through `__game.watch`. Frames
 * come off CDP's screencast with their compositor timestamps, so the edit can rebuild
 * true timing; `events.json` holds what the director saw, for choosing the cuts.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildDir, launch, sleep } from './lib.mjs'

const name = process.argv[2] ?? 'match'
const seconds = Number(process.argv[3] ?? 60)
const zoom = Number(process.argv[4] ?? 1.8)
const url = process.argv[5] ?? 'http://localhost:5173/?e2e=1&game=1&name=Rook'

const out = join(buildDir, 'raw', name)
rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'frames'), { recursive: true })

const browser = await launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('pageerror:', String(e).slice(0, 300)))
await page.goto(url)
await page.waitForFunction('window.__game && window.__game.debug().me >= 0', null, { timeout: 120_000 })
await page.evaluate(() => window.__game.startWithBots())
await page.waitForFunction('window.__game.debug().phase === "playing"', null, { timeout: 90_000 })
console.log('playing')

// A trailer shot has no HUD: everything on the page that is not a canvas (or holds one) goes.
await page.addStyleTag({
  content: `body > *:not(canvas):not(:has(canvas)) { visibility: hidden !important; }
            canvas { cursor: none !important; }`,
})

await page.evaluate((zoom) => {
  const g = window.__game
  g.setZoom(zoom)
  g.setCrosshairVisible(false)
  g.setNamesVisible(false)
  // The minimap is a small canvas in a fixed box of its own; the world's canvases fill the page.
  for (const c of document.querySelectorAll('canvas')) {
    if (c.getBoundingClientRect().width < 600) (c.parentElement ?? c).style.visibility = 'hidden'
  }
  const dir = (window.__dir = { log: [], cam: null, target: null, heldFor: 0, frame: 0, fighters: [] })
  // What makes a shot: blasts and fire most, beams, then gunfire. Crystals and vents are scenery.
  const WEIGHT = { explosion: 4, rocket: 3, flame: 3, laser: 1.2, muzzle: 0.5, jet: 0.2 }
  const step = () => {
    dir.frame++
    // Positions are read every few frames (debug() is a large object); lights every frame.
    if (dir.frame % 4 === 1) {
      const d = g.debug()
      const me = d.player
      dir.fighters = d.stand.remotes.filter((r) => r.at).map((r) => ({ id: r.id, x: r.at.x, y: r.at.y }))
      if (me && me.alive) dir.fighters.push({ id: d.me, x: me.x, y: me.y })
    }
    const lights = g.effectLights()
    const score = (x, y) => {
      let s = 0
      for (const f of dir.fighters) {
        const r = Math.hypot(f.x - x, f.y - y)
        if (r < 350) s += 1 - r / 350
      }
      for (const l of lights) {
        const w = WEIGHT[l.kind] ?? 0
        const r = Math.hypot(l.x - x, l.y - y)
        if (r < 300) s += w * (1 - r / 300)
      }
      return s
    }
    let best = null
    for (const f of dir.fighters) {
      const s = score(f.x, f.y)
      if (!best || s > best.s) best = { x: f.x, y: f.y, s, id: f.id }
    }
    // Hysteresis: stay on a fight unless a clearly bigger one starts, or this one is over.
    const cur = dir.target && dir.fighters.find((f) => f.id === dir.target.id)
    const curS = cur ? score(cur.x, cur.y) : -1
    dir.heldFor++
    if (best && (!cur || best.s > curS * 1.6 + 0.5 || (dir.heldFor > 240 && best.s > curS))) {
      if (!cur || best.id !== dir.target.id) dir.heldFor = 0
      dir.target = best
    } else if (cur) {
      dir.target = { ...cur, s: curS, id: cur.id }
    }
    if (dir.target) {
      if (!dir.cam) dir.cam = { x: dir.target.x, y: dir.target.y }
      dir.cam.x += (dir.target.x - dir.cam.x) * 0.07
      dir.cam.y += (dir.target.y - dir.cam.y) * 0.07
      g.watch(dir.cam.x, dir.cam.y)
    }
    if (dir.frame % 6 === 0) {
      const kinds = {}
      for (const l of lights) kinds[l.kind] = (kinds[l.kind] ?? 0) + 1
      dir.log.push({ t: Date.now() / 1000, s: dir.target ? +dir.target.s.toFixed(2) : 0, kinds })
    }
    requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}, zoom)
await sleep(1500)

const cdp = await ctx.newCDPSession(page)
const frames = []
cdp.on('Page.screencastFrame', async (f) => {
  const i = frames.length
  frames.push({ i, t: f.metadata.timestamp })
  writeFileSync(join(out, 'frames', `${String(i).padStart(6, '0')}.jpg`), Buffer.from(f.data, 'base64'))
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
})
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 })
const t0 = Date.now()
while (Date.now() - t0 < seconds * 1000) {
  await sleep(5000)
  const phase = await page.evaluate(() => window.__game.debug().phase)
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)} s, ${frames.length} frames, phase ${phase}`)
}
await cdp.send('Page.stopScreencast')
const log = await page.evaluate(() => window.__dir.log)
writeFileSync(join(out, 'frames.json'), JSON.stringify(frames))
writeFileSync(join(out, 'events.json'), JSON.stringify(log))
const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0
console.log(`${frames.length} frames over ${span.toFixed(1)} s = ${(frames.length / span).toFixed(1)} fps -> ${out}`)
await browser.close()
