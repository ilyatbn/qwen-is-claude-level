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
  draw(g, 0, 0, null) // the ink pass: the actor exactly as it is, no rim offset
  rec.lit = null
}
function fakeG() {
  const store = {}
  return new Proxy(store, {
    get: (t, k) => (k === 'fillText' ? (text, x, y) => rec.labels.push({ text, x, y, font: t.font, fill: t.fillStyle, align: t.textAlign }) : k in t ? t[k] : () => {}),
    set: (t, k, v) => { t[k] = v; return true },
  })
}
`)
writeFileSync(join(tmp, 'e_style.js'), `import { rec } from './rec.js'
const put = (kind, x, y, o = {}) => {
  const opts = { ...o }
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
]
const masks = {}
const header = '// Generated by dump-mockup.mjs from tasks/M23/reference/mockup-src — do not edit; re-run it.\n'
for (const s of SCENES) {
  reset(); fScene.resetP()
  await (await imp(s.file)).default()
  const { world, draw2d, fx3d, ...look } = rec.frame
  void draw2d; void fx3d
  const mask = { w: 1280, h: 720, solid: runs(world.solid), back: runs(world.back) }
  if (masks[s.map] && JSON.stringify(masks[s.map]) !== JSON.stringify(mask)) throw new Error(`${s.id}: map ${s.map} differs`)
  masks[s.map] = mask
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
