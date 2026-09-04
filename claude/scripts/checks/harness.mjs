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
/**
 * Exported so a check that drives a **built bundle** instead of the dev server —
 * `no-dev-surface` — gets the browser the same way. `playwright-core` is
 * resolved through `client/package.json`, so importing it directly from
 * `scripts/` does not find it.
 */
export const { chromium } = require('playwright-core')

/**
 * Where the hand-extracted chromium libs live on this box, and the browser
 * binary itself. Exported so a check that drives a **built bundle** rather than
 * the dev server — `no-dev-surface` — can launch the same browser the same way
 * without a second copy of the LD_LIBRARY_PATH incantation.
 */
export const libDir = join(process.env.HOME ?? '', '.cache/pwlibs/root/usr/lib/x86_64-linux-gnu')
export const chromePath = join(
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
export async function openClient(
  { browser, viteUrl },
  { name = 'ana', query = '', code, skin } = {},
) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await ctx.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  // **`skin` is a URL parameter and has to be** (T20.04). `GameScene` reads its
  // skin at scene create, which is the frame after `goto` — so the
  // `page.evaluate(localStorage.setItem)` pattern `lobby.mjs` uses runs too late
  // on this path, and two clients built that way both come up skin 0 with their
  // frames matching. That is the shape that gets a threshold loosened at 2am.
  const url =
    `${viteUrl}/?e2e=1&game=1&name=${encodeURIComponent(name)}` +
    (code ? `&code=${encodeURIComponent(code)}` : '') +
    (skin === undefined ? '' : `&skin=${encodeURIComponent(String(skin))}`) +
    query
  await page.goto(url)
  // **Seated, not ready** (§E1).
  //
  // `ready` is true only once the world exists, and the world is built at
  // *match start* — so waiting on it here does not mean "this client is in a
  // room", it means "this client's lobby has already closed". That is fatal for
  // any check that opens two clients: ana's lobby times out while she is being
  // waited for, §E4 then refuses bo, and quick match puts him in a room of his
  // own. Different seeds, one player each, terrain that cannot agree — which is
  // exactly what `two-clients` and `full-round` reported.
  //
  // `welcome` arrives at seat time and carries the phase, so this is the first
  // moment a client is genuinely in a room, and it is still in the lobby.
  await page.waitForFunction(
    'window.__game && typeof window.__game.debug().phase === "string" && window.__game.debug().me >= 0',
    null,
    { timeout: 120_000 },
  )
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
  const {
    press = true,
    waitPlaying = false,
    expectPlayers = 1,
    timeoutMs = 45_000,
    label = 'enterBattle',
  } = opts
  const dbg = () => page.evaluate('window.__game.debug()')

  let d = await dbg()
  // **Seated is the precondition; `ready` is the post-condition** (§E1).
  //
  // This used to demand `ready` before starting a round, which is circular now:
  // `ready` needs a world, and the world is built when the match starts — which
  // is the thing this function exists to cause. A client in a lobby is
  // connected and has no world, and that is the normal state to arrive here in.
  if (typeof d.phase !== 'string' || !(d.me >= 0)) {
    throw new Error(`${label}: the client is not seated (phase ${d.phase}, me ${d.me})`)
  }

  if (d.phase === 'lobby' && press) {
    // **The verb, not the button** (§E1, T17.07). `#lobby-start` lived on a DOM
    // panel `GameScene` drew over the world; a player waits in the *menu* now,
    // and a client that reached this scene at all has a match. What is left on
    // this path is the debug surface, which emits exactly what the button did.
    //
    // Kept as a throw rather than a silent skip: a check asking to start a round
    // and finding no way to is a finding, not something to wait out.
    const canStart = await page.evaluate(
      () => typeof window.__game?.startWithBots === 'function',
    )
    if (!canStart) {
      throw new Error(
        `${label}: in a lobby with no way to start — __game.startWithBots is ` +
          `missing, so a player has no way to begin a round`,
      )
    }
    await page.evaluate(() => window.__game.startWithBots())
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

  // **The roster, waited on rather than read once.**
  //
  // `worldMirror` fills `players` from the **snapshot**, which is the full
  // roster including self (`docs/40` §3) — not a delta. So an empty roster does
  // not mean "a join has not arrived", it means **no snapshot has been applied
  // yet**: the server starts the 20 Hz stream as soon as it seats you, so the
  // first snapshots land while `map_init` is still decoding and wait in
  // `pendingSnapshot` (`GameScene.ts:330-338`).
  //
  // Defaults to 1 — every client is in its own roster — so this is a no-op for
  // the 18 single-client callers (24 sites, 6 opt-ins). Multi-client checks opt
  // in with
  // `expectPlayers: 2`, the same shape `waitPlaying` already has. Keyed to the
  // observable effect and **not** to a constant, because no constant governs a
  // network round-trip plus a mask decode; inventing one would be a tunable
  // nobody chose (`CLAUDE.md`, and the same call T19.04 made for `standStill`).
  const untilSeated = Date.now() + timeoutMs
  while (Date.now() < untilSeated) {
    d = await dbg()
    if ((d.playerCount ?? 0) >= expectPlayers) break
    await sleep(100)
  }
  // Fails **loudly**. A wait that times out silently into "0 players" is the bug
  // being fixed wearing a different hat.
  if ((d.playerCount ?? 0) < expectPlayers) {
    throw new Error(
      `${label}: the roster never reached ${expectPlayers} — still ` +
        `${d.playerCount} after ${timeoutMs / 1000} s (phase ${d.phase}, ` +
        `server tick ${d.lastServerTick})` +
        ((d.playerCount ?? 0) === 0
          ? ' — no snapshot has been applied at all'
          : ' — snapshots are arriving, so the missing players never joined'),
    )
  }

  const still = await page.evaluate(() => !!document.querySelector('#lobby-panel'))
  if (still) throw new Error(`${label}: the round started but the lobby panel is still on screen`)

  // `d` is re-read above, so this reports the roster **now** rather than the one
  // captured before the simulating-wait. The stale read is what produced the
  // reported `in battle (phase warmup, 0 players)`: measured over 10 runs, the
  // stale value was 0 in 8 of them and the fresh value was 2 in **10 of 10**,
  // with every run passing. The "join race" was a lying log line.
  console.log(`  in battle (phase ${d.phase}, ${d.playerCount} players)`)
  return d
}

/**
 * Release the movement keys and let the body **settle**.
 *
 * ## What this used to be, and why it changed
 *
 * It waited for `|vel.x|` to fall below `FIRE_MOVE_MAX_SPEED`, because §C20
 * refused every shot from a moving player and a check that walked and then
 * fired had to stand still first. **§F4 repealed §C20** — you fire while
 * running, jumping and jetpacking — and the constant is retired, so the old
 * body would have thrown `FIRE_MOVE_MAX_SPEED is not exposed` in **twelve**
 * checks the moment it went.
 *
 * It is kept rather than deleted because the *other* reason to call it survives:
 * a check that measures a position, aims at a screen point, or photographs a
 * frame wants the body to have stopped drifting first. That is settling, not
 * permission.
 *
 * ## Keyed to the effect, not to a threshold
 *
 * There is no "stopped" constant any more and inventing one would be a tunable
 * nobody chose (`CLAUDE.md`). So this waits until the velocity **stops
 * changing** — two consecutive equal readings, or zero — which is the same
 * question asked without a number, and works on a slope where the body never
 * quite reaches zero.
 *
 * **On the ground, though.** "Unchanging" means "settled" only while something
 * is slowing the body down. `AIR_DRAG` is a small fraction of
 * `GROUND_FRICTION`, so a body in flat flight yields two bit-identical readings
 * 50 ms apart and a bare equality test reports it as settled at walking speed —
 * against `teleport`, `birds` and `death`, all of which call this where the body
 * can be airborne. `grounded` is the term that separates "friction has finished
 * with it" from "nothing is slowing it down", and it costs no new tunable.
 *
 * ## What it throws for, and what it does not
 *
 * Failing to settle is **not** fatal any more: it used to mean every following
 * shot was refused, and now it means a slightly noisy measurement, so this
 * reports and returns the speed it reached. A helper that aborts twelve checks
 * for a condition that no longer breaks anything is the landmine this task
 * exists to defuse.
 *
 * An **absent body** is the opposite case and still throws. `debug().player` is
 * `core.playerState(me)`, which is null only before the scene has seated a local
 * body — **not** while one is dead. `player_state` keys on `players.iter().find(|p|
 * p.id == id)`: id presence, not `alive`. A dead player still has an entry, so this
 * stays populated right through death and respawn, and nobody should skip a
 * `standStill` after a death to dodge a throw that cannot fire there. Reading
 * `?? 0` off a genuinely absent body and calling zero "settled" hands
 * every caller a silent pass against a page that never started. That is §B15's
 * shape ("an assertion on a field that does not exist cannot fail") arriving in
 * a *wait* instead of an assertion, and it is what the retired
 * `FIRE_MOVE_MAX_SPEED` probe used to catch on the way past.
 */
export async function standStill(page, { keys = ['a', 'd', 'w', 's'], timeoutMs = 4000 } = {}) {
  for (const k of keys) {
    try {
      await page.keyboard.up(k)
    } catch {
      /* never pressed */
    }
  }
  const deadline = Date.now() + timeoutMs
  let vx = Infinity
  let previous = Infinity
  while (Date.now() < deadline) {
    const d = await page.evaluate('window.__game.debug()')
    const body = d.player
    // A missing body is a broken page, not a stopped one. Fail loudly rather
    // than returning a settled-looking zero.
    if (!body || typeof body.vx !== 'number' || typeof body.grounded !== 'boolean') {
      throw new Error(
        'standStill: window.__game.debug().player is absent or malformed ' +
          `(${JSON.stringify(body)}) — there is no local player to settle, so it ` +
          'has not been seated in the world yet, or the debug bridge is broken',
      )
    }
    vx = Math.abs(body.vx)
    // Settled: on the ground, and either at rest or no longer slowing.
    // `previous` starts at Infinity so the first reading can never satisfy the
    // equality by accident.
    if (body.grounded && (vx === 0 || vx === previous)) return vx
    previous = vx
    await sleep(50)
  }
  console.log(`  standStill: still drifting at ${vx.toFixed(1)} px/s after ${timeoutMs / 1000} s`)
  return vx
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
