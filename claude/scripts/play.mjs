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
// `e2e=1` is what exposes `window.__game` (`GameScene::exposeDebugHandle`), and
// it gates **nothing else** — three call sites, all of them the handle. Without
// it `make probe` prints `null` for a live match, which is the one thing the
// interactive loop in `CLAUDE.md` exists to read.
// **`debug=1` is deliberately NOT the default.** It turns on debug mode, which
// draws its own `#debug-fps` readout that the Options toggle does not govern —
// so the frame rate showed with the toggle off, and showed *twice* with it on
// (`GameScene`'s counter sits at `top:26px` precisely to stack under it). Both
// are dev-only; `no-dev-surface.mjs` proves `debug-fps` is absent from a
// production bundle. Debug mode also draws the aim ring around the player. A
// person playing the game wants to see the game — pass the URL explicitly when
// you want the overlays: `make play URL='http://localhost:5173/?e2e=1&debug=1'`,
// or press F1 in the window.
const url = process.argv[2] ?? 'http://localhost:5173/?e2e=1'
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
    // **The gate gets WebGL and this window did not.** `scripts/lib/browser-args.mjs`
    // passes these to the headless Chrome every browser check runs in, so every
    // shader effect (fog, fire, smoke, beams, explosions) is verified under WebGL —
    // while the window a person actually plays in fell back to Phaser CANVAS, where
    // `optionsPanel.ts::QUALITY_HINT_NO_WEBGL` disables High Quality outright. The
    // effects were therefore tested in a browser nobody played in. Measured on this
    // box: without these flags a fresh canvas returns no WebGL context at all; with
    // them, `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader
    // driver)`. There is no GPU under WSLg, so software rendering is the only WebGL
    // available and Chrome now refuses it unless asked twice.
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
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
