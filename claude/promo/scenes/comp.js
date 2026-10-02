/**
 * The scene compositor (M99, T99.04): one output frame at time `t` — the recorded game frame the
 * plan names for it, the typed caption, the fades. `render-page.mjs` steps `t` and screenshots,
 * so a slow frame is still exactly 1/60 s of film.
 *
 * The plan (`/build/scenes/<scene>/plan.json`, written by `cut.mjs`):
 *   frames: [path per output frame], fadeIn / fadeOut: [from, to] seconds,
 *   lines: [{ text, at, char, hold, erase, center }] — typed from `at`, `char` s a letter, then
 *   held; with `erase` (s) it is wiped by a glitch scramble that long after `hold` ends.
 */
const params = new URLSearchParams(location.search)
const plan = await fetch(`/build/scenes/${params.get('scene')}/plan.json`).then((r) => r.json())
const img = document.getElementById('frame')
const typeEl = document.getElementById('type')
const txt = typeEl.querySelector('.txt')
const cur = typeEl.querySelector('.cur')
const black = document.getElementById('black')
const FPS = 60

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))
const smooth = (a, b, t) => {
  const u = clamp((t - a) / (b - a))
  return u * u * (3 - 2 * u)
}
// Deterministic noise: a frame is a pure function of t.
const hash = (a, b) => {
  let h = (a * 374761393 + b * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
const GLYPHS = '#%&@$*+=<>/\\|?!01ABCDEFGHJKLMNPQRSTUVWXYZ'

function caption(t) {
  const line = [...(plan.lines ?? [])].reverse().find((l) => t >= l.at)
  if (!line) {
    typeEl.style.opacity = '0'
    return
  }
  typeEl.classList.toggle('center', !!line.center)
  const typed = clamp(Math.floor((t - line.at) / line.char), 0, line.text.length)
  const typing = typed < line.text.length
  const done = line.at + line.text.length * line.char
  const eraseAt = line.erase ? done + line.hold : Infinity
  const frame = Math.round(t * FPS)
  let shown = line.text.slice(0, typed)
  let opacity = 1
  let shift = 0
  let split = 0
  if (t >= eraseAt) {
    // The glitch wipe: left to right each letter scrambles for a few frames and goes; the line
    // jitters sideways and its colour splits while it does.
    const u = clamp((t - eraseAt) / line.erase)
    const n = line.text.length
    shown = [...line.text]
      .map((c, i) => {
        const gone = (i + 1) / (n + 1)
        if (u > gone) return ' '
        if (u > gone - 0.35 || hash(frame, i) < u * 0.9) return GLYPHS[Math.floor(hash(frame, i + 99) * GLYPHS.length)]
        return c
      })
      .join('')
    if (u >= 1) opacity = 0
    shift = (hash(frame, 7) - 0.5) * 60 * (1 - u * 0.5)
    split = 4 + 10 * hash(frame, 3)
  }
  if (line.fadeOut) opacity *= 1 - smooth(line.fadeOut[0], line.fadeOut[1], t)
  const blink = typing || Math.floor((t - line.at) * 2.4) % 2 === 0
  txt.textContent = shown
  cur.style.visibility = blink && t < eraseAt ? 'visible' : 'hidden'
  typeEl.style.opacity = String(opacity)
  const base = line.center ? 'translateY(-50%)' : ''
  typeEl.style.transform = `${base} translateX(${shift.toFixed(1)}px)`
  typeEl.style.filter = split ? `drop-shadow(${split}px 0 0 rgba(255,40,90,.85)) drop-shadow(${-split}px 0 0 rgba(40,220,255,.85))` : ''
}

window.renderAt = async (t) => {
  const i = clamp(Math.round(t * FPS), 0, plan.frames.length - 1)
  const src = plan.frames[i]
  if (img.getAttribute('src') !== src) {
    img.src = src
    await img.decode().catch(() => {})
  }
  caption(t)
  const fi = plan.fadeIn ? 1 - smooth(plan.fadeIn[0], plan.fadeIn[1], t) : 0
  const fo = plan.fadeOut ? smooth(plan.fadeOut[0], plan.fadeOut[1], t) : 0
  black.style.opacity = String(Math.max(fi, fo))
}

await document.fonts.load('600 46px "Ubuntu Sans Mono"')
await document.fonts.load('700 150px "Ubuntu Sans Mono"')
window.ready = true
