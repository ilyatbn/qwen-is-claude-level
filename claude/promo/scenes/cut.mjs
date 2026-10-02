#!/usr/bin/env node
/**
 * Cut a gameplay scene's clip from a take (M99, T99.04).
 *
 *   node promo/scenes/cut.mjs <scene> [take] [in s | auto] [dur s] [speed]
 *
 * Takes `dur` seconds of film starting `in` seconds into the take (`auto`: the window the
 * director's log scores busiest — blasts, fire, beams, and how many different kinds at once),
 * played `speed` times faster, resampled to 60 fps by the frames' own timestamps. Then the
 * scene's caption and fades go on (`comp.html`, rendered frame by frame) and it is encoded:
 * `promo/build/scenes/<scene>.mp4`, 1920x1080, 60 fps, x264 CRF 18. A contact sheet beside it.
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildDir, ffmpeg, promoDir, run } from '../lib.mjs'
import { SCENES } from './scenes.mjs'

const [name, takeA, inA, durA, speedA] = process.argv.slice(2)
const scene = SCENES[name]
if (!scene) throw new Error(`no scene ${name}`)
const take = `${name}-${takeA ?? '1'}`
const cut = { dur: 5, speed: 1, ...scene.cut }
const dur = Number(durA ?? cut.dur)
const speed = Number(speedA ?? cut.speed)
const FPS = 60
const raw = join(buildDir, 'raw', take)
const frames = JSON.parse(readFileSync(join(raw, 'frames.json'), 'utf8'))
const t0 = frames[0].t
const span = frames[frames.length - 1].t - t0
const need = dur * speed

// --- where to cut ---------------------------------------------------------------------------
const WEIGHT = { explosion: 4, rocket: 3, flame: 2.5, laser: 1.5, muzzle: 0.6, jet: 0.3, ...(cut.weight ?? {}) }
const inPoint = inA ?? (cut.in === undefined ? 'auto' : String(cut.in))
let at = inPoint !== 'auto' ? Number(inPoint) : null
if (at === null) {
  const log = JSON.parse(readFileSync(join(raw, 'events.json'), 'utf8'))
  let best = { s: -1, at: 0 }
  for (let a = cut.earliest ?? 0; a + need <= span; a += 0.25) {
    const win = log.filter((e) => e.t >= t0 + a && e.t < t0 + a + need)
    if (!win.length) continue
    const kinds = new Set()
    let s = 0
    for (const e of win) {
      for (const [k, n] of Object.entries(e.kinds)) {
        s += (WEIGHT[k] ?? 0) * n
        if (n && WEIGHT[k] >= 0.6) kinds.add(k)
      }
    }
    s = (s / win.length) * (1 + 0.35 * kinds.size)
    if (s > best.s) best = { s, at: a, kinds: [...kinds] }
  }
  at = best.at
  console.log(`auto: in at ${at.toFixed(2)} s (score ${best.s.toFixed(1)}, kinds ${best.kinds?.join(' ')})`)
}
if (at + need > span + 1e-6) throw new Error(`the take is ${span.toFixed(1)} s; ${at}+${need} does not fit`)

// --- the plan -------------------------------------------------------------------------------
const frameAt = (t) => {
  let lo = 0
  let hi = frames.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (frames[mid].t <= t) lo = mid
    else hi = mid - 1
  }
  return frames[lo].i
}
const n = Math.round(dur * FPS)
const plan = {
  frames: Array.from({ length: n }, (_, k) => {
    const i = frameAt(t0 + at + (k / FPS) * speed)
    return `/build/raw/${take}/frames/${String(i).padStart(6, '0')}.jpg`
  }),
  fadeIn: cut.fadeIn ?? [0, 0.25],
  fadeOut: cut.fadeOut ? cut.fadeOut.map((v) => (v < 0 ? dur + v : v)) : null,
  lines: (scene.lines ?? (scene.caption ? [{ text: scene.caption.text }] : [])).map((l) => ({
    at: 0.35,
    char: 0.085,
    hold: 1,
    ...l,
  })),
}
const dir = join(buildDir, 'scenes', name)
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan))
console.log(`${take}: ${at.toFixed(2)}–${(at + need).toFixed(2)} s of ${span.toFixed(1)} s, x${speed} -> ${n} frames`)

// --- render and encode ----------------------------------------------------------------------
const outName = `scenes/${name}/out`
rmSync(join(buildDir, outName), { recursive: true, force: true })
await run('node', [join(promoDir, 'render-page.mjs'), `scenes/comp.html?scene=${name}`, outName, String(dur)], { quiet: false })
const mp4 = join(buildDir, 'scenes', `${name}.mp4`)
await run(ffmpeg, [
  '-y',
  '-framerate',
  String(FPS),
  '-i',
  join(buildDir, outName, '%05d.jpg'),
  '-c:v',
  'libx264',
  '-preset',
  'slow',
  '-crf',
  '18',
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  '+faststart',
  mp4,
])
console.log(mp4)
await run('node', [join(promoDir, 'scenes', 'sheet.mjs'), mp4, '4', '3'], { quiet: false })
