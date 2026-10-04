/**
 * T23.12 (R12): the cast's drawing, ported from `tasks/M23/reference/mockup-src/e_style.js` — `stick`, `beetle`,
 * `spider`, `bird`, `turret`, `gate`, `crystals`, `rocket`, `smoke`, `glow` — **geometry and line weights
 * verbatim** (every number below is the mockup's; a port that disagrees with it is wrong until the picture says
 * otherwise). Canvas2D, drawn per actor into an atlas cell (`atlas.ts`); the rim light is a shader (T23.13).
 *
 * One addition, for the three-part cell (`cell.ts`): `lit()`'s rim and fill passes draw each actor again in one
 * flat colour, but the parts with **fixed colours** — a jet flame, a crystal's glow, a rocket's motor, a spider's
 * eye — are drawn in their own colours in every pass. The cell's silhouette mask must not contain them, so
 * `setExtras(false)` skips exactly those parts (each site is marked `extra`); everything else is unchanged.
 */

import type { G } from './flat'
export type { G }
type P = [number, number]

/** `e_style.js::INK` — the silhouette colour the next draw uses (`lit()` sets it per pass). */
export let INK = '#16110d'
export function setInk(c: string): void {
  INK = c
}

let extras = true
/** Draw the fixed-colour parts (`true`, the mockup) or leave them out (the cell's silhouette mask). */
export function setExtras(on: boolean): void {
  extras = on
}

function withT(g: G, x: number, y: number, s: number, face: number, rot: number, fn: () => void): void {
  g.save()
  g.translate(x, y)
  g.rotate(rot || 0)
  g.scale(s * face, s)
  fn()
  g.restore()
}
export function line(g: G, pts: P[], w: number, col = INK): void {
  g.strokeStyle = col
  g.lineWidth = w
  g.beginPath()
  g.moveTo(...pts[0]!)
  for (const p of pts.slice(1)) g.lineTo(...p)
  g.stroke()
}
export function disc(g: G, x: number, y: number, r: number, col = INK): void {
  g.fillStyle = col
  g.beginPath()
  g.arc(x, y, r, 0, 7)
  g.fill()
}

export function glow(g: G, x: number, y: number, r: number, rgb: string, a = 0.6): void {
  const gr = g.createRadialGradient(x, y, 0, x, y, r)
  gr.addColorStop(0, `rgba(${rgb},${a})`)
  gr.addColorStop(0.35, `rgba(${rgb},${a * 0.35})`)
  gr.addColorStop(1, `rgba(${rgb},0)`)
  g.fillStyle = gr
  g.beginPath()
  g.arc(x, y, r, 0, 7)
  g.fill()
}

/** One `S.glow` of a flamethrower's flame, relative to the muzzle (`scene.ts::Glow`). */
export interface FlameGlow {
  x: number
  y: number
  r: number
  rgb: string
  a: number
}

export interface StickOpts {
  s?: number
  face?: number
  rot?: number
  aim?: number
  /** `e_style.js::stick`'s `weapon`: one of its three names, or (T23.16, F6's 1× row) a drawing in the shoulder frame. */
  weapon?: string | ((g: G) => void)
  accent?: string
  jet?: boolean
  pose?: string
  marker?: string | false
  flame?: FlameGlow[] | null
}

/** `e_style.js::stick` — ~30 px tall at s = 1, feet at (x, y); aim in radians (0 = facing, + = up). */
export function stick(g: G, x: number, y: number, o: StickOpts = {}): void {
  const { s = 1.15, face = 1, rot = 0, aim = 0.3, weapon = 'bazooka', accent = '#d8432a', jet = false, pose = 'stand', marker = false, flame = null } = o
  withT(g, x, y, s, face, rot, () => {
    const hip: P = [0, -13]
    const neck: P = [0.8, -23.5]
    const head: P = [1.4, -27.8]
    g.strokeStyle = accent
    g.lineWidth = 2.1
    g.beginPath()
    g.moveTo(0.6, -23)
    g.quadraticCurveTo(-5, -24.5 + (jet ? -2 : 0), -10, -21.5 + (jet ? -5 : 0))
    g.stroke()
    g.lineWidth = 1.5
    g.beginPath()
    g.moveTo(0.4, -22.6)
    g.quadraticCurveTo(-4, -21, -8.5, -17.5 + (jet ? -4 : 0))
    g.stroke()
    g.fillStyle = INK
    g.beginPath()
    g.roundRect(-4.6, -23.5, 3.6, 8.5, 1.2)
    g.fill()
    if (jet && extras) {
      const fl = g.createLinearGradient(0, -15, 0, -3)
      fl.addColorStop(0, 'rgba(255,245,200,1)')
      fl.addColorStop(0.4, 'rgba(255,160,40,0.95)')
      fl.addColorStop(1, 'rgba(230,70,20,0)')
      g.fillStyle = fl
      g.beginPath()
      g.moveTo(-4.4, -15)
      g.quadraticCurveTo(-2.8, -6, -2.8, -3)
      g.quadraticCurveTo(-2.8, -6, -1.2, -15)
      g.fill()
    }
    const L: [P, P][] =
      pose === 'stand'
        ? [[[3, -6.5], [4.2, 0]], [[-1.8, -6.5], [-4, 0]]]
        : pose === 'run'
          ? [[[5, -8], [8, -3]], [[-2, -6], [-6, -1]]]
          : [[[4.5, -8], [2.5, -2.5]], [[-0.5, -7], [-3.2, -1.5]]]
    for (const [k, f] of L) {
      line(g, [hip, k, f], 2.3)
      line(g, [f, [f[0] + 1.8, f[1]]], 2.3)
    }
    line(g, [hip, neck], 3)
    disc(g, head[0], head[1], 3.7)
    g.save()
    g.translate(1.2, -21.5)
    g.rotate(-aim)
    if (weapon === 'bazooka') {
      line(g, [[-8, -1.2], [11, -1.2]], 3.6)
      g.fillStyle = INK
      g.beginPath()
      g.moveTo(10, -3.8)
      g.lineTo(14, -4.6)
      g.lineTo(14, 2.2)
      g.lineTo(10, 1.4)
      g.fill()
      line(g, [[0, 0], [2.5, 3.5], [4, 1]], 1.8)
      line(g, [[0, 0], [6, 2.5], [8, 0.8]], 1.8)
    } else if (weapon === 'laser') {
      line(g, [[-3, 0], [13, 0]], 2)
      line(g, [[1, 0], [1, 3]], 1.8)
      disc(g, 13.5, 0, 1.1, accent)
      line(g, [[0, 0], [3, 3], [5, 0.6]], 1.7)
      line(g, [[0, 0], [7, 2.5], [9, 0.4]], 1.7)
    } else if (weapon === 'flamer') {
      line(g, [[-2, 0.5], [13, 0.5]], 2.4)
      disc(g, -2, 4, 2.6)
      line(g, [[0, 0], [3, 3], [5, 1]], 1.7)
      line(g, [[0, 0], [7, 3], [9, 1]], 1.7)
      if (flame) for (const f of flame) glow(g, f.x, f.y, f.r, f.rgb, f.a)
    } else if (typeof weapon === 'function') {
      weapon(g)
    } else {
      line(g, [[0, 0], [4, 5], [7, 3]], 1.8)
    }
    g.restore()
  })
  if (marker) {
    g.fillStyle = marker
    g.beginPath()
    g.moveTo(x - 3.2 * s, y - 38 * s)
    g.lineTo(x + 3.2 * s, y - 38 * s)
    g.lineTo(x, y - 34 * s)
    g.fill()
  }
}

export function beetle(g: G, x: number, y: number, { s = 1, face = 1, rot = 0 } = {}): void {
  withT(g, x, y, s, face, rot, () => {
    const legs: [P, P][] = [[[4, -3], [7, 0]], [[0, -3], [1, 0]], [[-4, -3], [-6, 0]]]
    for (const [a, b] of legs) line(g, [a, [a[0] + (b[0] - a[0]) * 0.4, -4.2], b], 1.1)
    g.fillStyle = INK
    g.beginPath()
    g.ellipse(-0.5, -4.6, 7.2, 3.9, 0, Math.PI, 0)
    g.lineTo(6.7, -3)
    g.lineTo(-7.7, -3)
    g.fill()
    disc(g, 7.8, -4, 2.3)
    g.beginPath()
    g.moveTo(8.5, -5.5)
    g.quadraticCurveTo(12.5, -7, 13, -11)
    g.quadraticCurveTo(11, -7, 9.5, -3.8)
    g.fill()
  })
}

export function spider(g: G, x: number, y: number, { s = 1, face = 1, rot = 0, eye = '#ff4a2a' } = {}): void {
  withT(g, x, y, s, face, rot, () => {
    for (let i = 0; i < 4; i++) {
      const bx = 1 - i * 1.2
      const fx = [9, 6, -5, -9][i]! + (i < 2 ? 2 : -2)
      const kx = bx + (fx - bx) * 0.45
      line(g, [[bx, -5], [kx, -11 + i * 0.6], [fx, 0]], 1.1)
    }
    disc(g, -3.5, -6.5, 4.2)
    disc(g, 2.2, -5.2, 2.6)
    if (extras) disc(g, 4.2, -5.8, 0.7, eye)
  })
}

/**
 * T23.31 (docs/78 §A7): the volcanic world's animals, after the owner's references (`mapideas/volcanic*.jpg`) — not
 * the mockup's (it has none), drawn in its vocabulary: ink silhouettes, thin stroked legs, one fixed-colour accent
 * (`extra`, like the spider's eye). Feet on y 0, facing +x. `gait` (0–1) is the walk cycle's phase; the atlas caches a
 * cell per quantised phase (`furniture.ts::GAIT_STEPS`).
 *
 * **Tripod walker** — a small dome on three long, thin, jointed legs, a stilted gait: one leg at a time lifts and
 * steps forward while the other two slide back under the body, which bobs a little at each step.
 */
export function tripod(g: G, x: number, y: number, { s = 1, face = 1, gait = 0, eye = '#ff7a2a' } = {}): void {
  withT(g, x, y, s, face, 0, () => {
    const lift = (ph: number): [number, number] => {
      // Swing (a third of the cycle): the foot rises and moves forward; stance: it slides back on the ground.
      if (ph < 1 / 3) {
        const u = ph * 3
        return [-2.2 + 4.4 * u, -2.4 * Math.sin(Math.PI * u)]
      }
      const u = (ph - 1 / 3) * 1.5
      return [2.2 - 4.4 * u, 0]
    }
    const bob = -0.5 * Math.abs(Math.sin(gait * Math.PI * 3))
    const by = -12.6 + bob
    const feet: P[] = [[-7.5, 0], [0.8, 0], [7.8, 0]]
    feet.forEach(([fx], i) => {
      const [dx, dy] = lift((gait + i / 3) % 1)
      const hip: P = [-1.6 + i * 1.6, by + 2.2]
      const foot: P = [fx + dx, dy]
      // The knee bends up and out: a stilt's joint high above the foot.
      const out = fx < -1 ? -1 : fx > 1 ? 1 : 0.4
      const knee: P = [hip[0] + (foot[0] - hip[0]) * 0.55 + out * 2.2, hip[1] + (foot[1] - hip[1]) * 0.35 - 1.2]
      line(g, [hip, knee, foot], 0.95)
      line(g, [[foot[0] - 0.9, foot[1]], [foot[0] + 0.9, foot[1]]], 0.9)
    })
    // The dome: a cap over a short skirt and a hanging under-pod, a feeler on top.
    g.fillStyle = INK
    g.beginPath()
    g.ellipse(0, by, 4.6, 3.6, 0, Math.PI, 0)
    g.lineTo(4.9, by + 1.1)
    g.lineTo(-4.9, by + 1.1)
    g.closePath()
    g.fill()
    g.beginPath()
    g.ellipse(0, by + 1.6, 2.2, 1.3, 0, 0, 7)
    g.fill()
    line(g, [[0.6, by - 3.4], [1.4, by - 5.4]], 0.6)
    if (extras) disc(g, 2.6, by - 0.6, 0.65, eye)
  })
}

/**
 * **Octopus crawler** — a low bulbous body on six curled legs that scuttle: alternate legs reach and pull, the tips
 * curling up off the ground, the body rocking over them.
 */
export function crawler(g: G, x: number, y: number, { s = 1, face = 1, gait = 0, eye = '#ff7a2a' } = {}): void {
  withT(g, x, y, s, face, 0, () => {
    const rock = 0.35 * Math.sin(gait * Math.PI * 2)
    const by = -5.2 + rock
    const reach = [7.4, 5.0, 2.6]
    for (let i = 0; i < 6; i++) {
      const side = i < 3 ? 1 : -1
      const k = i % 3
      const ph = Math.sin((gait + (i % 2) * 0.5) * Math.PI * 2)
      const fx = side * (reach[k]! + 0.9 * ph) - 0.6
      const root: P = [side * (0.8 + k * 0.5) - 0.6, by + 2]
      const lift = Math.max(0, -ph) * 1.1
      g.strokeStyle = INK
      g.lineWidth = 1.05 - k * 0.12
      g.beginPath()
      g.moveTo(...root)
      g.quadraticCurveTo(root[0] + (fx - root[0]) * 0.6, by - 0.8 - k * 0.4, fx, -0.3 - lift)
      // The tip curls back and up — the reference's tentacles.
      g.quadraticCurveTo(fx + side * 1.5, -0.4 - lift, fx + side * 1.4, -1.8 - lift)
      g.stroke()
    }
    g.fillStyle = INK
    g.beginPath()
    g.ellipse(-0.9, by - 1.6, 3.7, 3.3, -0.25, 0, 7)
    g.fill()
    g.beginPath()
    g.ellipse(-0.4, by + 0.9, 3.0, 1.6, 0, 0, 7)
    g.fill()
    if (extras) disc(g, 1.7, by - 0.6, 0.55, eye)
  })
}

/**
 * `metal` (T23.19B, §C16's metal bird — worth more, so it must read apart at a glance, and R10 keeps it ink): a
 * machine, not a bird — straight swept wings with a notched trailing edge, a longer boxy fuselage and a tail fin, where
 * F4's bird is all curves. Same span and flap, so it flies the same box.
 */
export function bird(g: G, x: number, y: number, { s = 1, face = 1, flap = 0.5, metal = false } = {}): void {
  if (metal) return metalBird(g, x, y, s, face, flap)
  withT(g, x, y, s, face, 0, () => {
    const up = -6 + flap * 12
    g.fillStyle = INK
    g.beginPath()
    g.moveTo(-9, up)
    g.quadraticCurveTo(-4, -1.5, 0, 0)
    g.quadraticCurveTo(5, -1.5, 10, up + 1)
    g.quadraticCurveTo(5, 0.4, 0, 1.6)
    g.quadraticCurveTo(-4, 0.4, -9, up)
    g.fill()
    g.beginPath()
    g.ellipse(0.5, 0.6, 3.2, 1.3, 0, 0, 7)
    g.fill()
    disc(g, 3.6, 0.1, 1.1)
  })
}

function metalBird(g: G, x: number, y: number, s: number, face: number, flap: number): void {
  withT(g, x, y, s, face, 0, () => {
    const up = -6 + flap * 12
    g.fillStyle = INK
    // Wings: straight leading edges root → tip, a trailing edge a chord behind them (thinning to the tip) with a notch
    // cut in it — built along the span, so the shape holds at every wing position.
    const lead = (t: number): number => -1.2 + t * (up + 1.2)
    const trail = (t: number): number => lead(t) + 2.8 * (1 - t) + 0.5
    for (const side of [-1, 1]) {
      const at = (t: number): number => side * (1.5 + t * 8.5)
      g.beginPath()
      g.moveTo(at(0), lead(0))
      g.lineTo(at(1), lead(1))
      g.lineTo(at(0.62), trail(0.62))
      g.lineTo(at(0.45), trail(0.45) - 1.1)
      g.lineTo(at(0.3), trail(0.3))
      g.lineTo(at(0), trail(0))
      g.closePath()
      g.fill()
    }
    // Fuselage: a long box with a pointed nose (+x) and a fin up at the tail.
    g.beginPath()
    g.moveTo(-5.5, -0.9)
    g.lineTo(3.5, -1.1)
    g.lineTo(6.2, 0.2)
    g.lineTo(3.5, 1.4)
    g.lineTo(-5.5, 1.2)
    g.closePath()
    g.fill()
    g.beginPath()
    g.moveTo(-5.5, -0.8)
    g.lineTo(-7.2, -4)
    g.lineTo(-4.2, -0.8)
    g.closePath()
    g.fill()
  })
}

export function turret(g: G, x: number, y: number, { s = 1, face = 1, aim = 0.2, muzzle = false } = {}): void {
  withT(g, x, y, s, face, 0, () => {
    line(g, [[-16, 0], [16, 0]], 2.4)
    for (const fx of [-11, 11, 1]) line(g, [[fx, -1], [0, -14]], 1.4)
    g.save()
    g.translate(0, -17)
    g.rotate(-aim)
    g.fillStyle = INK
    g.beginPath()
    g.roundRect(-7, -4.5, 13, 8, 2)
    g.fill()
    line(g, [[5, -1.6], [17, -1.6]], 1.4)
    line(g, [[5, 1.6], [17, 1.6]], 1.4)
    if (muzzle) {
      glow(g, 19, 0, 10, '255,190,60', 0.9)
      disc(g, 18.5, 0, 1.8, '#fff3c0')
    }
    g.restore()
  })
}

/** Stepped stone ring with a haze window. */
export function gate(g: G, x: number, y: number, { s = 1, accent = '#e0b050', inner = 'rgba(245,240,232,0.92)' } = {}): void {
  withT(g, x, y, s, 1, 0, () => {
    g.fillStyle = inner
    g.beginPath()
    g.arc(0, -18, 13, 0, 7)
    g.fill()
    g.strokeStyle = accent
    g.lineWidth = 1
    g.globalAlpha = 0.9
    g.beginPath()
    g.arc(0, -18, 11, 0, 7)
    g.stroke()
    g.globalAlpha = 1
    g.fillStyle = INK
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2
      g.save()
      g.translate(Math.cos(a) * 16, -18 + Math.sin(a) * 16)
      g.rotate(a)
      g.fillRect(-2.2, -3.2, 4.4, 6.4)
      g.restore()
    }
    g.fillRect(-9, -2, 18, 2.5)
  })
}

/** The mockup's Park–Miller generator (`e_style.js` crystals/smoke/explosion). */
function lcg(seed: number): () => number {
  let q = seed
  return () => (q = (q * 16807) % 2147483647) / 2147483647
}

export function crystals(g: G, x: number, y: number, { s = 1, glowRGB = '120,190,255', n = 5, seed = 3 } = {}): void {
  const rnd = lcg(seed)
  if (extras) glow(g, x, y - 8 * s, 22 * s, glowRGB, 0.35)
  withT(g, x, y, s, 1, 0, () => {
    for (let i = 0; i < n; i++) {
      const bx = (rnd() - 0.5) * 12
      const h = 10 + rnd() * 16 * (i === 0 ? 1.4 : 1)
      const w = 1.6 + rnd() * 1.6
      const lean = (rnd() - 0.5) * 0.6 + bx * 0.03
      g.save()
      g.translate(bx, 0)
      g.rotate(lean)
      g.fillStyle = INK
      g.beginPath()
      g.moveTo(-w, 0)
      g.lineTo(-w, -h * 0.75)
      g.lineTo(0, -h)
      g.lineTo(w, -h * 0.75)
      g.lineTo(w, 0)
      g.fill()
      if (extras) {
        g.strokeStyle = `rgba(${glowRGB},0.9)`
        g.lineWidth = 0.7
        g.beginPath()
        g.moveTo(w * 0.3, -1)
        g.lineTo(w * 0.3, -h * 0.7)
        g.stroke()
      }
      g.restore()
    }
  })
}

/**
 * T24.01 task 4: **the alien cow** (`tasks/parking-lot/refs/alien-cow-ref.jpg`, the owner's words): a stick-figure
 * alien grazer in F's ink — a fat cow body on short thick legs, a long giraffe neck, a small head with **spikes all
 * round it**, two little horns, red eyes (the one fixed colour, like the spider's). Feet on y 0, facing +x, world px
 * at `s` 1 (the body is `COW_W` wide). Animated in quantised steps (one atlas cell each): `gait` the walk, `chew`
 * the jaw (0 shut … 1 open), `sleep` the head laid down by the forelegs with its eyes shut, and `tongue` — a long pink
 * tongue from the mouth to `tongue.to` (px from the mouth), out by `tongue.out` (0–1) and curled by `tongue.curl`
 * (−1…1, its random pattern) — when it eats from a tree.
 */
export function cow(
  g: G,
  x: number,
  y: number,
  { s = 1, face = 1, gait = 0, chew = 0, sleep = false, tongue = null as { to: P; out: number; curl: number } | null, eye = '#ff3a2a' } = {},
): void {
  withT(g, x, y, s, face, 0, () => {
    g.lineCap = 'round'
    g.lineJoin = 'round'
    // Legs: short and thick, a walk's alternate pairs swinging.
    const sw = (ph: number): number => 3 * Math.sin(ph * Math.PI * 2)
    for (const [hx, ph] of [[-10, 0], [-6, 0.5], [7, 0.5], [11, 0]] as const) {
      const k = sleep ? 0 : sw(gait + ph)
      line(g, [[hx, -9], [hx + k * 0.4, -4], [hx + k, 0]], 3.2)
    }
    // The body: a fat barrel, a little high at the shoulders.
    g.fillStyle = INK
    g.beginPath()
    g.ellipse(0, -13, 16, 8.5, -0.05, 0, Math.PI * 2)
    g.fill()
    // A short whip of a tail.
    line(g, [[-15, -15], [-20, -12], [-21, -6]], 1.4)
    // Neck and head: raised high (grazing from a tree), or laid down asleep.
    const shoulder: P = [11, -17]
    const head: P = sleep ? [24, -6] : [22, -42]
    const mid: P = sleep ? [20, -16] : [19, -28]
    line(g, [shoulder, mid, head], 4.6)
    g.save()
    g.translate(...head)
    g.rotate(sleep ? 0.35 : -0.15)
    // Spikes all round the head (the owner's "spikes all around it"), longer on top.
    for (let k = 0; k < 11; k++) {
      const a = (k / 11) * Math.PI * 2
      const len = 3 + (Math.sin(a) < 0 ? 2.2 * -Math.sin(a) : 0.8)
      const [c, n] = [Math.cos(a), Math.sin(a)]
      g.fillStyle = INK
      g.beginPath()
      g.moveTo(c * 3.6 - n * 1.1, n * 3 + c * 1.1)
      g.lineTo(c * (4.4 + len), n * (3.6 + len))
      g.lineTo(c * 3.6 + n * 1.1, n * 3 - c * 1.1)
      g.closePath()
      g.fill()
    }
    // Two little horns over the brow.
    line(g, [[-1, -3.5], [-2.5, -9]], 1.3)
    line(g, [[2, -3.5], [3, -9.5]], 1.3)
    // The head and its jaw: the snout forward, the jaw dropping with `chew`.
    g.fillStyle = INK
    g.beginPath()
    g.ellipse(0.5, 0, 4.6, 3.6, 0, 0, Math.PI * 2)
    g.fill()
    g.beginPath()
    g.ellipse(5, -0.6, 3.2, 2, 0, 0, Math.PI * 2)
    g.fill()
    const jaw = sleep ? 0 : chew
    g.save()
    g.translate(2.5, 1.6)
    g.rotate(0.55 * jaw)
    g.beginPath()
    g.ellipse(3, 0.6, 3.4, 1.3, 0, 0, Math.PI * 2)
    g.fill()
    g.restore()
    if (extras) {
      if (sleep) line(g, [[1.2, -1.4], [3.2, -1.2]], 0.7, eye)
      else disc(g, 2.2, -1.4, 0.85, eye)
    }
    g.restore()
    // The tongue: from the mouth toward the tree, out by `out`, curling side to side by `curl` (pink, fixed colour).
    if (tongue && !sleep && extras && tongue.out > 0) {
      const mouth: P = [head[0] + 7, head[1] + 1.5]
      const [tx, ty] = tongue.to
      const end: P = [mouth[0] + tx * tongue.out, mouth[1] + ty * tongue.out]
      const len = Math.hypot(end[0] - mouth[0], end[1] - mouth[1]) || 1
      const nx = -(end[1] - mouth[1]) / len
      const ny = (end[0] - mouth[0]) / len
      const bend = tongue.curl * Math.min(18, len * 0.45)
      const c1: P = [mouth[0] + (end[0] - mouth[0]) * 0.5 + nx * bend, mouth[1] + (end[1] - mouth[1]) * 0.5 + ny * bend]
      g.strokeStyle = '#ff6fa8'
      g.lineWidth = 2
      g.beginPath()
      g.moveTo(...mouth)
      g.quadraticCurveTo(...c1, ...end)
      g.stroke()
      // The curled tip, wrapping the fruit or leaf it reaches.
      g.lineWidth = 1.4
      g.beginPath()
      g.arc(end[0] + nx * 1.6 * Math.sign(tongue.curl || 1), end[1] + ny * 1.6 * Math.sign(tongue.curl || 1), 2.2, 0, Math.PI * 1.5)
      g.stroke()
    }
  })
}

/**
 * T24.01: **the durian tree** (`tasks/parking-lot/refs/durianbombtree.jpg`) in F's ink — a gnarled trunk on a flare of
 * roots, boughs forking out to spiky leaf clusters, and three low branches that hang the fruit (`durianTree.ts`'s
 * `FRUIT_AT`, world px from the trunk's foot, which the server's `map::durian::FRUIT_AT` places the items at).
 * Drawn about its foot at (x, y), `DURIAN_TREE_H` tall at `s` 1 (units are world px), mirrored by `face`.
 * `seed` jitters the leaves so two trees are not stamps of one. No fixed-colour parts: the rim passes light it.
 */
export function durianTree(g: G, x: number, y: number, { s = 1, face = 1, seed = 7, fruit = [] as readonly P[] } = {}): void {
  const rnd = lcg(seed * 7919 + 13)
  withT(g, x, y, s, face, 0, () => {
    g.lineCap = 'round'
    g.lineJoin = 'round'
    const stroke = (pts: P[], w: number): void => {
      g.strokeStyle = INK
      g.lineWidth = w
      g.beginPath()
      g.moveTo(...pts[0]!)
      for (let k = 1; k + 1 < pts.length; k += 2) g.quadraticCurveTo(...pts[k]!, ...pts[k + 1]!)
      g.stroke()
    }
    // Roots: a wide flare of gnarled strokes over the ground line, the sheet's knotted foot.
    for (const [ex, ey, w] of [[-34, 4, 4.5], [-22, 5, 3.6], [-10, 6, 3], [12, 6, 3.2], [24, 5, 3.8], [36, 3, 4.2]] as const) {
      stroke([[ex * 0.1, -12], [ex * 0.45, -6 + rnd() * 3], [ex, ey]], w)
    }
    // The trunk: thick and twisted, 24 wide at the foot to 10 at the fork, leaning as it rises.
    g.fillStyle = INK
    g.beginPath()
    g.moveTo(-12, 3)
    g.quadraticCurveTo(-15, -14, -7, -28)
    g.quadraticCurveTo(-1, -42, -9, -58)
    g.lineTo(-6, -72)
    g.lineTo(5, -72)
    g.quadraticCurveTo(7, -56, 4, -44)
    g.quadraticCurveTo(14, -22, 12, 3)
    g.closePath()
    g.fill()
    // A knot and a split in the bark read in the rim light as a gnarled trunk, not a pole.
    disc(g, -9, -30, 4.2)
    disc(g, 8, -14, 3.6)
    // Boughs from the fork, each forking again to the crown's clusters (two levels, as the sheet's tree).
    const crown: [number, number, number][] = []
    const boughs: [number, number][] = [[-56, -104], [-30, -128], [2, -140], [32, -126], [58, -100]]
    for (const [bx, by] of boughs) {
      const from: P = [bx < 0 ? -3 : 2, -70]
      const mid: P = [bx * 0.55, by * 0.72 - 4]
      stroke([from, [bx * 0.2, by * 0.55 - 6], mid], 5.2 - Math.abs(bx) / 30)
      for (const side of [-1, 1]) {
        const tip: P = [bx + side * (10 + rnd() * 8), by + (rnd() - 0.6) * 14]
        stroke([mid, [(mid[0] + tip[0]) / 2 + side * 3, (mid[1] + tip[1]) / 2 - 4], tip], 2.6)
        crown.push([tip[0], tip[1], 12 + rnd() * 5])
      }
    }
    // Two low limbs reaching out sideways, clustered at their ends.
    for (const side of [-1, 1]) {
      const tip: P = [side * 66, -66 - rnd() * 8]
      stroke([[side * 4, -58], [side * 36, -70], tip], 3.6)
      crown.push([tip[0], tip[1], 11 + rnd() * 3])
    }
    // The fruit's branches: drooping from the low trunk, ending over each fruit, with a stalk down to it.
    for (const [fx, fy] of fruit) {
      const tip: P = [fx * 1.04, fy - 11]
      stroke([[fx < 0 ? -4 : 4, -50], [fx * 0.6, fy - 22], tip], 2.6)
      line(g, [tip, [fx, fy - 6]], 1.2)
    }
    // Leaf clusters: dense spiky bunches — two rings of long pointed leaves, the sheet's loose cluster sprites.
    for (const [cx, cy, r] of crown) {
      for (const ring of [1, 0.62]) {
        const n = ring === 1 ? 13 : 9
        const turn = rnd() * 6.283
        for (let k = 0; k < n; k++) {
          const a = turn + (k / n) * Math.PI * 2 + (rnd() - 0.5) * 0.35
          const len = r * ring * (0.8 + rnd() * 0.45)
          const w = r * 0.2
          g.save()
          g.translate(cx, cy)
          g.rotate(a)
          g.fillStyle = INK
          g.beginPath()
          g.moveTo(0, -w)
          g.quadraticCurveTo(len * 0.55, -w * 1.2, len, 0)
          g.quadraticCurveTo(len * 0.55, w * 1.2, 0, w)
          g.closePath()
          g.fill()
          g.restore()
        }
      }
      disc(g, cx, cy, r * 0.45)
    }
  })
}

export function rocket(g: G, x: number, y: number, ang: number, { s = 1 } = {}): void {
  withT(g, x, y, s, 1, -ang, () => {
    if (extras) {
      glow(g, -7, 0, 9, '255,150,40', 0.9)
      disc(g, -6.5, 0, 1.6, '#fff0c0')
    }
    g.fillStyle = INK
    g.beginPath()
    g.roundRect(-6, -1.6, 10, 3.2, 1.2)
    g.fill()
    g.beginPath()
    g.moveTo(4, -1.6)
    g.lineTo(7.5, 0)
    g.lineTo(4, 1.6)
    g.fill()
    g.beginPath()
    g.moveTo(-6, -1.6)
    g.lineTo(-8, -3.6)
    g.lineTo(-4, -1.6)
    g.fill()
    g.beginPath()
    g.moveTo(-6, 1.6)
    g.lineTo(-8, 3.6)
    g.lineTo(-4, 1.6)
    g.fill()
  })
}

/** Soft, painterly smoke puffs along a path (darker than a pale sky). Drawn unlit. */
export function smoke(g: G, pts: P[], { rgb = '70,58,48', a = 0.16, size = 7, grow = 2.2, seed = 5 } = {}): void {
  const rnd = lcg(seed)
  pts.forEach((p, i) => {
    const t = i / (pts.length - 1)
    const r = size * (1 + (1 - t) * grow)
    const gr = g.createRadialGradient(p[0], p[1] - (1 - t) * 6, 0, p[0], p[1] - (1 - t) * 6, r)
    gr.addColorStop(0, `rgba(${rgb},${a * (0.3 + 0.7 * t)})`)
    gr.addColorStop(1, `rgba(${rgb},0)`)
    g.fillStyle = gr
    g.beginPath()
    g.arc(p[0] + (rnd() - 0.5) * 3, p[1] - (1 - t) * 6, r, 0, 7)
    g.fill()
  })
}

// --- T23.19: the world's furniture in F's vocabulary (ink, rim-lit, one accent at most) ---------------------------

/** A grave: one ink headstone in a low mound (R8), feet at (x, y); 10 × 16 at `s` 1 (`GRAVE_ART` in furniture.ts). */
export function grave(g: G, x: number, y: number, { s = 1 } = {}): void {
  withT(g, x, y, s, 1, 0, () => {
    g.fillStyle = INK
    g.beginPath()
    g.moveTo(-5, -1)
    g.lineTo(-5, -11)
    g.arc(0, -11, 5, Math.PI, 0)
    g.lineTo(5, -1)
    g.closePath()
    g.fill()
    g.beginPath()
    g.ellipse(0, 0, 8, 2.4, 0, Math.PI, 0)
    g.closePath()
    g.fill()
  })
}

/**
 * T23.19: a non-weapon pickup by its registry sprite (`ItemDef.sprite`), centred on (x, y), ~16 units across at `s` 1.
 * Silhouette first (they must differ in outline at pickup size, as the painted icons did), `accent` for its one mark.
 */
export function item(g: G, x: number, y: number, { s = 1, key = '', accent = '#e8482c' } = {}): void {
  withT(g, x, y, s, 1, 0, () => {
    g.fillStyle = INK
    const box = (x0: number, y0: number, w: number, h: number, col: string): void => {
      g.fillStyle = col
      g.fillRect(x0, y0, w, h)
    }
    switch (key) {
      case 'item_medkit':
        box(-6.5, -4.5, 13, 9, INK)
        box(-2, -7, 4, 2.5, INK)
        box(-1, -3, 2, 6, accent)
        box(-3, -1, 6, 2, accent)
        return
      case 'item_shield':
        g.beginPath()
        g.moveTo(-6, -6)
        g.lineTo(6, -6)
        g.lineTo(5, 1)
        g.lineTo(0, 7)
        g.lineTo(-5, 1)
        g.closePath()
        g.fill()
        line(g, [[0, -4], [0, 4]], 1.2, accent)
        return
      case 'item_flashlight':
        box(-7, -2, 9, 4, INK)
        g.beginPath()
        g.moveTo(2, -2)
        g.lineTo(6, -4)
        g.lineTo(6, 4)
        g.lineTo(2, 2)
        g.closePath()
        g.fill()
        box(6, -3, 1.2, 6, accent)
        return
      case 'item_battery':
        box(-6, -4.5, 11, 9, INK)
        box(5, -2, 2, 4, INK)
        box(-4.5, -3, 5, 6, accent)
        return
      case 'item_vampire_fangs':
        box(-6, -6, 12, 4, INK)
        for (const fx of [-3, 3]) {
          g.fillStyle = INK
          g.beginPath()
          g.moveTo(fx - 2, -2.5)
          g.lineTo(fx + 2, -2.5)
          g.lineTo(fx, 6)
          g.closePath()
          g.fill()
        }
        disc(g, 3, 7.4, 0.9, accent)
        return
      case 'item_ironman_boots':
        box(-5, -6, 8, 8, INK)
        box(-7, 2, 14, 3.5, INK)
        box(-7, 5, 14, 1, accent)
        return
      case 'item_unicorn_wings':
        for (const d of [-1, 1]) {
          g.fillStyle = INK
          g.beginPath()
          g.moveTo(0, 5)
          g.quadraticCurveTo(d * 4, -2, d * 8, -6)
          g.lineTo(d * 7, 4)
          g.closePath()
          g.fill()
        }
        disc(g, 0, -1, 1.4, accent)
        return
      default:
        box(-5, -5, 10, 10, INK)
    }
  })
}

