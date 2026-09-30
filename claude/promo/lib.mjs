/**
 * Shared plumbing for the trailer scripts (M99).
 *
 * Footage is recorded in a **headed** Chrome on the real GPU: WSLg + `GALLIUM_DRIVER=d3d12`
 * (scripts/play.mjs, T23.00). Headless Chrome on this box only gets SwiftShader or llvmpipe,
 * which cannot hold a frame rate a trailer can use — measured while writing this.
 */
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const promoDir = dirname(fileURLToPath(import.meta.url))
export const root = resolve(promoDir, '..')
export const buildDir = join(promoDir, 'build')

const require = createRequire(join(root, 'client', 'package.json'))
export const { chromium } = require('playwright-core')
export const ffmpeg = createRequire(join(promoDir, 'package.json'))('ffmpeg-static')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A GPU-backed, visible Chrome. `headless: true` falls back to SwiftShader (offline renders only). */
export async function launch({ headless = false } = {}) {
  return chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless,
    args: [
      '--ignore-gpu-blocklist',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--autoplay-policy=no-user-gesture-required',
    ],
    env: { ...process.env, GALLIUM_DRIVER: 'd3d12' },
  })
}

/** Run a command, resolve on exit 0. */
export async function run(cmd, args, { quiet = true } = {}) {
  const { spawn } = await import('node:child_process')
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: quiet ? ['ignore', 'ignore', 'pipe'] : 'inherit' })
    let err = ''
    p.stderr?.on('data', (d) => (err += d))
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`${cmd} exited ${c}\n${err.slice(-2000)}`))))
  })
}
