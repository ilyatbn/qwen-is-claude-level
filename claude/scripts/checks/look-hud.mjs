/**
 * `look-hud` — T23.21B: the look-lab's HUD at Level A against the mockup's (`M23-art.md` § Verification).
 *
 * ## What is compared
 *
 * `?look=F1&only=hud` draws the **game's own** HUD classes (`ui/labHud.ts`: the `Hud` timer, `Bars`, the quick bar)
 * fed F1's `hudE` values, alone on black. The reference is **`e_style.js::hudE` itself** — its source read out of
 * `reference/mockup-src/e_style.js` and evaluated verbatim in this same page, with F1's arguments (the scene data's
 * `hud`, `f_scene.js`'s call), on the same black, after the lab's HUD is hidden. Same browser, same fonts: the mockup's
 * `Georgia, serif` is this Chromium's default serif, Liberation Serif — the face `assets/fonts/liberation-serif.ttf`
 * bundles (`ui/hudStyle.ts` has the measurement).
 *
 * Per text element (the timer; the HP/EN/JET captions), the two screenshots are cropped **aligned on each one's ink
 * box** (pixels brighter than `INK_L` in a window around the element), and the crop's mean |Δ| per channel is the
 * metric. Where each sits is a separate table: the ink box's offset, lab − mockup.
 *
 * ## Thresholds — measured, and both numbers printed
 *
 * Floor: `hudE` drawn twice. Must-fail controls, each applied to the lab's **live** elements: the face falling back
 * (`monospace`), the ink at full white, the letter-spacing gone. Each element's threshold is the midpoint of its
 * floor and its smallest control; a control that does not clear its floor fails the check (it could not see it).
 *
 * ## Named exceptions — where the game differs by design (measured, reported, not gated)
 *
 * - `bars.y`: the bars sit above `#game-hud`, the full-width strip at the bottom (`bars.ts`: bottom 56 vs `hudE`'s 24).
 * - `fills`: the bar fills keep their state colours (`bars-math.ts`: health's ramp/poison/overheal, the jet's refilling
 *   and refused) where `hudE` draws HP in the accent and EN/JET in ink — and the number after each track is kept.
 * - `strip`: the quick bar's slots are 46 px tiles carrying the item art and counts, `QUICK_SLOTS` of them, where
 *   `hudE` draws seven 34×22 text labels.
 * The timer's position is gated (±`POS_TOL` px), and so is each caption's x.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const { PNG } = createRequire(join(root, 'client/package.json'))('pngjs')

/** A pixel is ink when its luminance (0–255) is above this — the background is black. */
const INK_L = 40
/** Pad around an ink box when cropping, px. */
const PAD = 2
/** Gated positions: the ink box may sit this many px from the mockup's. */
const POS_TOL = 1
const LAB_HUD = ['#hud-timer', '#hud-banner', '#hud-bars', '#inventory']

/** `export function hudE(…) {…}` out of the mockup's source, as text (it ends at the first `}` at column 0). */
function hudESource() {
  const src = readFileSync(join(root, 'tasks/M23/reference/mockup-src/e_style.js'), 'utf8')
  const start = src.indexOf('export function hudE(')
  const end = src.indexOf('\n}\n', start)
  if (start < 0 || end < 0) throw new Error('hudE not found in e_style.js')
  return src.slice(start + 'export '.length, end + 2)
}

/** F1's `hud` from the lab's scene data (what `f_scene.js` passes `hudE`). */
function sceneHud() {
  const text = readFileSync(join(root, 'client/src/look/scenes/F1.ts'), 'utf8')
  const m = /"hud": (\{[^}]*\})/.exec(text)
  if (!m) throw new Error('F1.ts has no hud')
  return JSON.parse(m[1])
}

const grab = async (page) => {
  const p = PNG.sync.read(await page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 720 } }))
  return { w: p.width, h: p.height, d: p.data }
}
const lum = (img, x, y) => {
  const i = (y * img.w + x) * 4
  return 0.2126 * img.d[i] + 0.7152 * img.d[i + 1] + 0.0722 * img.d[i + 2]
}

/** The ink box inside window `[x0, y0, x1, y1]`, or null if there is no ink. */
function inkBox(img, [x0, y0, x1, y1]) {
  let b = null
  for (let y = Math.max(0, y0); y < Math.min(img.h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.w, x1); x++) {
      if (lum(img, x, y) <= INK_L) continue
      if (!b) b = [x, y, x + 1, y + 1]
      else b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x + 1), Math.max(b[3], y + 1)]
    }
  }
  return b
}

/** Mean |Δ| per channel over the union of two ink boxes' sizes, each image cropped at its own box. */
function cropDelta(a, ba, b, bb) {
  const w = Math.max(ba[2] - ba[0], bb[2] - bb[0]) + 2 * PAD
  const h = Math.max(ba[3] - ba[1], bb[3] - bb[1]) + 2 * PAD
  let sum = 0
  const px = (img, x, y, c) => (x >= 0 && y >= 0 && x < img.w && y < img.h ? img.d[(y * img.w + x) * 4 + c] : 0)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) sum += Math.abs(px(a, ba[0] - PAD + x, ba[1] - PAD + y, c) - px(b, bb[0] - PAD + x, bb[1] - PAD + y, c))
    }
  }
  return sum / (w * h * 3)
}

export default async function ({ page, shot, log }) {
  const problems = []
  await page.waitForFunction(() => window.__look && (window.__look.hud || window.__look.error), null, { timeout: 60_000 })
  const look = await page.evaluate(() => ({ error: window.__look.error, hud: window.__look.hud }))
  if (look.error) throw new Error(`look-lab: ${look.error}`)

  /** Each element's search window, from the DOM (lab) or hudE's tree (reference), grown by a few px. */
  const labWindows = () =>
    page.evaluate(() => {
      const r = (el, g = 4) => {
        const b = el.getBoundingClientRect()
        return [Math.floor(b.left) - g, Math.floor(b.top) - g, Math.ceil(b.right) + g, Math.ceil(b.bottom) + g]
      }
      const rows = [...document.querySelectorAll('#hud-bars > div')].slice(0, 3)
      return { timer: r(document.getElementById('hud-timer')), HP: r(rows[0].children[0]), EN: r(rows[1].children[0]), JET: r(rows[2].children[0]) }
    })

  // ------------------------------------------------------------------ the lab's HUD, and the controls on it
  const labWin = await labWindows()
  const lab = await grab(page)
  await shot('look-hud-lab')
  const controls = {}
  const CONTROLS = {
    'font-fallback': 'fontFamily="monospace"',
    'ink-white': 'color="#ffffff";s.opacity="1"',
    'letter-spacing-0': 'letterSpacing="0"',
  }
  for (const [name, set] of Object.entries(CONTROLS)) {
    await page.evaluate((set) => {
      const els = [document.getElementById('hud-timer'), ...[...document.querySelectorAll('#hud-bars > div')].slice(0, 3).map((r) => r.children[0])]
      for (const el of els) {
        el.dataset.saved = el.style.cssText
        new Function('s', `s.${set}`)(el.style)
      }
    }, set)
    controls[name] = { win: await labWindows(), img: await grab(page) }
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('[data-saved]')) {
        el.style.cssText = el.dataset.saved
        delete el.dataset.saved
      }
    })
  }

  // ------------------------------------------------------------------ the mockup's hudE, twice (the floor)
  await page.evaluate((ids) => ids.forEach((s) => document.querySelector(s)?.style.setProperty('visibility', 'hidden')), LAB_HUD)
  const drawRef = (args) =>
    page.evaluate(
      ({ src, args }) => {
        document.getElementById('look-hud-ref')?.remove()
        const before = new Set(document.body.children)
        new Function('W', 'H', `${src}\nreturn hudE`)(1280, 720)(args)
        const d = [...document.body.children].find((c) => !before.has(c))
        d.id = 'look-hud-ref'
        d.style.zIndex = '50'
        const r = (el, g = 4) => {
          const b = el.getBoundingClientRect()
          return [Math.floor(b.left) - g, Math.floor(b.top) - g, Math.ceil(b.right) + g, Math.ceil(b.bottom) + g]
        }
        const rows = [...d.children[1].children]
        return { timer: r(d.children[0]), HP: r(rows[0].children[0]), EN: r(rows[1].children[0]), JET: r(rows[2].children[0]) }
      },
      { src: hudESource(), args },
    )
  const hud = sceneHud()
  const refWin = await drawRef(hud)
  await page.evaluate(() => document.fonts.ready)
  const ref = await grab(page)
  await shot('look-hud-mockup')
  await drawRef(hud)
  const ref2 = await grab(page)

  // ------------------------------------------------------------------ per element
  log(`look-hud: the lab's HUD (game classes, F1's hudE values) vs e_style.js::hudE(${JSON.stringify(hud)}), both on black`)
  log(`  element  lab      floor    smallest control (name)         threshold  dx   dy`)
  for (const k of ['timer', 'HP', 'EN', 'JET']) {
    const bRef = inkBox(ref, refWin[k])
    const bRef2 = inkBox(ref2, refWin[k])
    const bLab = inkBox(lab, labWin[k])
    if (!bRef || !bRef2 || !bLab) {
      problems.push(`${k}: no ink (mockup ${JSON.stringify(bRef)}, lab ${JSON.stringify(bLab)}) — nothing drawn there`)
      continue
    }
    const floor = cropDelta(ref, bRef, ref2, bRef2)
    const ctl = Object.entries(controls).map(([name, c]) => {
      const b = inkBox(c.img, c.win[k])
      return [name, b ? cropDelta(c.img, b, ref, bRef) : Infinity]
    })
    const [minName, minCtl] = ctl.reduce((m, x) => (x[1] < m[1] ? x : m))
    const threshold = (floor + minCtl) / 2
    const d = cropDelta(lab, bLab, ref, bRef)
    const [dx, dy] = [bLab[0] - bRef[0], bLab[1] - bRef[1]]
    log(`  ${k.padEnd(7)} ${d.toFixed(3).padStart(7)} ${floor.toFixed(3).padStart(7)}  ${minCtl.toFixed(3).padStart(7)} (${minName})`.padEnd(58) + `${threshold.toFixed(3).padStart(8)}  ${String(dx).padStart(3)}  ${String(dy).padStart(3)}`)
    for (const [name, v] of ctl) if (!(v > floor)) problems.push(`${k}: control ${name} (${v.toFixed(3)}) does not clear the floor ${floor.toFixed(3)} — the compare cannot see it`)
    if (!(d < threshold)) problems.push(`${k}: lab vs hudE ${d.toFixed(3)} ≥ threshold ${threshold.toFixed(3)} (floor ${floor.toFixed(3)}, ${minName} ${minCtl.toFixed(3)})`)
    if (Math.abs(dx) > POS_TOL) problems.push(`${k}: ink box ${dx} px off the mockup's in x (tolerance ${POS_TOL})`)
    if (k === 'timer' && Math.abs(dy) > POS_TOL) problems.push(`timer: ink box ${dy} px off the mockup's in y (tolerance ${POS_TOL})`)
  }

  // ------------------------------------------------------------------ the named exceptions, measured
  const geo = await page.evaluate(() => {
    const d = document.getElementById('look-hud-ref')
    const rect = (el) => {
      const b = el.getBoundingClientRect()
      return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }
    }
    const refTrack = rect(d.children[1].children[0].children[1])
    const refSlot = rect(d.children[2].children[0])
    const labTrack = rect(document.getElementById('hud-bar-health'))
    const tiles = [...document.querySelectorAll('#inventory-bar > div')]
    return { refTrack, labTrack, refSlot, labSlot: rect(tiles[0]), labSlots: tiles.length, refSlots: d.children[2].children.length, fill: getComputedStyle(document.querySelector('#hud-bar-health > div')).backgroundColor }
  })
  log(`  named exceptions (by design, not gated):`)
  log(`    bars.y   HP track at y ${geo.labTrack.y} vs hudE ${geo.refTrack.y} (${geo.labTrack.y - geo.refTrack.y} px: above #game-hud); x ${geo.labTrack.x} vs ${geo.refTrack.x}, ${geo.labTrack.w}x${geo.labTrack.h} vs ${geo.refTrack.w}x${geo.refTrack.h}`)
  log(`    fills    HP fill ${geo.fill} (bars-math's state colour) vs hudE's accent ${hud.accent}`)
  log(`    strip    ${geo.labSlots} tiles ${geo.labSlot.w}x${geo.labSlot.h} (item art + count) vs hudE's ${geo.refSlots} labels ${geo.refSlot.w}x${geo.refSlot.h}`)
  if (geo.labTrack.x !== geo.refTrack.x || geo.labTrack.w !== geo.refTrack.w) problems.push(`the HP track is ${geo.labTrack.w} px at x ${geo.labTrack.x}, hudE's ${geo.refTrack.w} px at x ${geo.refTrack.x}`)

  if (problems.length) throw new Error(`look-hud:\n  ${problems.join('\n  ')}`)
  log('look-hud: every HUD text element matches hudE within its measured threshold; every control fails')
}
