#!/usr/bin/env node
/**
 * Render a time-driven page (`window.renderAt(t)`) to a numbered frame sequence (M99).
 *
 *   node promo/render-page.mjs intro/index.html intro 14.4          # every frame, 60 fps
 *   node promo/render-page.mjs intro/index.html intro 14.4 1,9.5,13  # just these stills
 *   node promo/render-page.mjs cards/index.html cards 59 --alpha     # transparent PNGs
 *
 * Frames go to promo/build/<name>/ as JPEG (or PNG with --alpha, for overlays). The page
 * decides what each instant looks like; this only steps the clock, so a slow frame is still
 * exactly 1/60 s of film.
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildDir, launch } from './lib.mjs'
import { serve } from './serve.mjs'
import { FPS, H, W } from './timeline.mjs'

const [page0, name, dur, stillsArg] = process.argv.slice(2)
const alpha = process.argv.includes('--alpha')
const stills = stillsArg && !stillsArg.startsWith('--') ? stillsArg.split(',').map(Number) : null
const out = join(buildDir, stills ? `${name}-stills` : name)
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const { server, url } = await serve()
const browser = await launch()
const ctx = await browser.newContext({ viewport: { width: W, height: H } })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('pageerror:', String(e)))
page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()))
await page.goto(`${url}/${page0}`)
await page.waitForFunction('window.ready === true', null, { timeout: 60_000 })
await page.evaluate(() => document.fonts.ready)

const times = stills ?? Array.from({ length: Math.round(Number(dur) * FPS) }, (_, i) => i / FPS)
const t0 = Date.now()
for (const [i, t] of times.entries()) {
  await page.evaluate((t) => window.renderAt(t), t)
  const file = join(out, stills ? `t${t.toFixed(2)}.jpg` : `${String(i).padStart(5, '0')}.${alpha ? 'png' : 'jpg'}`)
  await page.screenshot(alpha ? { path: file, omitBackground: true } : { path: file, type: 'jpeg', quality: 94 })
  if (i % 120 === 0) console.log(`${i}/${times.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
}
console.log(`${times.length} frames -> ${out}`)
await browser.close()
server.close()
