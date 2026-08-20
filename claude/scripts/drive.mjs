#!/usr/bin/env node
/**
 * Drive the client headlessly and run a script against it.
 *
 *   node scripts/drive.mjs <checkFile.mjs> [urlPath]
 *
 * The check file default-exports `async ({ page, shot, log }) => {...}`. `shot(name)`
 * writes `shots/<name>.png`. Throwing fails the run with a non-zero exit.
 *
 * Same vite-port and LD_LIBRARY_PATH handling as `shot.mjs`: the port is read from
 * vite's own output because it falls back to 5174+ when 5173 is taken, and Chromium
 * needs libraries unpacked under ~/.cache/pwlibs that this box does not have
 * installed system-wide.
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shotsDir = join(root, 'shots')
mkdirSync(shotsDir, { recursive: true })

const libDir = join(process.env.HOME ?? '', '.cache/pwlibs/root/usr/lib/x86_64-linux-gnu')
const chromePath = join(
  process.env.HOME ?? '',
  '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
)

const checkFile = process.argv[2]
const urlPath = process.argv[3] ?? '?sandbox=1'
if (!checkFile) {
  console.error('usage: drive.mjs <checkFile.mjs> [urlPath]')
  process.exit(2)
}

const require = createRequire(join(root, 'client/package.json'))
const { chromium } = require('playwright-core')

const vite = spawn('npm', ['--prefix', 'client', 'run', 'dev'], {
  cwd: root,
  env: { ...process.env, LD_LIBRARY_PATH: libDir },
})

let port = null
const portReady = new Promise((res, rej) => {
  const onData = (b) => {
    const s = b.toString()
    const m = s.match(/localhost:(\d+)/)
    if (m && !port) {
      port = Number(m[1])
      res(port)
    }
  }
  vite.stdout.on('data', onData)
  vite.stderr.on('data', onData)
  setTimeout(() => rej(new Error('vite did not report a port within 90 s')), 90_000)
})

const shutdown = () => {
  try {
    vite.kill('SIGTERM')
  } catch {
    /* already gone */
  }
}
process.on('exit', shutdown)

let code = 0
let browser
try {
  await portReady
  browser = await chromium.launch({
    executablePath: chromePath,
    env: { ...process.env, LD_LIBRARY_PATH: libDir },
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto(`http://localhost:${port}/${urlPath}`, { waitUntil: 'load' })
  await page.waitForFunction(() => !!window.__game, null, { timeout: 60_000 })

  const shot = async (name) => {
    await page.screenshot({ path: join(shotsDir, `${name}.png`) })
    console.log(`  shot: shots/${name}.png`)
  }
  const log = (...a) => console.log(' ', ...a)

  const mod = await import(pathToFileURL(resolve(root, checkFile)).href)
  await mod.default({ page, shot, log })

  if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`)
  console.log('\nOK')
} catch (e) {
  console.error(`\nFAILED: ${e.message}`)
  code = 1
} finally {
  await browser?.close()
  shutdown()
}
process.exit(code)
