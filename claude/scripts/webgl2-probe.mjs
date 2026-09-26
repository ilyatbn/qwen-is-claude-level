#!/usr/bin/env node
/**
 * T23.00 — which Chrome launch gives WebGL2, on what renderer, and how fast. A **dev tool**,
 * not a gate check: it opens a real (headed) Chrome window for a few seconds per flag set,
 * the way `make play` does, and closes it.
 *
 *   node scripts/webgl2-probe.mjs                  → the `make play` set (d3d12 + blocklist)
 *   node scripts/webgl2-probe.mjs --all            → every preset below, one after another
 *   node scripts/webgl2-probe.mjs --preset asis
 *   node scripts/webgl2-probe.mjs --env GALLIUM_DRIVER=d3d12 -- --ignore-gpu-blocklist
 *   node scripts/webgl2-probe.mjs --checks         → the headless Chromium the browser checks use
 *
 * Prints webgl2 / renderer / half-float + float render targets (`lib/webgl-info.mjs`, the same
 * reader as the `webgl2` check) and frame rate on a full-screen fbm shader, light and ×10
 * heavy: `raf` is vsync-capped frames per second, `uncapped` is draws per second with a 1-px
 * readback after each so the GPU cannot queue ahead.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchOptions } from './lib/browser-args.mjs'
import { describe, webglInfo } from './lib/webgl-info.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { chromium } = createRequire(join(root, 'client/package.json'))('playwright-core')

const PRESETS = {
  asis: { env: {}, args: [] },
  blocklist: { env: {}, args: ['--ignore-gpu-blocklist'] },
  d3d12: { env: { GALLIUM_DRIVER: 'd3d12' }, args: ['--ignore-gpu-blocklist'] },
  swiftshader: { env: {}, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] },
}

const PAGE = `<!doctype html><body style="margin:0;background:#000"><canvas id=c width=1280 height=720></canvas>
<script>
const gl = document.getElementById('c').getContext('webgl2')
function prog(iters) {
  const vs = '#version 300 es\\nin vec2 p;void main(){gl_Position=vec4(p,0,1);}'
  const fs = '#version 300 es\\nprecision highp float;out vec4 o;uniform float t;' +
    'float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}' +
    'float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);' +
    'return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}' +
    'void main(){vec2 uv=gl_FragCoord.xy/360.;float a=0.;for(int k=0;k<' + iters + ';k++){' +
    'float s=1.,w=.5;vec2 q=uv+float(k)*.37+t*.1;for(int j=0;j<6;j++){a+=w*n(q*s);s*=2.;w*=.5;}}' +
    'a/=float(' + iters + ');o=vec4(a*.6,a*.8,a,1);}'
  const P = gl.createProgram()
  for (const [ty, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const sh = gl.createShader(ty); gl.shaderSource(sh, src); gl.compileShader(sh); gl.attachShader(P, sh)
  }
  gl.bindAttribLocation(P, 0, 'p'); gl.linkProgram(P)
  return P
}
window.bench = async (iters, ms) => {
  if (!gl) return null
  const P = prog(iters); gl.useProgram(P)
  const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  const u = gl.getUniformLocation(P, 't'), px = new Uint8Array(4)
  const draw = (t) => { gl.uniform1f(u, t); gl.drawArrays(gl.TRIANGLES, 0, 3) }
  let n = 0, t0 = performance.now()
  while (performance.now() - t0 < ms) { draw(n++); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px) }
  const uncapped = n / ((performance.now() - t0) / 1000)
  let f = 0; const r0 = performance.now()
  await new Promise((done) => { const step = (t) => { draw(t / 1000); f++; performance.now() - r0 < ms ? requestAnimationFrame(step) : done() }; requestAnimationFrame(step) })
  return { raf: f / ((performance.now() - r0) / 1000), uncapped }
}
</script>`

async function measure(page) {
  const info = await page.evaluate(webglInfo)
  await page.setContent(PAGE)
  const light = await page.evaluate(() => window.bench(1, 1500))
  const heavy = await page.evaluate(() => window.bench(10, 1500))
  return { info, light, heavy }
}

/** Headed google-chrome over CDP, spawned exactly the way `play.mjs` spawns it. */
async function headed(name, { env, args }) {
  const dir = mkdtempSync(join(tmpdir(), 'webgl2-probe-'))
  const port = 9300 + Math.floor(Math.random() * 500)
  const child = spawn(
    'google-chrome',
    [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run',
      '--no-default-browser-check', '--new-window', ...args, 'about:blank'],
    { detached: true, stdio: 'ignore', env: { ...process.env, ...env } },
  )
  try {
    let browser = null
    for (let i = 0; i < 40 && !browser; i++) {
      browser = await chromium.connectOverCDP(`http://localhost:${port}`).catch(() => null)
      if (!browser) await new Promise((r) => setTimeout(r, 250))
    }
    if (!browser) throw new Error(`${name}: no CDP on :${port}`)
    const page = browser.contexts()[0].pages()[0] ?? (await browser.contexts()[0].newPage())
    const r = await measure(page)
    await browser.close()
    return r
  } finally {
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 500))
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true })
  }
}

async function checksBrowser() {
  const browser = await chromium.launch(launchOptions())
  try {
    return await measure(await browser.newPage())
  } finally {
    await browser.close()
  }
}

function report(name, flags, { info, light, heavy }) {
  const fps = (b) => (b ? `raf ${b.raf.toFixed(0)} / uncapped ${b.uncapped.toFixed(1)}` : '—')
  console.log(`\n== ${name}  ${flags}`)
  console.log(describe(info))
  console.log(`rt      half-float ${info.halfFloatComplete} (2.0→${info.halfFloatReadback}) ` +
    `EXT_color_buffer_float ${info.extFloat} EXT_color_buffer_half_float ${info.extHalfFloat}`)
  console.log(`light   ${fps(light)}`)
  console.log(`heavy   ${fps(heavy)}  (×10)`)
}

const argv = process.argv.slice(2)
const dash = argv.indexOf('--')
const extra = dash >= 0 ? argv.slice(dash + 1) : []
const opts = dash >= 0 ? argv.slice(0, dash) : argv
if (opts.includes('--checks')) {
  report('checks (headless)', 'lib/browser-args.mjs', await checksBrowser())
} else {
  let sets
  if (opts.includes('--all')) sets = Object.entries(PRESETS)
  else if (extra.length || opts.includes('--env')) {
    const env = {}
    opts.forEach((o, i) => { if (o === '--env') { const [k, v] = opts[i + 1].split('='); env[k] = v } })
    sets = [['custom', { env, args: extra }]]
  } else {
    const p = opts.includes('--preset') ? opts[opts.indexOf('--preset') + 1] : 'd3d12'
    if (!PRESETS[p]) throw new Error(`unknown preset ${p}; one of ${Object.keys(PRESETS).join(', ')}`)
    sets = [[p, PRESETS[p]]]
  }
  for (const [name, set] of sets) {
    const flags = [...Object.entries(set.env).map(([k, v]) => `${k}=${v}`), ...set.args].join(' ') || '(none)'
    report(name, flags, await headed(name, set))
  }
}
