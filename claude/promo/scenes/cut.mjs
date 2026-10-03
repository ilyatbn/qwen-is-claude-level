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
// One take's frames, by the frames' own timestamps: the frame showing at `t` seconds into the take.
function loadTake(take) {
  const frames = JSON.parse(readFileSync(join(buildDir, 'raw', take, 'frames.json'), 'utf8'))
  const t0 = frames[0].t
  const at = (t) => {
    let lo = 0
    let hi = frames.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (frames[mid].t <= t0 + t) lo = mid
      else hi = mid - 1
    }
    return `/build/raw/${take}/frames/${String(frames[lo].i).padStart(6, '0')}.jpg`
  }
  return { frames, t0, span: frames[frames.length - 1].t - t0, at }
}
const n = Math.round(dur * FPS)
let frameList
if (cut.montage) {
  // A montage (scene 4): hard cuts between takes, each `{ take, in, dur }`, played in order.
  frameList = []
  for (const shot of cut.montage) {
    const t = loadTake(shot.take)
    if (shot.in + shot.dur > t.span + 1e-6) throw new Error(`${shot.take} is ${t.span.toFixed(1)} s; ${shot.in}+${shot.dur} does not fit`)
    for (let k = 0; k < Math.round(shot.dur * FPS); k++) frameList.push(t.at(shot.in + k / FPS))
    console.log(`${shot.take}: ${shot.in}–${shot.in + shot.dur} s`)
  }
  frameList = frameList.slice(0, n)
} else {
  const t = loadTake(take)
  const { t0, span } = t
  const need = dur * speed

  // --- where to cut -------------------------------------------------------------------------
  const WEIGHT = { explosion: 4, rocket: 3, flame: 2.5, laser: 1.5, muzzle: 0.6, jet: 0.3, ...(cut.weight ?? {}) }
  const inPoint = inA ?? (cut.in === undefined ? 'auto' : String(cut.in))
  let at = inPoint !== 'auto' ? Number(inPoint) : null
  if (at === null) {
    const log = JSON.parse(readFileSync(join(buildDir, 'raw', take, 'events.json'), 'utf8'))
    let best = { s: -1, at: 0 }
    for (let a = cut.earliest ?? 0; a + need <= span; a += 0.25) {
      const win = log.filter((e) => e.t >= t0 + a && e.t < t0 + a + need)
      if (!win.length) continue
      const kinds = new Set()
      let sc = 0
      for (const e of win) {
        for (const [kk, nn] of Object.entries(e.kinds)) {
          sc += (WEIGHT[kk] ?? 0) * nn
          if (nn && WEIGHT[kk] >= 0.6) kinds.add(kk)
        }
      }
      sc = (sc / win.length) * (1 + 0.35 * kinds.size)
      if (sc > best.s) best = { s: sc, at: a, kinds: [...kinds] }
    }
    at = best.at
    console.log(`auto: in at ${at.toFixed(2)} s (score ${best.s.toFixed(1)}, kinds ${best.kinds?.join(' ')})`)
  }
  if (at + need > span + 1e-6) throw new Error(`the take is ${span.toFixed(1)} s; ${at}+${need} does not fit`)
  frameList = Array.from({ length: n }, (_, k) => t.at(at + (k / FPS) * speed))
  console.log(`${take}: ${at.toFixed(2)}–${(at + need).toFixed(2)} s of ${span.toFixed(1)} s, x${speed} -> ${n} frames`)
}

// --- the plan -------------------------------------------------------------------------------
const plan = {
  frames: frameList,
  fadeIn: cut.fadeIn ?? [0, 0.25],
  grade: cut.grade ?? null,
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
