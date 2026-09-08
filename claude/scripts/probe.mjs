#!/usr/bin/env node
/**
 * Attach to the running headed Chrome over CDP, dump the game's debug state and
 * take a screenshot — **without closing the window**.
 *
 * `browser.close()` on a CDP *connection* detaches; it does not kill the browser
 * the person is using. That is the whole point: they keep the controls, and this
 * is a read of the same window rather than a second one.
 *
 *   node scripts/probe.mjs                 → state + shots/probe.png
 *   node scripts/probe.mjs --watch 5       → every 5 s until interrupted
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// playwright-core is a *client* devDependency and there is no node_modules at the
// repo root — this is how every other script here resolves it. Do not invent a
// second way; `import from 'playwright'` simply fails.
const require = createRequire(join(root, 'client/package.json'))
const { chromium } = require('playwright-core')
const port = Number(process.env.CDP_PORT ?? 9222)
const watch = process.argv.includes('--watch')
  ? Number(process.argv[process.argv.indexOf('--watch') + 1] ?? 5)
  : 0
mkdirSync(join(root, 'shots'), { recursive: true })

async function once(browser) {
  const ctx = browser.contexts()[0]
  const page =
    ctx.pages().find((p) => p.url().includes('localhost:5173')) ?? ctx.pages()[0]
  if (!page) return console.log('no page open')
  const state = await page
    .evaluate(() => (window.__game ? window.__game.debug() : null))
    .catch((e) => ({ error: String(e) }))
  const out = join(root, 'shots', 'probe.png')
  await page.screenshot({ path: out })
  console.log(new Date().toISOString(), page.url())
  console.log(JSON.stringify(state, null, 1))
  console.log(`shot  ${out}`)
}

const browser = await chromium.connectOverCDP(`http://localhost:${port}`)
if (watch) {
  for (;;) {
    await once(browser)
    await new Promise((r) => setTimeout(r, watch * 1000))
  }
} else {
  await once(browser)
  await browser.close() // detaches CDP only — the window stays open
}
