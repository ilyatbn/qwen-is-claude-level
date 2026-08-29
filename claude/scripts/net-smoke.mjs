#!/usr/bin/env node
/**
 * Join the real server N times with the client that actually ships.
 *
 *   node scripts/net-smoke.mjs [n]
 *
 * This exists because of a bug that cost most of a session. `tests/join.rs` was
 * ~50 % flaky on the first `welcome`, with an empty inbox, and every hypothesis
 * pointed at the server: the room blocking a worker, snapshots racing `map_init`,
 * raw binary attachments. The thing that actually located it was running the
 * **shipping** client against the same server — `socket.io-client`, which buffers
 * emits until the namespace handshake completes — and watching it join 100 times
 * out of 100. The defect was in `rust_socketio`, which does not buffer, so the
 * `join` emitted immediately after `connect()` went on the floor with no error.
 *
 * So this is the control for that experiment, kept permanently: if the Rust
 * integration tests go red, run this. If it is green, the protocol and the server
 * are fine and the harness is lying.
 *
 * It drives node's `socket.io-client` rather than a browser deliberately — it is
 * the same library the browser bundles, and it needs no display, no proxy and no
 * Local Network Access exemption.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { killGroup } from './proc-group.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'client/package.json'))
const { io } = await import(require.resolve('socket.io-client'))

const N = Number(process.argv[2] ?? 25)
const PORT = 3111 // not 3000, so a dev server left running does not get joined instead

/**
 * The lobby's bot timer, **set for this run and used to size the deadline**.
 *
 * This fixture predates lobbies. It joined a game directly, so 10 s was a
 * generous ceiling on a handshake. T17 put a lobby in front of the join: a
 * client now waits in one until it fills to `LOBBY_CAPACITY` or until
 * `LOBBY_BOT_TIMEOUT` expires and bots take the empty seats — and only then is
 * there a match, and a `map_init` to receive.
 *
 * `LOBBY_BOT_TIMEOUT` ships at 10 s and the deadline here was **also** 10 s, so
 * the fixture's ceiling and the feature's timer were the same number and the
 * run was a coin flip on which fired first. That is why the failure count
 * varied between runs — 13, then 5 — with every failure sitting at
 * `TIMEOUT, mapBytes: 0`: not a client failing to join, but a client asked
 * about a map before its lobby had decided to make one.
 *
 * The capacity arithmetic never applied: the joins below are sequential
 * (`await joinOnce(i)`), so there is only ever **one** client connected and it
 * is always alone in its lobby. Every client waits out the whole timer; none of
 * them ever fills a lobby. Set low here through the knob T17.08 added, which
 * also takes the stage from ~25 x 10 s to ~25 x 1 s.
 */
const LOBBY_BOT_TIMEOUT_S = 1

/**
 * How long one join may take: the lobby's wait plus room for the work around it.
 *
 * **Derived from the timer above, not spelled**, which is the whole point — a
 * wait hardcoded against a tunable is a test that expires, and this one did.
 * The headroom covers the socket handshake, map generation and the base64
 * `map_init` transfer, none of which are instant on a loaded box.
 */
const JOIN_HEADROOM_MS = 8000
const JOIN_DEADLINE_MS = Math.round(LOBBY_BOT_TIMEOUT_S * 1000) + JOIN_HEADROOM_MS

const server = spawn('cargo', ['run', '--quiet', '-p', 'game-server'], {
  detached: true,
  cwd: root,
  env: {
    ...process.env,
    BIND_ADDR: `127.0.0.1:${PORT}`,
    MAP_SCALE: 'small',
    GAME_LOG: 'warn',
    LOBBY_BOT_TIMEOUT: String(LOBBY_BOT_TIMEOUT_S),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
})
const stop = () => {
  try {
    killGroup(server)
  } catch {
    /* already gone */
  }
}
process.on('exit', stop)

// Poll `/healthz` rather than scraping stdout — the banner is hidden at GAME_LOG=warn.
let up = false
for (let i = 0; i < 600 && !up; i++) {
  try {
    up = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok
  } catch {
    /* not listening yet */
  }
  if (!up) await new Promise((r) => setTimeout(r, 250))
}
if (!up) {
  console.error('server never became healthy')
  process.exit(1)
}

/** One full join round-trip: connect, join, welcome + map_init, disconnect. */
function joinOnce(i) {
  return new Promise((resolve) => {
    const s = io(`http://127.0.0.1:${PORT}`, { forceNew: true, transports: ['websocket'] })
    const got = {}
    const t0 = Date.now()
    const finish = (verdict) => {
      try {
        s.close()
      } catch {
        /* already closed */
      }
      resolve({ verdict, ms: Date.now() - t0, mapBytes: got.map_init ?? 0 })
    }
    const timer = setTimeout(() => finish('TIMEOUT'), JOIN_DEADLINE_MS)
    const done = () => {
      if (got.welcome && got.map_init) {
        clearTimeout(timer)
        finish('OK')
      }
    }
    s.on('connect', () => s.emit('join', { name: `smoke${i}`, skin_id: 0 }))
    s.on('connect_error', (e) => {
      clearTimeout(timer)
      finish(`connect_error:${e.message}`)
    })
    s.on('join_error', (e) => {
      clearTimeout(timer)
      finish(`join_error:${JSON.stringify(e)}`)
    })
    s.on('welcome', () => {
      got.welcome = true
      done()
    })
    s.on('map_init', (b) => {
      got.map_init = typeof b === 'string' ? b.length : -1
      done()
    })
  })
}

const results = []
for (let i = 0; i < N; i++) results.push(await joinOnce(i))

const ok = results.filter((r) => r.verdict === 'OK')
const bad = results.filter((r) => r.verdict !== 'OK')
const lat = ok.map((r) => r.ms).sort((a, b) => a - b)

// A join that "succeeds" with an empty map is the failure this cannot afford to
// call a pass — base64 `map_init` is the one payload the whole round depends on.
const emptyMaps = ok.filter((r) => r.mapBytes < 1000)

console.log(
  JSON.stringify(
    {
      attempts: results.length,
      ok: ok.length,
      failed: bad.length,
      mapBytes: ok[0]?.mapBytes ?? 0,
      latency_ms: lat.length ? { min: lat[0], p50: lat[lat.length >> 1], max: lat.at(-1) } : null,
      failures: bad.slice(0, 5),
    },
    null,
    1,
  ),
)

stop()
if (bad.length || emptyMaps.length || ok.length !== N) {
  console.error(`net smoke FAILED: ${bad.length} failed, ${emptyMaps.length} with an empty map`)
  process.exit(1)
}
console.log(`net smoke: ${ok.length}/${N} joined`)
