// T23.02: each reference actor's screen box, **measured from the mockup's own drawing**.
//
//   LD_LIBRARY_PATH=$HOME/.cache/pwlibs/root/usr/lib/x86_64-linux-gnu node client/src/look/scenes/measure-boxes.mjs
//   node client/src/look/scenes/dump-mockup.mjs      (then: merges the boxes into F*.ts)
//
// Why pixels and not a formula: an actor's extent is whatever `f_kit.js::lit` paints — its halo
// (30 × size around the chest), its ground shadow, the rim passes offset toward the key light,
// the marker above the head, a flamer's flame — and a per-kind extent table would be a second
// copy of that drawing code that nothing checks. So this runs the mockup's real `lit()` and
// `e_style.js::smoke` in headless Chromium, each actor alone on a blank 1280×720 canvas, and
// takes the bounding box of every pixel with alpha > 0. Order is the order of the draw calls,
// which is the order `dump-mockup.mjs` records actors in (it asserts the counts agree).
//
// A temp copy is patched (the reference is never edited): `frame` only runs the 2D pass, `lit`
// and `smoke` draw onto a scratch canvas and record its box. No WebGL is drawn.
// Output: `actor-boxes.json` beside this file, `{ F1: [[x0, y0, x1, y1] | null, …], … }`,
// half-open px rects in mask px, y down. `null` is an actor that painted nothing on screen.

import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync, statSync, createReadStream } from 'node:fs'
import { createRequire } from 'node:module'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const client = join(here, '../../..')
const src = join(client, '../tasks/M23/reference/mockup-src')
const { chromium } = createRequire(join(client, 'package.json'))('playwright-core')

const tmp = mkdtempSync(join(tmpdir(), 'look-boxes-'))
cpSync(src, tmp, { recursive: true })
symlinkSync(join(client, 'node_modules'), join(tmp, 'node_modules'))

const patch = (file, from, to) => {
  const p = join(tmp, file), s = readFileSync(p, 'utf8')
  if (!s.includes(from)) throw new Error(`${file}: patch anchor missing: ${from}`)
  writeFileSync(p, s.replace(from, to))
}
patch('f_kit.js', 'export function lit(', 'function lit0(')
patch('f_kit.js', 'export function frame(', 'function frame0(')
writeFileSync(join(tmp, 'f_kit.js'), readFileSync(join(tmp, 'f_kit.js'), 'utf8') + `
export function lit(g, ...a) { globalThis.__measure(m => lit0(m, ...a)) }
export function frame(o) { void frame0; o.draw2d(globalThis.__scratch().g) }
`)
patch('e_style.js', 'export function smoke(', 'function smoke0(')
writeFileSync(join(tmp, 'e_style.js'), readFileSync(join(tmp, 'e_style.js'), 'utf8') + `
export function smoke(g, ...a) { globalThis.__measure(m => smoke0(m, ...a)) }
`)
writeFileSync(join(tmp, 'measure.html'), `<!doctype html><html><body>
<script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>
<script type="module">
const W = 1280, H = 720
globalThis.__boxes = []
globalThis.__scratch = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.lineCap = 'round'; g.lineJoin = 'round'; return { c, g } }
globalThis.__measure = draw => {
  const { c, g } = __scratch(); draw(g)
  const d = g.getImageData(0, 0, W, H).data
  let x0 = W, y0 = H, x1 = -1, y1 = -1
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  __boxes.push(x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1])
}
const v = new URLSearchParams(location.search).get('v')
import('./variant_' + v + '.js').then(m => m.default()).then(() => { window.__done = true }, e => { window.__err = String(e.stack || e); window.__done = true })
</script></body></html>`)

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' }
const server = http.createServer((req, res) => {
  const p = join(tmp, decodeURIComponent(req.url.split('?')[0]))
  if (!p.startsWith(tmp) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' })
  createReadStream(p).pipe(res)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const out = {}
try {
  for (const id of ['F1', 'F2', 'F3', 'F4', 'F5', 'F7']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    page.on('pageerror', e => console.log(`[${id}] PAGEERROR`, e.message))
    await page.goto(`http://127.0.0.1:${server.address().port}/measure.html?v=${id}`)
    await page.waitForFunction('window.__done === true', null, { timeout: 120000 })
    const err = await page.evaluate('window.__err')
    if (err) throw new Error(`${id}: ${err}`)
    out[id] = await page.evaluate('globalThis.__boxes')
    console.log(`${id}: ${out[id].length} boxes`)
    await page.close()
  }
} finally {
  await browser.close()
  server.close()
  unlinkSync(join(tmp, 'node_modules')) // the link, never the client's node_modules behind it
  rmSync(tmp, { recursive: true, force: true })
}
writeFileSync(join(here, 'actor-boxes.json'), `${JSON.stringify(out)}\n`)
