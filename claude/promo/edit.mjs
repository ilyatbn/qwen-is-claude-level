/**
 * The cut (M99, T99.05): which moment of which take plays in each slot of the timeline.
 *
 * Slots sit on the beat grid (`timeline.mjs`), so every cut lands on the music. The footage is
 * scored from the director's event log (what lit the frame: blasts, rockets, fire, beams), and
 * the best windows go to the slots that matter most — the last bars before the title, the
 * montage before COMING SOON — then down the list, never reusing a moment.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildDir } from './lib.mjs'
import { BAR, BEAT, T } from './timeline.mjs'

const WEIGHT = { explosion: 4, rocket: 3, flame: 2, laser: 1, muzzle: 0.5 }

export function loadTakes() {
  const dir = join(buildDir, 'raw')
  return readdirSync(dir)
    .filter((k) => k.startsWith('take') && existsSync(join(dir, k, 'events.json')))
    .map((name) => {
      const frames = JSON.parse(readFileSync(join(dir, name, 'frames.json'), 'utf8'))
      const events = JSON.parse(readFileSync(join(dir, name, 'events.json'), 'utf8'))
        .filter((e) => e.t >= frames[0].t && e.t <= frames[frames.length - 1].t)
        .map((e) => ({ t: e.t, v: Object.entries(e.kinds).reduce((s, [k, n]) => s + (WEIGHT[k] ?? 0) * n, 0), blast: e.kinds.explosion ?? 0 }))
      return { name, frames, events }
    })
}

/** The frame of `take` shown at epoch time `t`. */
export function frameAt(take, t) {
  const f = take.frames
  let lo = 0
  let hi = f.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (f[mid].t <= t) lo = mid
    else hi = mid - 1
  }
  return f[lo].i
}

function slots() {
  const s = []
  const cut = (t0, t1, every, weight, extra = {}) => {
    for (let t = t0; t < t1 - 1e-6; t += every) s.push({ t0: t, dur: every, weight, ...extra })
  }
  const d = T.drop
  cut(d, d + BAR * 4, BAR / 2, 2.5) // the opening: half-bar shots, strong
  cut(d + BAR * 4, d + BAR * 8, BAR / 2, 1)
  cut(d + BAR * 8, d + BAR * 12, BAR / 2, 1.5)
  cut(d + BAR * 12, T.riser, BEAT, 3) // the frenzy before the riser
  cut(T.riser, T.title, BAR, 2, { dim: 0.35 }) // the riser: two long shots, darkening
  s.push({ t0: T.title, dur: BAR, weight: 5, freeze: true, dim: 0.55 }) // SHRED lands on the biggest blast
  cut(T.title + BAR, T.soon, BAR, 2, { dim: 0.55 })
  cut(T.soon, T.soon + BAR * 2, BEAT, 3) // the montage
  // Two half-speed shots, for weight.
  for (const at of [d + BAR * 3.5, d + BAR * 11.5]) {
    const k = s.find((x) => Math.abs(x.t0 - at) < 1e-6)
    if (k) k.speed = 0.5
  }
  return s
}

export function buildEdl() {
  const takes = loadTakes()
  const used = takes.map(() => [])
  const edl = slots()
  const order = [...edl.keys()].sort((a, b) => edl[b].weight - edl[a].weight || a - b)
  for (const k of order) {
    const slot = edl[k]
    const len = slot.dur * (slot.speed ?? 1)
    let best = null
    takes.forEach((take, ti) => {
      const ev = take.events
      for (let i = 0; i < ev.length; i++) {
        const a = ev[i].t
        const b = a + len
        if (b > take.frames[take.frames.length - 1].t) break
        if (used[ti].some(([u0, u1]) => a < u1 + 0.4 && b > u0 - 0.4)) continue
        let sum = 0
        let n = 0
        let peak = 0
        let early = 0
        for (let j = i; j < ev.length && ev[j].t < b; j++) {
          sum += ev[j].v
          n++
          peak = Math.max(peak, slot.freeze ? ev[j].blast : ev[j].v)
          if (ev[j].t < a + len * 0.4) early += ev[j].v
        }
        const score = slot.freeze ? peak : sum / Math.max(1, n) + 0.3 * peak + 0.3 * early / Math.max(1, n)
        if (!best || score > best.score) best = { score, ti, a }
      }
    })
    if (!best) throw new Error(`no footage left for the slot at ${slot.t0.toFixed(2)} s`)
    used[best.ti].push([best.a, best.a + len])
    slot.take = takes[best.ti].name
    slot.src = best.a
    slot.score = +best.score.toFixed(2)
    if (slot.freeze) {
      // The instant of the biggest blast inside the window.
      const ev = takes[best.ti].events.filter((e) => e.t >= best.a && e.t < best.a + len)
      slot.src = ev.reduce((m, e) => (e.blast > m.blast ? e : m), ev[0]).t
    }
  }
  return { takes, edl }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { edl } = buildEdl()
  for (const s of edl) console.log(`${s.t0.toFixed(2).padStart(6)} ${s.dur.toFixed(2)}  ${s.take} +${s.src.toFixed(1)}  score ${s.score}${s.freeze ? ' FREEZE' : ''}${s.speed ? ' x' + s.speed : ''}`)
}
