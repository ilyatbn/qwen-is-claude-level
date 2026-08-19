#!/usr/bin/env node
/**
 * Headless screenshot of the client.
 *
 *   node scripts/shot.mjs [urlPath] [outName] [waitMs]
 *   node scripts/shot.mjs '?sandbox=1&seed=4242' sandbox 3000
 *
 * Starts vite, reads the port **from vite's own output** (it falls back to 5174+
 * when 5173 is taken, and hard-coding it produces a confusing blank page), loads
 * the URL, waits for a canvas with actual pixels in it, writes a PNG to
 * `shots/` and exits.
 *
 * Chromium needs libraries this box does not have installed system-wide; they are
 * unpacked under ~/.cache/pwlibs. This script sets LD_LIBRARY_PATH itself so
 * callers do not have to remember.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shotsDir = join(root, 'shots')
const libDir = join(process.env.HOME ?? '', '.cache/pwlibs/root/usr/lib/x86_64-linux-gnu')
const chromePath = join(
  process.env.HOME ?? '',
  '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
)

const urlPath = process.argv[2] ?? ''
const outName = process.argv[3] ?? 'shot'
const waitMs = Number(process.argv[4] ?? 3000)

mkdirSync(shotsDir, { recursive: true })
if (!existsSync(chromePath)) {
  console.error(`chromium not found at ${chromePath}`)
  process.exit(1)
}

/** Start vite and resolve with { proc, url } once it prints its address. */
function startVite() {
  return new Promise((resolvePort, reject) => {
    const proc = spawn('npx', ['vite', '--strictPort=false'], {
      cwd: join(root, 'client'),
      env: { ...process.env },
    })
    let settled = false
    const onData = (buf) => {
      const text = buf.toString()
      process.stdout.write(text.replace(/^/gm, '  [vite] '))
      // "  ➜  Local:   http://localhost:5174/"
      const m = text.match(/Local:\s+(http:\/\/[^\s/]+)/)
      if (m && !settled) {
        settled = true
        resolvePort({ proc, url: m[1] })
      }
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('exit', (code) => {
      if (!settled) reject(new Error(`vite exited with ${code} before printing a URL`))
    })
    setTimeout(() => {
      if (!settled) reject(new Error('vite did not print a URL within 60 s'))
    }, 60_000)
  })
}

const { proc: vite, url: base } = await startVite()

// playwright-core lives in client/node_modules, not next to this script.
const require = createRequire(join(root, 'client', 'package.json'))
const { chromium } = require('playwright-core')
const browser = await chromium.launch({
  executablePath: chromePath,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
  env: { ...process.env, LD_LIBRARY_PATH: libDir },
})

let failed = false
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const logs = []
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))
  page.on('pageerror', (e) => {
    logs.push(`PAGEERROR: ${e.message}`)
    failed = true
  })

  const target = `${base}/${urlPath}`
  console.log(`loading ${target}`)
  await page.goto(target, { waitUntil: 'load', timeout: 30_000 })

  // Wait for a canvas that has actually drawn something, not merely for one to
  // exist — Phaser inserts the element well before the first frame.
  await page
    .waitForFunction(
      () => {
        const c = document.querySelector('canvas')
        return c instanceof HTMLCanvasElement && c.width > 0 && c.height > 0
      },
      { timeout: 30_000 },
    )
    .catch(() => {
      logs.push('WARN: no canvas appeared')
      failed = true
    })

  await page.waitForTimeout(waitMs)

  const out = join(shotsDir, `${outName}.png`)
  await page.screenshot({ path: out })
  console.log(`wrote ${out}`)

  // Anything the page wants to tell us (the sandbox exposes window.__game).
  const debug = await page.evaluate(() => {
    const g = /** @type {any} */ (window).__game
    return g ? JSON.stringify(g.debug?.() ?? g, null, 1).slice(0, 2000) : null
  })
  if (debug) console.log('__game:', debug)

  const interesting = logs.filter(
    (l) => !l.startsWith('debug:') && !l.includes('[vite] connect'),
  )
  if (interesting.length) {
    console.log('--- console ---')
    for (const l of interesting.slice(0, 40)) console.log(l)
  }
} finally {
  await browser.close()
  vite.kill('SIGTERM')
}

process.exit(failed ? 1 : 0)
