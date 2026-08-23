/**
 * The shared browser-check harness (§C18 reopen, §A24).
 *
 * Eight standalone checks each hand-wrote the same ninety lines: spawn a
 * server, poll `/healthz`, spawn vite, parse its port, launch Chromium with the
 * unpacked libraries, open a page, wait for `__game`. When T13.06.1 made a room
 * stop existing until someone asks for one, five of those eight broke — and the
 * fix in each was the same three lines. That is §A24 for the fifth time (five
 * vite parses, four wasm hooks, two capsule rasterisers, two escapers).
 *
 * So: one place to start the stack, and — the part the task actually turns on —
 * **one `enterBattle`**. A check says "put me in a running round" and does not
 * care whether the lobby needs two humans, a button, or nothing at all. When the
 * lobby rules change again, this function changes and the checks do not.
 *
 * Every failure in here is *named*. A check that times out at its own assertion
 * because it was never in a battle reports "the crate never fell", which is how
 * a lobby regression got read as a fixture bug for a whole session.
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { matchVitePort } from '../vite-url.mjs'
import { killGroup } from '../proc-group.mjs'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const shotsDir = join(root, 'shots')
mkdirSync(shotsDir, { recursive: true })

const require = createRequire(join(root, 'client/package.json'))
const { chromium } = require('playwright-core')

const libDir = join(process.env.HOME ?? '', '.cache/pwlibs/root/usr/lib/x86_64-linux-gnu')
const chromePath = join(
  process.env.HOME ?? '',
  '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
)

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * A tiny assertion tally, so every check reports the same way and the suite's
 * output is greppable.
 */
export function tally(label) {
  const failures = []
  return {
    ok: (m) => console.log(`  ok   ${m}`),
    fail: (m) => {
      console.error(`  FAIL: ${m}`)
      failures.push(m)
    },
    failures,
    /** Print the verdict and exit. Never returns. */
    finish: async (teardown) => {
      if (teardown) await teardown()
      if (failures.length) {
        console.log(`${label} FAILED (${failures.length})`)
        for (const f of failures) console.log(`  - ${f}`)
      } else {
        console.log(`${label} ok`)
      }
      process.exit(failures.length ? 1 : 0)
    },
  }
}

/**
 * Start a real `game-server`, a vite dev server pointed at it, and Chromium.
 *
 * `env` is merged over the defaults, so a check overrides only what it cares
 * about. Note what is *not* here: `MIN_PLAYERS_TO_START`. Checks used to set it
 * to 1 to skip the lobby; three did and five did not, which is exactly the
 * split that turned one feature into five red checks. Entering a battle is
 * `enterBattle`'s job, through the button a player actually presses.
 */
export async function startStack({ port, env = {}, label = 'check' } = {}) {
  if (!port) throw new Error('startStack: a port is required (each check owns one)')
  const kids = []
  let browser = null

  const close = async () => {
    try {
      await browser?.close()
    } catch {
      /* already gone */
    }
    for (const k of kids) {
      try {
        killGroup(k)
      } catch {
        /* already gone */
      }
    }
  }
  process.on('exit', () => {
    for (const k of kids) {
      try {
        killGroup(k)
      } catch {
        /* already gone */
      }
    }
  })

  const server = spawn('cargo', ['run', '--quiet', '--release', '-p', 'game-server'], {
    detached: true,
    cwd: root,
    env: {
      ...process.env,
      BIND_ADDR: `127.0.0.1:${port}`,
      MAP_SCALE: 'small',
      GAME_LOG: 'warn',
      ...env,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  kids.push(server)

  let health = null
  for (let i = 0; i < 900 && !health; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (r.ok) health = await r.json()
    } catch {
      /* not listening yet */
    }
    if (!health) await sleep(250)
  }
  if (!health) {
    await close()
    throw new Error(`${label}: server on :${port} never became healthy`)
  }

  const vite = spawn('npx', ['vite', '--strictPort=false'], {
    detached: true,
    cwd: join(root, 'client'),
    env: { ...process.env, VITE_SERVER_PORT: String(port) },
  })
  kids.push(vite)
  const viteUrl = await new Promise((res, rej) => {
    const on = (b) => {
      const p = matchVitePort(b)
      if (p) res(`http://localhost:${p}`)
    }
    vite.stdout.on('data', on)
    vite.stderr.on('data', on)
    setTimeout(() => rej(new Error(`${label}: vite never started`)), 120_000)
  })

  browser = await chromium.launch({
    executablePath: chromePath,
    env: { ...process.env, LD_LIBRARY_PATH: libDir },
    args: [
      '--no-sandbox',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      // The client steps its fixed timestep off `requestAnimationFrame`, and
      // Chromium throttles rAF in any page that is not the foreground one — to
      // roughly one frame a second, or none at all. With two or three contexts
      // open only one of them is foreground, so every other client barely
      // simulates.
      //
      // That is the whole of `two-clients`' long-running mystery. Its own
      // comment records "polling from t=0 was tried and did not move the player
      // at all, for a reason I could not explain", and the numbers are exactly
      // this shape: holding D for the same wall-clock window moved bo 144.8 px
      // on one standalone run, 15.7 px on the next, and **0.0 px** inside the
      // suite. Three sessions recorded it as "fails under load, passes
      // standalone" and reached for longer sleeps, which only moves the
      // threshold (§A28) — the box was never the problem, backgrounding was.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  })
  console.log(`  stack: server :${port}  vite ${viteUrl}`)

  return {
    port,
    server,
    vite,
    viteUrl,
    browser,
    close,
    health: () => fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json()),
    /** A fresh context+page on the client, waited to `ready`. */
    openClient: (opts = {}) => openClient({ browser, viteUrl }, opts),
  }
}

/**
 * Open one client and wait until the game handle says it is connected.
 *
 * Returns the page plus the two helpers every check writes anyway, so a check
 * body is assertions and nothing else.
 */
export async function openClient({ browser, viteUrl }, { name = 'ana', query = '', code } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await ctx.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  const url =
    `${viteUrl}/?e2e=1&game=1&name=${encodeURIComponent(name)}` +
    (code ? `&code=${encodeURIComponent(code)}` : '') +
    query
  await page.goto(url)
  await page.waitForFunction('window.__game && window.__game.debug().ready === true', null, {
    timeout: 120_000,
  })
  const dbg = () => page.evaluate('window.__game.debug()')
  const shot = async (n) => {
    await page.screenshot({ path: join(shotsDir, `${n}.png`) })
    console.log(`  shot: shots/${n}.png`)
  }
  return { page, ctx, dbg, shot, pageErrors, name }
}

/**
 * Get this page from wherever it is into a **running round**.
 *
 * §C18: a fresh room is a Lobby and does not simulate. One human alone never
 * starts a battle, by design — so a check that wants combat has to press the
 * button a player presses. Everything about that is here:
 *
 *  - already fighting → returns immediately (a second client joining a started
 *    room, or a future rule change that starts on one player);
 *  - in a lobby → clicks `#lobby-start`, which asks the server for bots;
 *  - `waitPlaying` → waits out the warmup, because "not lobby" includes Warmup
 *    and no shot is fired during it.
 *
 * Throws with a named reason. `opts.press: false` is for the client that must
 * NOT press — a second human waiting for the first one's round.
 */
export async function enterBattle(page, opts = {}) {
  const { press = true, waitPlaying = false, timeoutMs = 45_000, label = 'enterBattle' } = opts
  const dbg = () => page.evaluate('window.__game.debug()')

  let d = await dbg()
  if (!d.ready) throw new Error(`${label}: the client is not connected (ready ${d.ready})`)

  if (d.phase === 'lobby' && press) {
    const hasButton = await page.evaluate(() => !!document.querySelector('#lobby-start'))
    if (!hasButton) {
      throw new Error(
        `${label}: in a lobby with no #lobby-start button — there is no way for a ` +
          `player to begin a round`,
      )
    }
    await page.click('#lobby-start')
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    d = await dbg()
    if (d.phase && d.phase !== 'lobby') break
    await sleep(250)
  }
  if (!d.phase || d.phase === 'lobby') {
    throw new Error(
      `${label}: still in the lobby after ${timeoutMs / 1000} s ` +
        `(press=${press}, players=${d.playerCount}) — the round never started`,
    )
  }

  // It has to be **simulating**, not merely out of the lobby.
  //
  // Asserted on `serverRoundTime`, not on `lastServerTick` and not on
  // `roundTime`. The tick is a clock and it advances in a lobby too
  // (`World::tick_idle`), so a moving tick proves nothing about whether anything
  // is being stepped; `round_time` advances only inside `step()`. And it has to
  // be the *server's* copy, because the client extrapolates `roundTime` every
  // frame between 20 Hz snapshots — `lobby-start` read the extrapolated one and
  // reported "the lobby is simulating: 0 -> 0.0166", which was 16 ms of
  // interpolation.
  //
  // Polled to a bound rather than slept for a constant: a fixed sleep measures
  // the box, and under suite load this one would have to be the slowest box's
  // number for every run (§A28).
  const r0 = (await dbg()).serverRoundTime ?? 0
  let r1 = r0
  const untilStepping = Date.now() + 8_000
  while (Date.now() < untilStepping) {
    r1 = (await dbg()).serverRoundTime ?? 0
    if (r1 > r0) break
    await sleep(100)
  }
  if (!(r1 > r0)) {
    throw new Error(
      `${label}: phase is "${d.phase}" but nothing is simulating — ` +
        `the server's round time is stuck at ${r0}`,
    )
  }

  if (waitPlaying) {
    const untilPlaying = Date.now() + timeoutMs
    while (Date.now() < untilPlaying) {
      d = await dbg()
      if (d.phase === 'playing') break
      await sleep(250)
    }
    if (d.phase !== 'playing') {
      throw new Error(`${label}: warmup never ended — phase stuck at "${d.phase}"`)
    }
  }

  const still = await page.evaluate(() => !!document.querySelector('#lobby-panel'))
  if (still) throw new Error(`${label}: the round started but the lobby panel is still on screen`)

  console.log(`  in battle (phase ${d.phase}, ${d.playerCount} players)`)
  return d
}

/**
 * Come to a stop, so the next shot is allowed to leave the barrel (§C20).
 *
 * Firing, throwing and swinging are refused while the player is moving under
 * their own power — `|vel.x| > FIRE_MOVE_MAX_SPEED`, or a movement key held this
 * tick. Every check that walks and then fires has to stand still first, exactly
 * as a player does.
 *
 * This is here and not in each check because three of them fire, and when §C20
 * landed all three broke in the same way and would have needed the same three
 * lines (§A24). The failures were also thoroughly misleading: `ordnance` timed
 * out "waiting for a melee swing to arrive", and `death` took 103 s instead of
 * 30, long enough for the weather to get there first — it reported the cause
 * line as `"Killed by weather"` rather than "the shot was refused".
 *
 * Waits on the **effect** (the body's own velocity, read back through the core)
 * rather than sleeping a constant, so a loaded box changes nothing (§A28).
 */
export async function standStill(page, { keys = ['a', 'd', 'w', 's'], timeoutMs = 4000 } = {}) {
  for (const k of keys) {
    try {
      await page.keyboard.up(k)
    } catch {
      /* never pressed */
    }
  }
  const max = await page.evaluate(() => window.__game.constants().FIRE_MOVE_MAX_SPEED)
  if (!Number.isFinite(max)) {
    // An assertion built on `undefined` cannot fail (§B15), and a *wait* built
    // on it cannot succeed. Say so rather than spinning to the deadline.
    throw new Error('standStill: FIRE_MOVE_MAX_SPEED is not exposed to the client')
  }
  const deadline = Date.now() + timeoutMs
  let vx = Infinity
  while (Date.now() < deadline) {
    const d = await page.evaluate('window.__game.debug()')
    vx = Math.abs(d.player?.vx ?? 0)
    if (vx <= max) return vx
    await sleep(50)
  }
  throw new Error(
    `standStill: still moving at ${vx.toFixed(1)} px/s after ${timeoutMs / 1000} s ` +
      `(FIRE_MOVE_MAX_SPEED is ${max}) — every shot from here will be refused`,
  )
}

/**
 * Select a weapon **by name**, not by the number key it happens to sit under.
 *
 * §C24 gave every weapon exactly one slot, which collapsed the dev loadout's
 * two bazooka stacks into one and shifted every index after the smg by one.
 * `ordnance` pressed Digit5 expecting the axe, got the flamethrower, and
 * reported "timed out waiting for a melee swing to arrive" — a rendering
 * failure, from a fixture that had selected the wrong item. Its own comment
 * said the hotkeys were safe because the loadout is "appended, never inserted";
 * that invariant was true and stopped being true, which is §B16 exactly.
 *
 * So the slot is looked up in the live inventory and the failure, when the
 * weapon is not held at all, says so.
 */
export async function selectWeapon(page, key) {
  // **Waited for, not read once.**
  //
  // `slots` is the client's copy of the server's `inventory` event, so right
  // after a throw or a pickup it can be a beat behind — and a beat is longer on
  // a loaded box. Read once, this reported `"bazooka" is not in the inventory.
  // Held: 2:smg 3:mine 4:axe 5:flamethrower 6:molotov` on a player that was
  // holding four rockets a hundred milliseconds earlier and used none: slot 1
  // was momentarily empty in a mid-update snapshot. The same check passed
  // standalone every time, which is what a race looks like.
  //
  // 2 s, then the same error as before — an inventory that has genuinely lost
  // the weapon still says so, and says it with the slot list.
  let slots = null
  const appear = Date.now() + 2000
  for (;;) {
    slots = await page.evaluate('window.__game.debug().slots')
    if (!Array.isArray(slots)) {
      throw new Error('selectWeapon: debug() exposes no `slots` — cannot select by name')
    }
    if (slots.some((s) => s.key === key) || Date.now() > appear) break
    await sleep(100)
  }
  const found = slots.find((s) => s.key === key)
  if (!found) {
    const held = slots.filter((s) => s.key).map((s) => `${s.slot + 1}:${s.key}`)
    throw new Error(
      `selectWeapon: "${key}" is not in the inventory after 2 s. Held: ${held.join(' ') || '(nothing)'}`,
    )
  }
  // Waited on, not slept. The selection is confirmed by the server's own
  // `inventory` event, so a fixed 250 ms is a bet on latency: under suite load
  // this read the slot list *between* the keypress and the update and reported
  // `selected "null"` — an empty slot — for an inventory that was about to be
  // correct. Re-read each time, because a slot index is only valid for the
  // inventory it was read from: an emptied stack frees its slot and everything
  // after it shifts.
  const deadline = Date.now() + 5000
  let last = null
  while (Date.now() < deadline) {
    const now = await page.evaluate('window.__game.debug().slots')
    if (Array.isArray(now)) {
      last = now
      const sel = now.find((s) => s.selected)
      if (sel && sel.key === key) return sel.slot
      const want = now.find((s) => s.key === key)
      if (want) await page.keyboard.press(`Digit${want.slot + 1}`)
    }
    await sleep(120)
  }
  const held = (last ?? []).filter((s) => s.key).map((s) => `${s.slot + 1}:${s.key}x${s.count}`)
  throw new Error(
    `selectWeapon: "${key}" never became the selected slot within 5 s. ` +
      `Held: ${held.join(' ') || '(nothing)'}; selected: ` +
      `"${(last ?? []).find((s) => s.selected)?.key ?? 'none'}"`,
  )
}
