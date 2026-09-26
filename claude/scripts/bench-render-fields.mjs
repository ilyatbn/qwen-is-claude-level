#!/usr/bin/env node
/**
 * T23.03B (F9): `render_fields` timed on the **wasm32 build**, not native Rust — the build the
 * client runs. `cargo test --release -- --ignored render_fields_bench` times the native code;
 * this times the same work through the WASM boundary the terrain renderer (T23.07) will call.
 *
 *   node scripts/wasm-build.mjs --release && node scripts/bench-render-fields.mjs
 *
 * Runs in node's V8 (Chrome's wasm engine, without a page). Per scale: a full pass
 * (`render_fields_full`, median of 5) and a radius-60 crater (`carve` then `render_fields_dirty`
 * over its bounds, median of 5 craters along the surface). Report only; nothing gates on it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = join(root, 'client/src/core/pkg')
const wasm = await import(join(pkg, 'game_wasm.js'))
wasm.initSync({ module: readFileSync(join(pkg, 'game_wasm_bg.wasm')) })

const SCALES = { small: 0, medium: 1, large: 2 }
const R = 60
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const ms = (f) => {
  const t = performance.now()
  const out = f()
  return [performance.now() - t, out]
}

for (const [name, scale] of Object.entries(SCALES)) {
  const core = new wasm.GameCore()
  core.generate(7, 0, scale)
  const [w, h] = [core.width(), core.height()]
  const fulls = []
  for (let i = 0; i < 5; i++) fulls.push(ms(() => core.render_fields_full())[0])
  const craters = []
  for (let k = 1; k <= 5; k++) {
    const cx = Math.round((w * k) / 6)
    let cy = 0
    while (cy < h && !core.solid_at(cx, cy)) cy++
    core.carve(cx, cy, R)
    const [t, rect] = ms(() => core.render_fields_dirty(cx - R, cy - R, 2 * R + 1, 2 * R + 1))
    craters.push(t)
    if (k === 1) console.log(`  ${name}: crater at ${cx},${cy} wrote ${rect[2]}x${rect[3]}`)
  }
  console.log(
    `${name.padEnd(6)} ${w}x${h}: full ${median(fulls).toFixed(1)} ms (median of 5, min ${Math.min(...fulls).toFixed(1)}), ` +
      `r=${R} crater ${median(craters).toFixed(2)} ms (median of 5, max ${Math.max(...craters).toFixed(2)})`,
  )
  core.free()
}
