// T23.01 step 2: writes F1–F5 as data modules by **running the mockup's own scene code**
// (`tasks/M23/reference/mockup-src`) with its drawing layer replaced by recorders.
//
//   node client/src/look/scenes/dump-mockup.mjs      (plain node, no browser, no npm install)
//
// What runs for real: `world.js` (buildMask/derive/groundAt), `maps.js`, `f_scene.js` and
// `variant_F*.js` — so every position, light and palette value is the mockup's own number,
// not a transcription. What is replaced, in a temp copy only (the reference is never edited):
// `f_kit.js` (frame/lit), `e_style.js` (the 2D cast), `kit.js` (fx) and `three` (Color) by
// recorders; `kit.js::wy` becomes the identity so fx coordinates stay in mask px, y down.
// Two one-line patches: `combatF` stores its `P`, and `derive` stores its theme name.
// Output: `<id>.ts` per scene and `<map>.mask.ts` per map (solid/back as runs from 0).

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '../../../../tasks/M23/reference/mockup-src')
const tmp = mkdtempSync(join(tmpdir(), 'look-dump-'))
cpSync(src, tmp, { recursive: true })
// The mockup's package.json says commonjs (the browser never read it); node must see ES modules.
writeFileSync(join(tmp, 'package.json'), '{"type":"module"}')

const patch = (file, from, to) => {
  const p = join(tmp, file), s = readFileSync(p, 'utf8')
  if (!s.includes(from)) throw new Error(`${file}: patch anchor missing: ${from}`)
  writeFileSync(p, s.replace(from, to))
}
patch('f_scene.js', 'export function combatF(P) {', 'export let lastP = null\nexport const resetP = () => { lastP = null }\nexport function combatF(P) { lastP = P')
patch('world.js', 'return { ...m, dIn, dOut, albedo, relief }', 'return { ...m, dIn, dOut, albedo, relief, theme: themeName }')

// ---- recorders ------------------------------------------------------------
const REC = `export const rec = { frame: null, actors: [], fx: [], labels: [], hud: null, moon: null, lit: null, glows: null }
export function reset() { Object.assign(rec, { frame: null, actors: [], fx: [], labels: [], hud: null, moon: null, lit: null, glows: null }) }
`
writeFileSync(join(tmp, 'rec.js'), REC)
mkdirSync(join(tmp, 'node_modules/three'), { recursive: true })
writeFileSync(join(tmp, 'node_modules/three/package.json'), '{"name":"three","type":"module","main":"index.js"}')
writeFileSync(join(tmp, 'node_modules/three/index.js'), 'export class Color { constructor(r, g, b) { this.rgb = [r, g, b] } }\n')
writeFileSync(join(tmp, 'kit.js'), `export const wy = y => y
export const softTex = () => 'soft'
export const smokeTrail = () => { throw new Error('smokeTrail is imported by f_scene.js but never called') }
export function sprite(tex, x, y, z, size, color, opacity = 1, additive = false) { return { kind: 'sprite', tex, x, y, z, size, color: color.rgb, alpha: opacity, additive } }
export function ribbon(pts, width, core, glow, { z = 40, fadePow = 1.5, headBoost = 1 } = {}) { return { kind: 'ribbon', pts, width, core, glow, z, fadePow, headBoost } }
export function explosion(x, y, s = 1, { smoke = 0x2a2522, z = 60 } = {}) { return { kind: 'explosion', x, y, scale: s, smoke, z } }
`)
writeFileSync(join(tmp, 'f_kit.js'), `import { rec } from './rec.js'
export function frame(o) {
  rec.frame = o
  const g = fakeG(); o.draw2d(g)
  const fx = { add: f => rec.fx.push(f) }; o.fx3d?.(fx)
}
export function lit(g, lights, moon, x, y, draw, opts = {}) {
  rec.moon ??= moon
  rec.lit = { size: opts.size ?? 1, halo: opts.halo ?? null, shadow: opts.shadow ?? true }
  rec.litAt = [x, y]
  draw(g, 0, 0, null) // the ink pass: the actor exactly as it is, no rim offset
  rec.lit = null
}
function fakeG() {
  const store = {}
  // T23.16: F6 draws each weapon alone under a translate + scale (\`gg.translate(x0, y0); gg.scale(K, K); Wd.draw(gg, …)\`),
  // so the transform is tracked and a weapon's draw (weapons.js, patched below) records where it landed.
  const st = { tx: 0, ty: 0, s: 1, stack: [] }
  const ops = {
    fillText: (t) => (text, x, y) => rec.labels.push({ text, x, y, font: t.font, fill: t.fillStyle, align: t.textAlign }),
    save: () => () => st.stack.push([st.tx, st.ty, st.s]),
    restore: () => () => { const p = st.stack.pop(); if (p) [st.tx, st.ty, st.s] = p },
    translate: () => (x, y) => { st.tx += x * st.s; st.ty += y * st.s },
    scale: () => (a, b) => { if (a !== b) throw new Error('fakeG: anisotropic scale'); st.s *= a },
    // Only inside lit(): a weapon drawn bare on the page is a prop or an effect (F7's thrown grenade and dropped smg,
    // which posesonly.js leaves out), not an actor — as before weapons were recorded.
    // The actor stands where lit() was called (its light is probed there); the weapon's origin is an offset from it.
    __weapon: () => (key, accent) => {
      if (!rec.lit) return
      const [x, y] = rec.litAt
      rec.actors.push({ kind: 'weapon', x, y, opts: { key, s: st.s, accent, origin: [st.tx - x, st.ty - y] }, lit: rec.lit })
    },
  }
  return new Proxy(store, {
    get: (t, k) => (k in ops ? ops[k](t) : k in t ? t[k] : () => {}),
    set: (t, k, v) => { t[k] = v; return true },
  })
}
`)
writeFileSync(join(tmp, 'e_style.js'), `import { rec } from './rec.js'
const put = (kind, x, y, o = {}) => {
  const opts = { ...o }
  // T23.16: F6's 1× row holds \`weapons.js::held(k, accent)\` (patched below to say which): recorded as \`held\`.
  if (opts.weapon && typeof opts.weapon === 'object') { opts.held = opts.weapon.held; opts.heldAccent = opts.weapon.accent; delete opts.weapon }
  if (typeof opts.flame === 'function') { rec.glows = []; opts.flame(null); opts.flame = rec.glows; rec.glows = null }
  rec.actors.push({ kind, x, y, opts, lit: rec.lit })
}
export const setInk = () => {}
export const glow = (g, x, y, r, rgb, a = 0.6) => { if (rec.glows) rec.glows.push({ x, y, r, rgb, a }) }
export const stick = (g, x, y, o) => put('stick', x, y, o)
export const turret = (g, x, y, o) => put('turret', x, y, o)
export const gate = (g, x, y, o) => put('gate', x, y, o)
export const crystals = (g, x, y, o) => put('crystals', x, y, o)
export const beetle = (g, x, y, o) => put('beetle', x, y, o)
export const spider = (g, x, y, o) => put('spider', x, y, o)
export const bird = (g, x, y, o) => put('bird', x, y, o)
export const rocket = (g, x, y, ang, o = {}) => put('rocket', x, y, { ang, ...o })
export const smoke = (g, pts, o = {}) => rec.actors.push({ kind: 'smoke', x: pts[0][0], y: pts[0][1], opts: { pts, ...o }, lit: null })
export const hudE = o => { rec.hud = o }
// T23.16: F6's effects (tracers, beams) — T23.18's, not the lab's; F6's scene keeps only its lit() actors (below).
export const tracer = () => {}
export const beam = () => {}
export const INK = '#16110d'
`)
// T23.16: F6's weapons — each draw records itself through fakeG's transform; held() says which weapon a stick holds.
patch('weapons.js', 'export function held(key, accent) {', 'export function held(key, accent) { return { held: key, accent }\n')
writeFileSync(join(tmp, 'weapons.js'), readFileSync(join(tmp, 'weapons.js'), 'utf8') + `
for (const [k, d] of Object.entries(WEAPONS)) d.draw = (g, accent) => g.__weapon(k, accent)
`)
// T23.14: F7's figures (poses.js::figure), recorded like the rest of the cast; its pass flag rim is the renderer's.
writeFileSync(join(tmp, 'poses.js'), `import { rec } from './rec.js'
export function figure(g, x, y, J, o = {}) { const { rim, ...opts } = o; void rim; rec.actors.push({ kind: 'figure', x, y, opts: { J, ...opts }, lit: rec.lit }) }
`)

// ---- run each scene ---------------------------------------------------------
const imp = f => import(pathToFileURL(join(tmp, f)).href)
const { rec, reset } = await imp('rec.js')
const fScene = await imp('f_scene.js')
const runs = r => { const out = []; let cur = 0, n = 0; for (const v of r) { const b = v ? 1 : 0; if (b === cur) n++; else { out.push(n); cur = b; n = 1 } } out.push(n); return out }

const SCENES = [
  { id: 'F1', file: 'variant_F1.js', map: 'arenaE', title: 'night combat' },
  { id: 'F2', file: 'variant_F2.js', map: 'arenaE', title: 'volcanic night' },
  { id: 'F3', file: 'variant_F3.js', map: 'space', title: 'space' },
  { id: 'F4', file: 'variant_F4.js', map: 'cast', title: 'cast sheet' },
  { id: 'F5', file: 'variant_F5.js', map: 'arenaE', title: 'moonlit day' },
  { id: 'F7', file: 'variant_F7.js', map: 'poses', title: 'pose sheet' },
  // T23.16: F6, the arsenal — its lit() actors only (the weapons, the turret, the 1× row): its effects are T23.18's.
  { id: 'F6', file: 'variant_F6.js', map: 'arsenal', title: 'weapon sheet', litOnly: true },
]
const masks = {}
// T23.02: each actor's screen box, measured from the mockup's drawing by `measure-boxes.mjs`
// (a browser run); merged here in draw order, which both scripts record in.
const boxes = JSON.parse(readFileSync(join(here, 'actor-boxes.json'), 'utf8'))
const header = '// Generated by dump-mockup.mjs from tasks/M23/reference/mockup-src — do not edit; re-run it.\n'
for (const s of SCENES) {
  reset(); fScene.resetP()
  await (await imp(s.file)).default()
  const { world, draw2d, fx3d, ...look } = rec.frame
  void draw2d; void fx3d
  const mask = { w: 1280, h: 720, solid: runs(world.solid), back: runs(world.back) }
  if (masks[s.map] && JSON.stringify(masks[s.map]) !== JSON.stringify(mask)) throw new Error(`${s.id}: map ${s.map} differs`)
  masks[s.map] = mask
  if (s.litOnly) rec.actors = rec.actors.filter(a => a.lit)
  const measured = boxes[s.id]
  if (!measured || measured.length !== rec.actors.length) {
    throw new Error(`${s.id}: actor-boxes.json has ${measured?.length} boxes for ${rec.actors.length} actors — re-run measure-boxes.mjs`)
  }
  rec.actors.forEach((a, i) => { a.box = measured[i] })
  const P = fScene.lastP
  const palette = P ? { ...P, timer: P.timer ?? '2:57', extra2d: P.extra2d ?? null } : null // the mockup's defaults, stated
  const scene = {
    id: s.id, title: s.title, theme: world.theme, camera: { x: 0, y: 0, w: 1280, h: 720 }, mask: '__MASK__',
    look: { fogBack: null, fogFront: null, fg: null, ...look, moon: rec.moon },
    palette, actors: rec.actors, fx: rec.fx, hud: rec.hud, labels: rec.labels,
  }
  writeFileSync(join(here, `${s.id}.ts`), `${header}import type { SceneData } from '../scene'\nimport { ${s.map} } from './${s.map}.mask'\n\nexport const ${s.id}: SceneData = ${JSON.stringify(scene, null, 1).replace('"__MASK__"', s.map)}\n`)
  console.log(`${s.id}: ${rec.actors.length} actors, ${look.lights.length} lights, ${rec.fx.length} fx, ${rec.labels.length} labels`)
}
for (const [name, m] of Object.entries(masks)) writeFileSync(join(here, `${name}.mask.ts`), `${header}import type { MaskRuns } from '../scene'\n\nexport const ${name}: MaskRuns = ${JSON.stringify(m)}\n`)
rmSync(tmp, { recursive: true, force: true })
