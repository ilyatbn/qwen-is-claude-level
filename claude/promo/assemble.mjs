#!/usr/bin/env node
/**
 * Put the trailer together (M99, T99.05).
 *
 *   node promo/assemble.mjs              # every frame, then encode with the score
 *   node promo/assemble.mjs 20,43.3,55   # stills at these times, for checking
 *
 * Needs: promo/build/intro/ (render-page.mjs), promo/build/raw/take<n>/ (capture-match.mjs),
 * promo/build/music.wav (music.mjs). Writes promo/build/SHRED-trailer.mp4.
 */
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildEdl, frameAt, loadTakes } from './edit.mjs'
import { buildDir, ffmpeg, launch, run } from './lib.mjs'
import { serve } from './serve.mjs'
import { BAR, BEAT, FPS, H, T, W } from './timeline.mjs'

const stills = process.argv[2] ? process.argv[2].split(',').map(Number) : null
const { edl } = buildEdl()
const takes = new Map(loadTakes().map((k) => [k.name, k]))
const pad = (n, w) => String(n).padStart(w, '0')
const decay = (t, at, rate) => (t >= at ? Math.exp(-(t - at) * rate) : 0)
const shakeAt = (t, at, amp) => {
  const d = decay(t, at, 7) * amp
  return [Math.sin(t * 91) * d, Math.cos(t * 73) * d]
}

function spec(t) {
  if (t < T.drop) {
    return { t, src: `/build/intro/${pad(Math.min(Math.round(t * FPS), Math.round(T.drop * FPS) - 1), 5)}.jpg` }
  }
  const s = { t, game: true }
  const slot = edl.find((x) => t >= x.t0 - 1e-6 && t < x.t0 + x.dur - 1e-6)
  if (slot) {
    const take = takes.get(slot.take)
    const at = slot.freeze ? slot.src : slot.src + (t - slot.t0) * (slot.speed ?? 1)
    s.src = `/build/raw/${slot.take}/frames/${pad(frameAt(take, at), 6)}.jpg`
    const u = (t - slot.t0) / slot.dur
    s.zoom = slot.freeze ? 1.02 + 0.2 * u : 1.03 + 0.05 * u
    s.dim = slot.dim ?? 0
    // Punch in on the snare (beats 2 and 4) while the riff runs.
    const inBar = (t - T.drop) % BAR
    const sn = inBar >= BEAT * 3 ? BEAT * 3 : inBar >= BEAT ? BEAT : null
    if (sn !== null && !slot.dim) s.zoom += 0.06 * Math.exp(-(inBar - sn) * 12)
    // The riser darkens as it builds.
    if (t >= T.riser && t < T.title) s.dim = 0.15 + 0.6 * ((t - T.riser) / (T.title - T.riser))
  } else {
    s.game = false
  }
  // The silence before the title is black.
  if (t >= T.title - 0.12 && t < T.title) s.src = null
  s.flash = Math.max(
    decay(t, T.drop, 12) * 0.9,
    ...[4, 8, 12].map((b) => decay(t, T.drop + b * BAR, 10) * 0.35),
    decay(t, T.title, 7),
    decay(t, T.end, 9) * 0.9,
  )
  const sh1 = shakeAt(t, T.title, 26)
  const sh2 = shakeAt(t, T.end, 22)
  s.shake = [sh1[0] + sh2[0], sh1[1] + sh2[1]]
  s.glitch = t >= T.title && t < T.title + 0.18 ? 0.5 : t >= T.soon + BAR * 2 && t < T.soon + BAR * 2 + 0.2 ? 0.6 : t >= T.end && t < T.end + 0.15 ? 0.7 : 0
  s.fade = 1 - clamp01((t - (T.tail - 0.9)) / 0.85)
  return s
}
const clamp01 = (x) => Math.min(1, Math.max(0, x))

const out = join(buildDir, stills ? 'final-stills' : 'final')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const { server, url } = await serve()
const browser = await launch()
const page = await (await browser.newContext({ viewport: { width: W, height: H } })).newPage()
page.on('pageerror', (e) => console.log('pageerror:', String(e)))
await page.goto(`${url}/comp/index.html`)
await page.waitForFunction('window.ready === true', null, { timeout: 60_000 })

const times = stills ?? Array.from({ length: Math.round(T.tail * FPS) }, (_, i) => i / FPS)
const t0 = Date.now()
for (const [i, t] of times.entries()) {
  await page.evaluate((s) => window.renderFrame(s), spec(t))
  const file = join(out, stills ? `t${t.toFixed(2)}.jpg` : `${pad(i, 5)}.jpg`)
  await page.locator('canvas').screenshot({ path: file, type: 'jpeg', quality: 94 })
  if (i % 300 === 0) console.log(`${i}/${times.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
}
await browser.close()
server.close()
if (stills) process.exit(0)

const music = join(buildDir, 'music.wav')
if (!existsSync(music)) throw new Error('no music.wav — run promo/music.mjs')
const mp4 = join(buildDir, 'SHRED-trailer.mp4')
await run(ffmpeg, [
  '-y', '-framerate', String(FPS), '-i', join(out, '%05d.jpg'), '-i', music,
  '-vf', 'unsharp=5:5:0.35', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', mp4,
])
console.log(`-> ${mp4}`)
