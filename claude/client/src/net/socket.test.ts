import { describe, it, expect, vi } from 'vitest'
import { Net } from './socket'
import type { Socket } from 'socket.io-client'

/** A socket.io double that records registrations and lets a test fire events. */
function fakeSocket() {
  const handlers = new Map<string, Array<(...a: unknown[]) => void>>()
  const emitted: Array<[string, unknown]> = []
  const s = {
    id: 'fake-id',
    io: { engine: { transport: { name: 'websocket' } } },
    on(event: string, handler: (...a: unknown[]) => void) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return s
    },
    emit(event: string, payload?: unknown) {
      emitted.push([event, payload])
      return s
    },
    disconnect() {
      return s
    },
  }
  return {
    socket: s as unknown as Socket,
    handlers,
    emitted,
    fire(event: string, ...args: unknown[]) {
      for (const h of handlers.get(event) ?? []) h(...args)
    },
  }
}

describe('Net', () => {
  it('registers connect and disconnect handlers on connect()', () => {
    const f = fakeSocket()
    const net = new Net({ factory: () => f.socket })
    net.connect()
    expect(f.handlers.has('connect')).toBe(true)
    expect(f.handlers.has('disconnect')).toBe(true)
  })

  it('queues handlers registered before connecting and attaches them after', () => {
    const f = fakeSocket()
    const net = new Net({ factory: () => f.socket })
    const spy = vi.fn()

    net.on('welcome', spy)
    expect(f.handlers.has('welcome')).toBe(false)

    net.connect()
    expect(f.handlers.has('welcome')).toBe(true)

    f.fire('welcome', { player_id: 3 })
    expect(spy).toHaveBeenCalledWith({ player_id: 3 })
  })

  it('registers handlers directly once connected', () => {
    const f = fakeSocket()
    const net = new Net({ factory: () => f.socket })
    net.connect()
    const spy = vi.fn()
    net.on('snapshot', spy)
    f.fire('snapshot', 1)
    expect(spy).toHaveBeenCalledWith(1)
  })

  it('emit() before connection does not throw and drops the message', () => {
    const f = fakeSocket()
    const net = new Net({ factory: () => f.socket })
    expect(() => net.emit('input', { seq: 1 })).not.toThrow()
    expect(f.emitted).toHaveLength(0)

    net.connect()
    net.emit('input', { seq: 2 })
    expect(f.emitted).toEqual([['input', { seq: 2 }]])
  })

  it('emit() with no payload sends the bare event', () => {
    const f = fakeSocket()
    const net = new Net({ factory: () => f.socket })
    net.connect()
    net.emit('ready')
    expect(f.emitted).toEqual([['ready', undefined]])
  })

  it('tracks connection state and notifies subscribers', () => {
    const f = fakeSocket()
    const net = new Net({ factory: () => f.socket })
    const seen: string[] = []
    net.onState((s) => seen.push(s))

    expect(seen).toEqual(['disconnected'])
    net.connect()
    expect(net.connectionState).toBe('connecting')
    f.fire('connect')
    expect(net.connectionState).toBe('connected')
    f.fire('disconnect')
    expect(net.connectionState).toBe('disconnected')
    expect(seen).toEqual(['disconnected', 'connecting', 'connected', 'disconnected'])
  })

  it('connect() twice does not build a second socket', () => {
    const factory = vi.fn(() => fakeSocket().socket)
    const net = new Net({ factory })
    net.connect()
    net.connect()
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('exposes the transport name so a polling fallback is visible', () => {
    const f = fakeSocket()
    const net = new Net({ factory: () => f.socket })
    expect(net.transport).toBeUndefined()
    net.connect()
    expect(net.transport).toBe('websocket')
  })
})
