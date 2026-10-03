#!/usr/bin/env node
/**
 * Shoot one of the trailer's gameplay scenes (M99, T99.04).
 *
 *   node promo/scenes/shoot.mjs <scene> [take] [seconds]
 *
 * Starts everything the shot needs and stops all of it: the release server with the scene's
 * settings (`scenes.mjs`), vite (or `VITE_URL=http://localhost:5173` to reuse one), and a headed
 * GPU Chrome joined as a **spectator** (no body in the shot). The HUD goes, the scene's own
 * staging runs (`stage`: place a bot, open the black hole, spawn the animals), and its director
 * moves the camera through `__game.watch` while CDP's screencast records 1920x1080 frames with
 * their compositor timestamps. Frames land in `promo/build/raw/<scene>-<take>/`, with
 * `frames.json` (timestamps) and `events.json` (what the director saw, for choosing the cut).
 *
 * Needs `cargo build -p game-server --release` first.
 */
import { mkdirSync, rmSync, writeFileSync, openSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildDir, launch, root, sleep } from '../lib.mjs'
import { spawnGroup, killGroup } from '../../scripts/proc-group.mjs'
import { matchVitePort } from '../../scripts/vite-url.mjs'
import { SCENES } from './scenes.mjs'
import { DIRECTOR } from './director.mjs'

const name = process.argv[2]
const scene = SCENES[name]
if (!scene) {
  console.error(`usage: shoot.mjs <${Object.keys(SCENES).join('|')}> [take] [seconds]`)
  process.exit(2)
}
const take = process.argv[3] ?? '1'
const seconds = Number(process.argv[4] ?? scene.seconds)
const out = join(buildDir, 'raw', `${name}-${take}`)
rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'frames'), { recursive: true })

const W = 1920
const H = 1080
// Own ports when another stack shares the box: PROMO_SERVER_PORT / PROMO_VITE_PORT.
const port = Number(process.env.PROMO_SERVER_PORT ?? 3000)
const vitePort = process.env.PROMO_VITE_PORT ?? null
const bin = join(root, 'target/release/game-server')
if (!existsSync(bin)) throw new Error('build the release server first: cargo build -p game-server --release')

const children = []
const cleanup = () => children.forEach(killGroup)
process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(130))

// --- the server ---------------------------------------------------------------------------
const env = {
  ...process.env,
  BIND_ADDR: `0.0.0.0:${port}`,
  GAME_LOG: 'warn',
  DEV_PROBE: '1',
  ROUND_SECONDS: '900',
  LOBBY_BOT_TIMEOUT: '1',
  DEV_WARMUP_SECONDS: '1',
  ...scene.env,
}
const log = openSync(join(out, 'server.log'), 'w')
children.push(spawnGroup(bin, [], { env, stdio: ['ignore', log, log], cwd: root }))
for (let i = 0; ; i++) {
  if (await fetch(`http://localhost:${port}/healthz`).then((r) => r.ok).catch(() => false)) break
  if (i > 100) throw new Error('the server never answered /healthz')
  await sleep(200)
}

// --- the client ---------------------------------------------------------------------------
let base = process.env.VITE_URL
if (!base) {
  // Its own process group, so the cleanup takes vite and the esbuild it forks (scripts/proc-group.mjs).
  const viteArgs = vitePort ? ['--', '--port', vitePort, '--strictPort'] : []
  const vite = spawnGroup('npm', ['--prefix', 'client', 'run', 'dev', ...viteArgs], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VITE_SERVER_PORT: String(port) },
  })
  children.push(vite)
  base = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('vite reported no port in 120 s')), 120_000)
    const on = (b) => {
      const p = matchVitePort(b)
      if (p) {
        clearTimeout(timer)
        res(`http://localhost:${p}`)
      }
    }
    vite.stdout.on('data', on)
    vite.stderr.on('data', on)
  })
}

const browser = await launch()
const bail = async (e) => {
  console.error(e)
  await browser.close().catch(() => {})
  process.exit(1)
}
process.on('uncaughtException', bail)
process.on('unhandledRejection', bail)
const ctx = await browser.newContext({ viewport: { width: W, height: H } })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('pageerror:', String(e).slice(0, 300)))
await page.goto(`${base}/?e2e=1&game=1&spectate=1&name=Director`)
await page.waitForFunction('window.__game && window.__game.debug().phase === "playing"', null, { timeout: 180_000 })
console.log('playing')

// A trailer shot has no HUD: everything on the page that is not a canvas (or holds one) goes,
// and the minimap (a small canvas in a box of its own).
await page.addStyleTag({
  content: `body > *:not(canvas):not(:has(canvas)) { visibility: hidden !important; }
            canvas { cursor: none !important; }`,
})
const hud = () =>
  page.evaluate((hide) => {
    const g = window.__game
    g.setCrosshairVisible(false)
    g.setNamesVisible(false)
    g.setItemLabelsVisible(false)
    // A scene's own `hide` list: 'items' (pickups, crates, their beams), 'graves'.
    if (hide.includes('items')) g.setItemsVisible(false)
    if (hide.includes('graves')) g.setGravesVisible(false)
    for (const c of document.querySelectorAll('canvas')) {
      if (c.getBoundingClientRect().width < 600) (c.parentElement ?? c).style.visibility = 'hidden'
    }
  }, scene.hide ?? [])
await hud()
// Names come up for players who enter the view later, and a map resync (heavy carving) rebuilds the world view
// with its labels and minimap: keep re-hiding them.
const namesOff = setInterval(() => hud().catch(() => {}), 250)

// The scene's staging (node side: it may wait for the world), then its director (page side).
const staged = scene.stage ? await scene.stage(page) : {}
await page.evaluate(
  ([src, opts]) => {
    // eslint-disable-next-line no-new-func
    const director = new Function(`return (${src})`)()
    director(window.__game, opts)
  },
  [DIRECTOR[scene.director].toString(), { zoom: scene.zoom, ...scene.directorOpts, ...staged }],
)
await sleep(scene.settle ?? 1500)
if (process.env.PROBE) {
  console.log(
    JSON.stringify(
      await page.evaluate(() => {
        const d = window.__game.debug()
        return { wv: d.worldView, zoom: d.zoom, rig: d.cameraCentre, cam: window.__dir.cam, f: window.__dir.fighters, canvas: [...document.querySelectorAll('canvas')].map((c) => [c.width, c.height]) }
      }),
    ),
  )
}

// --- record -------------------------------------------------------------------------------
const cdp = await ctx.newCDPSession(page)
const frames = []
cdp.on('Page.screencastFrame', async (f) => {
  const i = frames.length
  frames.push({ i, t: f.metadata.timestamp })
  writeFileSync(join(out, 'frames', `${String(i).padStart(6, '0')}.jpg`), Buffer.from(f.data, 'base64'))
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
})
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: W, maxHeight: H, everyNthFrame: 1 })
const t0 = Date.now()
const cues = [...(scene.cues ?? [])].sort((a, b) => a.at - b.at)
while (Date.now() - t0 < seconds * 1000) {
  const now = (Date.now() - t0) / 1000
  while (cues.length && cues[0].at <= now) {
    const cue = cues.shift()
    console.log(`cue ${cue.at}s: ${cue.what}`)
    await cue.run(page).catch((e) => console.log('cue failed:', String(e).slice(0, 200)))
  }
  await sleep(250)
  if (Math.round(now * 4) % 20 === 0) console.log(`${now.toFixed(0)} s, ${frames.length} frames`)
}
await cdp.send('Page.stopScreencast')
clearInterval(namesOff)
const dir = await page.evaluate(() => window.__dir?.log ?? [])
writeFileSync(join(out, 'frames.json'), JSON.stringify(frames))
writeFileSync(join(out, 'events.json'), JSON.stringify(dir))
const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0
console.log(`${frames.length} frames over ${span.toFixed(1)} s = ${(frames.length / span).toFixed(1)} fps -> ${out}`)
await browser.close()
cleanup()
process.exit(0)
