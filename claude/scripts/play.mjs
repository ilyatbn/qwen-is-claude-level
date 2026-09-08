#!/usr/bin/env node
/**
 * Launch the game in a **headed** Chrome you can click in, with CDP open so an
 * agent can attach to the *same* window.
 *
 * This box runs WSLg (`DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-0`), so a real
 * window appears. Headless is for the gate; **interactive debugging is headed**,
 * because the point is that a person can take the controls mid-session and say
 * what they see.
 *
 * The separate `--user-data-dir` matters: Chrome will not open a remote-debugging
 * port on a profile that is already running elsewhere, and reusing the default
 * profile silently gives you a window with no CDP.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const url = process.argv[2] ?? 'http://localhost:5173/?debug=1'
const port = Number(process.env.CDP_PORT ?? 9222)
const runDir = join(root, '.run')
mkdirSync(runDir, { recursive: true })
const log = openSync(join(runDir, 'chrome.log'), 'a')

const child = spawn(
  'google-chrome',
  [
    `--remote-debugging-port=${port}`,
    '--user-data-dir=/tmp/deepcut-chrome',
    '--no-first-run',
    '--no-default-browser-check',
    // Keep the window honest: no throttling of a window the tester is watching,
    // and no "restore pages?" bubble covering the game after a kill.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-session-crashed-bubble',
    '--new-window',
    url,
  ],
  { detached: true, stdio: ['ignore', log, log] },
)
child.unref()

console.log(`chrome  pid ${child.pid}`)
console.log(`window  ${url}`)
console.log(`cdp     http://localhost:${port}`)
console.log(`attach  node scripts/probe.mjs`)
