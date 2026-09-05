/**
 * Transport only. No game logic lives here — `WorldMirror` owns the state and
 * scenes own the rendering.
 *
 * The one behaviour worth knowing: `connect()` resolves on `welcome`, not on the
 * socket opening. A socket that is open but has not been seated cannot do
 * anything useful, and callers that treat "connected" as "in the game" race the
 * handshake. That race is not hypothetical — it cost a session on the server side
 * (`docs/70-amendments-v2.md` §A28), where a client emitted `join` before the
 * namespace handshake landed and the message was dropped with no error.
 * `socket.io-client` buffers emits until connected, so this side is safe by
 * construction; resolving on `welcome` makes it safe by contract too.
 */

import { io } from 'socket.io-client'
import { encodeInputBatch, type InputFrame } from './codec'
import { identityPayload } from './lobby'
import type { Appearance } from '../ui/skins'

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed'

export interface Welcome {
  playerId: number
  tick: number
  roundTime: number
  phase: string
  simHz: number
  snapshotHz: number
  /**
   * §E6: `players` and `scale` are gone.
   *
   * Both are said better by `lobby_state`, and keeping them put two sources of
   * truth on one wire — `scale` is *provisional* the moment §E3 lets a host
   * change it, and `players` came from the world's roster. `welcome` now carries
   * only what is true at the instant of seating and never changes.
   *
   * `maxPlayers` is parsed here and read by nothing — dead, and left alone
   * because removing it is not this task's.
   */
  /** A string on the wire: a u64 seed does not survive JSON's number type. */
  seed: string
  maxPlayers: number
}

/**
 * Handlers receive the payload **as sent**.
 *
 * An earlier version coerced everything to `Record<string, unknown>`, which
 * silently turned the two payloads that are plain strings — `map_init` and
 * `snapshot`, both base64 (§A27) — into `{}`. The client then ignored every
 * map and every snapshot while looking completely healthy: connected, seated,
 * no errors. Use `asRecord` for the JSON events.
 */
export type EventHandler = (payload: unknown) => void

/** Injectable so tests can drive the whole flow without a server. */
export interface SocketLike {
  on(event: string, cb: (...args: unknown[]) => void): void
  emit(event: string, ...args: unknown[]): void
  close(): void
  connected?: boolean
}

export interface ConnectionOptions {
  factory?: (url: string | undefined) => SocketLike
  /** How long to wait for `welcome` before rejecting. */
  joinTimeoutMs?: number
  /** Injectable clock, so the timeout is testable without waiting. */
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

/** What the menu decided, carried to the socket that acts on it. */
export type LobbyIntent =
  | { kind: 'quick'; scale: string; tombstoneSkinId?: number }
  | { kind: 'create'; scale: string; tombstoneSkinId?: number }
  | { kind: 'code'; code: string; tombstoneSkinId?: number }

/**
 * Events whose payload is a **current value**, not a change — so a subscriber
 * that arrives late still needs the last one.
 *
 * `inventory` is the whole 24-slot array on every change (`docs/30` §6), and the
 * server sends it once at match start (`broadcast_inventories`) immediately after
 * `map_init`. But `map_init` is what moves the player from `MenuScene` to
 * `GameScene`, and `GameScene` registers its `inventory` handler in `create()` —
 * a frame later. So for **every** client that reaches a match through the menu,
 * the one `inventory` it will get for its first life landed on a socket with no
 * listener and was dropped: `debug().slots` stayed all-null for the whole round,
 * `harness.mjs::selectWeapon` could not select by name, and a player's quick bar
 * had nothing to draw until they happened to pick something up (T19.18).
 *
 * A set rather than a fourth bespoke buffer. `MenuScene` already hand-buffers
 * `map_init` and `lobby_state` through the scene registry; those two also *drive*
 * the handover, so they keep their own path. Anything that is purely a current
 * value belongs here, where the next one is a one-line addition rather than a
 * fourth thing to remember.
 */
const LATCHED_EVENTS = new Set(['inventory'])

export class Connection {
  private socket: SocketLike | null = null
  private readonly handlers = new Map<string, EventHandler[]>()
  /** The last payload seen for each `LATCHED_EVENTS` name. */
  private readonly latched = new Map<string, unknown>()
  private _state: ConnectionState = 'closed'
  private readonly opts: ConnectionOptions
  private stateCbs: Array<(s: ConnectionState) => void> = []

  constructor(opts: ConnectionOptions = {}) {
    this.opts = opts
  }

  get state(): ConnectionState {
    return this._state
  }

  onState(cb: (s: ConnectionState) => void): void {
    this.stateCbs.push(cb)
  }

  /**
   * Resolves once the server has seated us and sent `welcome`. Rejects on
   * `join_error` or on timeout — both are terminal for this attempt, and a
   * caller that cannot tell them apart cannot show a useful message.
   */
  /**
   * How this client wants to be seated (§B9).
   *
   * The menu records an intent and `Connection` performs it, rather than the
   * menu owning a second socket: two sockets would mean two seats, and a
   * `join` after a `quick_match` is a double join. Every verb ends in
   * `welcome`, so the promise's contract is unchanged.
   */
  /**
   * Deliver an event to this client's own handlers, as if it had arrived.
   *
   * For headless checks that need a specific server event without having to
   * manufacture the game state that produces it. It runs the **real** handlers,
   * so what it exercises is the production path — it only skips the wire.
   */
  emitLocal(event: string, payload: unknown): void {
    // Latched here too: this is "as if it had arrived", and a locally injected
    // `inventory` that a later subscriber could not see would be a second
    // delivery rule for the same event.
    if (LATCHED_EVENTS.has(event)) this.latched.set(event, payload)
    for (const h of this.handlers.get(event) ?? []) h(payload)
  }

  /**
   * `look` rather than `skinId` (T20.12).
   *
   * **This built its own join payload**, spelling three fields by hand while
   * `lobby.ts::identityPayload` built the other four verbs' — the second-builder
   * shape, and it would have dropped the accessories silently on the `?game=1`
   * path while the menu path carried them. It goes through the one builder now.
   */
  connect(
    url: string | undefined,
    name: string,
    look: Appearance,
    intent?: LobbyIntent,
  ): Promise<Welcome> {
    if (this.socket) return Promise.reject(new Error('already connected'))
    this.setState('connecting')

    const factory =
      this.opts.factory ??
      ((u: string | undefined) => (u ? io(u) : io()) as unknown as SocketLike)
    const socket = factory(url)
    this.socket = socket

    // Attach every registered handler, plus the ones we own.
    for (const [event, list] of this.handlers) {
      for (const h of list) socket.on(event, (...a: unknown[]) => h(a[0]))
    }
    // The latch listens whether or not anybody has subscribed yet — which is the
    // whole point, since the case it exists for is nobody having subscribed.
    for (const event of LATCHED_EVENTS) {
      socket.on(event, (...a: unknown[]) => this.latched.set(event, a[0]))
    }

    socket.on('connect', () => {
      this.setState('connected')
      const id = identityPayload({
        name,
        ...look,
        tombstoneSkinId: intent?.tombstoneSkinId ?? 0,
      })
      switch (intent?.kind) {
        case 'quick':
          socket.emit('quick_match', { ...id, scale: intent.scale })
          break
        case 'create':
          socket.emit('create_room', { ...id, scale: intent.scale, private: true })
          break
        case 'code':
          socket.emit('join_room', { ...id, code: intent.code })
          break
        default:
          socket.emit('join', id)
      }
    })
    socket.on('disconnect', () => this.setState('reconnecting'))

    const setT = this.opts.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms))
    const clearT = this.opts.clearTimeout ?? ((h) => globalThis.clearTimeout(h as number))

    return new Promise<Welcome>((resolve, reject) => {
      let settled = false
      const timer = setT(() => {
        if (settled) return
        settled = true
        reject(new Error('join timed out'))
      }, this.opts.joinTimeoutMs ?? 15_000)

      socket.on('welcome', (...a: unknown[]) => {
        if (settled) return
        settled = true
        clearT(timer)
        resolve(parseWelcome(asRecord(a[0])))
      })
      socket.on('join_error', (...a: unknown[]) => {
        if (settled) return
        settled = true
        clearT(timer)
        const reason = String(asRecord(a[0]).reason ?? 'unknown')
        reject(new Error(`join refused: ${reason}`))
      })
    })
  }

  /**
   * Safe before `connect()`: queued and attached when the socket is made.
   *
   * For a `LATCHED_EVENTS` name that has **already arrived**, the last payload is
   * replayed to this handler — see that set for why. Replayed on a microtask
   * rather than inline: a handler that runs *inside* `on()` re-enters whatever is
   * registering it, and every caller here registers from a scene's `create()`
   * with half its fields still unbuilt. The microtask runs once `create()` has
   * returned, which is the state the handler was written against.
   */
  on(event: string, cb: EventHandler): void {
    const list = this.handlers.get(event) ?? []
    list.push(cb)
    this.handlers.set(event, list)
    if (this.socket) this.socket.on(event, (...a: unknown[]) => cb(a[0]))
    if (LATCHED_EVENTS.has(event) && this.latched.has(event)) {
      const payload = this.latched.get(event)
      queueMicrotask(() => cb(payload))
    }
  }

  /**
   * Base64, not a binary attachment — a payload containing engine.io's `0x1e`
   * separator kills the socket outright (`docs/70-amendments-v2.md` §A27).
   */
  sendInput(batch: readonly InputFrame[]): void {
    if (!batch.length) return
    this.emit('input', toBase64(encodeInputBatch(batch)))
  }

  /** Escape hatch for events with no typed helper yet, e.g. `ready`. */
  sendRaw(event: string, payload: unknown): void {
    this.emit(event, payload)
  }

  /**
   * Ready, or no longer ready (§E3/§E6).
   *
   * Typed rather than `sendRaw('ready', {})`, because the payload is now
   * load-bearing: a private lobby starts when every human is ready, so
   * un-readying has to be able to hold the match back. The server reads an
   * absent `on` as `true`, which is what keeps every check written before this
   * working — but a client that means "no" has to say so.
   */
  sendReady(on: boolean): void {
    this.sendRaw('ready', { on })
  }

  /**
   * Ask to change the map size (§E3).
   *
   * Refused with `lobby_error` unless the sender is the lobby's
   * `settings_owner`. The refusal is **not** `join_error`: that handler is
   * registered during the connect handshake and drops anything arriving after
   * the promise settles, which is every possible `set_scale`.
   */
  sendSetScale(scale: string): void {
    this.sendRaw('set_scale', { scale })
  }

  /**
   * §F7's three private-lobby settings. Refused with `lobby_error` for
   * `set_scale`'s reasons — host-only, private-only, and before the start.
   *
   * The payload keys are the wire's (`bots`, `start_kit`, `round_seconds`),
   * spelled here rather than derived from the setting id: `parseLobbyState` has
   * no unknown-key detection, so a mismatch would silently read as a default
   * rather than as an error.
   */
  sendSetBots(bots: boolean): void {
    this.sendRaw('set_bots', { bots })
  }

  sendSetStartKit(startKit: string): void {
    this.sendRaw('set_start_kit', { start_kit: startKit })
  }

  /** Seconds, always. Minutes exist only on screen (`minutesLabel`). */
  sendSetRoundSeconds(seconds: number): void {
    this.sendRaw('set_round_seconds', { round_seconds: seconds })
  }

  sendUseItem(slot: number): void {
    this.emit('use_item', { slot })
  }

  sendSelectSlot(slot: number): void {
    this.emit('select_slot', { slot })
  }

  sendFire(): void {
    this.emit('fire', {})
  }

  /** §C9: `Q`. Slotless — the counters are not inventory. */
  sendUseHeal(): void {
    this.emit('use_heal', {})
  }

  /** §C9: `R`. */
  sendUseBattery(): void {
    this.emit('use_battery', {})
  }

  /** §C11: `E`. Slotless — the server picks by the documented order. */
  sendQuickThrow(): void {
    this.emit('quick_throw', {})
  }

  sendVoteRestart(restart: boolean): void {
    this.emit('vote_restart', { restart })
  }

  requestResync(): void {
    this.emit('resync_map', {})
  }

  /** §C18's solo path: seat bots and start the round from the lobby. */
  sendStartWithBots(): void {
    this.emit('start_with_bots', {})
  }

  close(): void {
    this.socket?.close()
    this.socket = null
    this.setState('closed')
  }

  /** A dropped message is normal under lag; never throw from the send path. */
  private emit(event: string, payload: unknown): void {
    if (!this.socket) return
    this.socket.emit(event, payload)
  }

  private setState(s: ConnectionState): void {
    if (this._state === s) return
    this._state = s
    for (const cb of this.stateCbs) cb(s)
  }
}

/** JSON events arrive as objects; anything else becomes an empty record. */
export function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
}

function num(v: unknown, dflt = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt
}

export function parseWelcome(p: Record<string, unknown>): Welcome {
  return {
    playerId: num(p['player_id']),
    tick: num(p['tick']),
    roundTime: num(p['round_time']),
    phase: String(p['phase'] ?? 'lobby'),
    simHz: num(p['sim_hz'], 60),
    snapshotHz: num(p['snapshot_hz'], 20),
    // Kept as a string all the way to the HUD: `Number` would round a u64 seed
    // and a bug report carrying a rounded seed reproduces a different map.
    seed: String(p['seed'] ?? '0'),
    maxPlayers: num(p['max_players'], 6),
  }
}

/** `btoa` in the browser, `Buffer` under node — the tests run under node. */
export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  if (typeof globalThis.btoa === 'function') {
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return globalThis.btoa(s)
  }
  return Buffer.from(bytes).toString('base64')
}

export function fromBase64(s: string): ArrayBuffer {
  if (typeof globalThis.atob === 'function') {
    const bin = globalThis.atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out.buffer
  }
  const b = Buffer.from(s, 'base64')
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}
