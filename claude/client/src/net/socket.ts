/**
 * A thin typed wrapper over socket.io-client. No game logic lives here.
 *
 * The one non-obvious behaviour: handlers registered with `on()` before
 * `connect()` are queued and attached once the socket exists. Scenes are
 * constructed before the connection is established, so without the queue every
 * scene would have to defer its own registration.
 */

import { io, type Socket } from 'socket.io-client'

export type ConnectionState = 'disconnected' | 'connecting' | 'connected'

export type Handler = (...args: unknown[]) => void

export interface NetOptions {
  /** Defaults to same-origin, which is what both the Vite proxy and nginx expect. */
  url?: string
  /** Injectable for tests. */
  factory?: (url: string | undefined) => Socket
}

export class Net {
  private socket: Socket | null = null
  private readonly pending: Array<[string, Handler]> = []
  private readonly stateHandlers: Array<(s: ConnectionState) => void> = []
  private state: ConnectionState = 'disconnected'
  private readonly options: NetOptions

  constructor(options: NetOptions = {}) {
    this.options = options
  }

  connect(): void {
    if (this.socket) return
    this.setState('connecting')

    const factory = this.options.factory ?? ((url) => (url ? io(url) : io()))
    const socket = factory(this.options.url)
    this.socket = socket

    socket.on('connect', () => this.setState('connected'))
    socket.on('disconnect', () => this.setState('disconnected'))

    for (const [event, handler] of this.pending) {
      socket.on(event, handler)
    }
    this.pending.length = 0
  }

  /** Safe before `connect()`: the handler is queued and attached on connect. */
  on(event: string, handler: Handler): void {
    if (this.socket) {
      this.socket.on(event, handler)
    } else {
      this.pending.push([event, handler])
    }
  }

  /** A no-op before `connect()` rather than a throw — a dropped input is normal. */
  emit(event: string, payload?: unknown): void {
    if (!this.socket) return
    if (payload === undefined) this.socket.emit(event)
    else this.socket.emit(event, payload)
  }

  onState(handler: (s: ConnectionState) => void): void {
    this.stateHandlers.push(handler)
    handler(this.state)
  }

  get connectionState(): ConnectionState {
    return this.state
  }

  /** `'websocket'` or `'polling'`. Undefined before the handshake completes. */
  get transport(): string | undefined {
    const engine = (this.socket?.io as { engine?: { transport?: { name?: string } } } | undefined)
      ?.engine
    return engine?.transport?.name
  }

  get id(): string | undefined {
    return this.socket?.id
  }

  disconnect(): void {
    this.socket?.disconnect()
    this.socket = null
    this.setState('disconnected')
  }

  private setState(s: ConnectionState): void {
    if (this.state === s) return
    this.state = s
    for (const h of this.stateHandlers) h(s)
  }
}
