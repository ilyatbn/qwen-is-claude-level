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
    // T23.00: **the real GPU, not a software renderer.** Measured with the owner at this
    // machine (Chrome 151, WSLg, 2026-09-26; table in tasks/M23/T23.00-*.md): as-is Chrome
    // gets no WebGL at all; `--ignore-gpu-blocklist` alone gets llvmpipe (CPU, ~10 fps on a
    // heavy shader); adding `GALLIUM_DRIVER=d3d12` (env, below) routes Mesa to the host GPU
    // through WSL's D3D12 — `D3D12 (Intel Arc B390)`, WebGL2, half/float targets, ~535 fps
    // uncapped. The old `--use-gl=swiftshader` pair is gone: it *forces* SwiftShader and
    // would override the GPU. M23's three.js renderer needs WebGL2; the headless checks keep
    // swiftshader (`lib/browser-args.mjs`, R14's low tier). `make probe` prints which one
    // this window got; `node scripts/webgl2-probe.mjs --all` re-measures the table.
    '--ignore-gpu-blocklist',
    '--new-window',
    url,
  ],
  { detached: true, stdio: ['ignore', log, log], env: { ...process.env, GALLIUM_DRIVER: 'd3d12' } },
)
child.unref()

console.log(`chrome  pid ${child.pid}`)
console.log(`window  ${url}`)
console.log(`cdp     http://localhost:${port}`)
console.log(`attach  node scripts/probe.mjs`)
// Chrome hands a URL to a browser already running on this profile and exits — that one keeps
// whatever flags and env it was started with. Close it first if `make probe` says CPU.
console.log(`gpu     GALLIUM_DRIVER=d3d12 --ignore-gpu-blocklist (an already-open window keeps its own)`)
