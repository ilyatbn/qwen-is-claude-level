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

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed'

export interface Welcome {
  playerId: number
  tick: number
  roundTime: number
  phase: string
  simHz: number
  snapshotHz: number
  players: Array<{ id: number; name?: string | undefined; skin_id: number; score: number }>
  /** A string on the wire: a u64 seed does not survive JSON's number type. */
  seed: string
  scale: string
  maxPlayers: number
}

export type EventHandler = (payload: Record<string, unknown>) => void

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

export class Connection {
  private socket: SocketLike | null = null
  private readonly handlers = new Map<string, EventHandler[]>()
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
  connect(url: string | undefined, name: string, skinId: number): Promise<Welcome> {
    if (this.socket) return Promise.reject(new Error('already connected'))
    this.setState('connecting')

    const factory =
      this.opts.factory ??
      ((u: string | undefined) => (u ? io(u) : io()) as unknown as SocketLike)
    const socket = factory(url)
    this.socket = socket

    // Attach every registered handler, plus the ones we own.
    for (const [event, list] of this.handlers) {
      for (const h of list) socket.on(event, (...a: unknown[]) => h(asRecord(a[0])))
    }

    socket.on('connect', () => {
      this.setState('connected')
      socket.emit('join', { name, skin_id: skinId })
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

  /** Safe before `connect()`: queued and attached when the socket is made. */
  on(event: string, cb: EventHandler): void {
    const list = this.handlers.get(event) ?? []
    list.push(cb)
    this.handlers.set(event, list)
    if (this.socket) this.socket.on(event, (...a: unknown[]) => cb(asRecord(a[0])))
  }

  /**
   * Base64, not a binary attachment — a payload containing engine.io's `0x1e`
   * separator kills the socket outright (`docs/70-amendments-v2.md` §A27).
   */
  sendInput(batch: readonly InputFrame[]): void {
    if (!batch.length) return
    this.emit('input', toBase64(encodeInputBatch(batch)))
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

  sendToggleFlashlight(): void {
    this.emit('toggle_flashlight', {})
  }

  sendVoteRestart(restart: boolean): void {
    this.emit('vote_restart', { restart })
  }

  requestResync(): void {
    this.emit('resync_map', {})
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

function asRecord(v: unknown): Record<string, unknown> {
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
    players: Array.isArray(p['players'])
      ? (p['players'] as Array<Record<string, unknown>>).map((q) => ({
          id: num(q['id']),
          name: typeof q['name'] === 'string' ? q['name'] : undefined,
          skin_id: num(q['skin_id']),
          score: num(q['score']),
        }))
      : [],
    // Kept as a string all the way to the HUD: `Number` would round a u64 seed
    // and a bug report carrying a rounded seed reproduces a different map.
    seed: String(p['seed'] ?? '0'),
    scale: String(p['scale'] ?? 'medium'),
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
