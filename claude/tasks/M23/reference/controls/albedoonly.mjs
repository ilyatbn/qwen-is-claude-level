// T23.06 control: a scene's terrain ALBEDO alone, straight from the reference implementation —
// world.js::derive(buildMask(ARENA_E), theme), ARENA_E's scorch list included — drawn flat: the
// albedo's RGB where its alpha is non-zero (rock 255, cave wall 128, grass fringe 200), black in
// the air. That is what the look-lab's `?look=F1&only=albedo` draws (`WorldRenderer.showAlbedo`).
//
// world.js is plain JS with no DOM, so this runs in node (the same V8 as the mockup's Chromium):
//   node tasks/M23/reference/controls/albedoonly.mjs            → controls/F1-albedo.png (dusk)
//   node tasks/M23/reference/controls/albedoonly.mjs meadow     → controls/F1-albedo-meadow.png (must-fail: another palette)
//   node tasks/M23/reference/controls/albedoonly.mjs noscorch   → controls/F1-albedo-noscorch.png (must-fail: ARENA_E's scorch left out)
// Rendered twice, byte-identical (look-albedo's floor for the mockup side is 0).
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// mockup-src's package.json says CommonJS, and these two are ES modules with no imports of their
// own: load their source as modules, unchanged.
const esm = (f) => import(`data:text/javascript;base64,${readFileSync(join(here, '../mockup-src', f)).toString('base64')}`)
const { buildMask, derive, W, H } = await esm('world.js')
const { ARENA_E } = await esm('maps.js')
const { PNG } = createRequire(join(here, '../../../../client/package.json'))('pngjs')
const knob = process.argv[2] ?? 'dusk'
const theme = knob === 'noscorch' ? 'dusk' : knob
const m = derive(buildMask(knob === 'noscorch' ? { ...ARENA_E, scorch: [] } : ARENA_E), theme)
const png = new PNG({ width: W, height: H })
for (let i = 0; i < W * H; i++) {
  const lit = m.albedo[i * 4 + 3] > 0
  for (let c = 0; c < 3; c++) png.data[i * 4 + c] = lit ? m.albedo[i * 4 + c] : 0
  png.data[i * 4 + 3] = 255
}
const out = join(here, knob === 'dusk' ? 'F1-albedo.png' : `F1-albedo-${knob}.png`)
writeFileSync(out, PNG.sync.write(png))
console.log(`wrote ${out}`)
