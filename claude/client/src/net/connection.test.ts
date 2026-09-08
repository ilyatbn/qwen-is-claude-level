import { describe, it, expect } from 'vitest'
import { Connection, type SocketLike } from './connection'

/**
 * A socket that records its listeners so a test can deliver an event, and that
 * answers `welcome` so `connect()` resolves.
 */
function fakeSocket() {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>()
  const sent: Array<{ event: string; args: unknown[] }> = []
  const socket: SocketLike = {
    on(event, cb) {
      const list = listeners.get(event) ?? []
      list.push(cb)
      listeners.set(event, list)
    },
    emit(event, ...args) {
      sent.push({ event, args })
    },
    close() {},
    connected: true,
  }
  const deliver = (event: string, payload: unknown) => {
    for (const cb of listeners.get(event) ?? []) cb(payload)
  }
  return { socket, deliver, sent, listeners }
}

async function connected() {
  const f = fakeSocket()
  const conn = new Connection({ factory: () => f.socket })
  const welcome = conn.connect(undefined, 'ana', { skinId: 0, hatId: 0, glassesId: 0 })
  f.deliver('connect', undefined)
  f.deliver('welcome', {
    player_id: 1,
    tick: 0,
    round_time: 0,
    phase: 'warmup',
    sim_hz: 60,
    snapshot_hz: 20,
    seed: '1',
    max_players: 8,
  })
  await welcome
  return { conn, ...f }
}

describe('Connection', () => {
  it('queues a handler registered before connect and attaches it after', async () => {
    const f = fakeSocket()
    const conn = new Connection({ factory: () => f.socket })
    const seen: unknown[] = []
    conn.on('score', (p) => seen.push(p))
    const welcome = conn.connect(undefined, 'ana', { skinId: 0, hatId: 0, glassesId: 0 })
    f.deliver('connect', undefined)
    f.deliver('welcome', {
      player_id: 1,
      tick: 0,
      round_time: 0,
      phase: 'warmup',
      sim_hz: 60,
      snapshot_hz: 20,
      seed: '1',
      max_players: 8,
    })
    await welcome
    f.deliver('score', { scores: [] })
    expect(seen).toHaveLength(1)
  })

  /**
   * T19.18. The server sends `inventory` once at match start, immediately after
   * `map_init` — and `map_init` is what moves the client from `MenuScene` to
   * `GameScene`, which registers the `inventory` handler a frame later. Every
   * client that reaches a match through the menu therefore subscribed **after**
   * its own inventory had already been delivered, and held an empty quick bar
   * for the rest of its first life.
   *
   * The control is the second half: an event that is *not* a current value must
   * not be replayed, or a late subscriber would be handed a stale change — so
   * this cannot pass for a `Connection` that replays everything.
   */
  it('replays a latched inventory to a handler registered after it arrived, and nothing else', async () => {
    const { conn, deliver } = await connected()

    // Arrives with nobody listening — the case the latch exists for.
    deliver('inventory', { slots: [{ item: 3, count: 4, key: 'bazooka' }], selected: 0 })
    deliver('score', { scores: [{ id: 1, score: 7 }] })

    const inv: unknown[] = []
    const scores: unknown[] = []
    conn.on('inventory', (p) => inv.push(p))
    conn.on('score', (p) => scores.push(p))

    // Not inline: the replay is a microtask, so a scene's `create()` finishes
    // before its own handler is re-entered.
    expect(inv).toHaveLength(0)
    await Promise.resolve()

    expect(inv).toHaveLength(1)
    expect((inv[0] as { selected: number }).selected).toBe(0)
    // `score` describes a change, so a late subscriber gets nothing.
    expect(scores).toHaveLength(0)
  })

  it('does not replay to a handler that was already listening', async () => {
    const { conn, deliver } = await connected()
    const inv: unknown[] = []
    conn.on('inventory', (p) => inv.push(p))
    deliver('inventory', { slots: [], selected: 0 })
    await Promise.resolve()
    // Once, not twice: the latch is for subscribers that missed it.
    expect(inv).toHaveLength(1)
  })

  it('replays the newest inventory, not the first', async () => {
    const { conn, deliver } = await connected()
    deliver('inventory', { slots: [], selected: 0 })
    deliver('inventory', { slots: [], selected: 5 })
    const inv: Array<{ selected: number }> = []
    conn.on('inventory', (p) => inv.push(p as { selected: number }))
    await Promise.resolve()
    expect(inv.map((i) => i.selected)).toEqual([5])
  })

  it('latches an emitLocal too, so injection and the wire deliver alike', async () => {
    const { conn } = await connected()
    conn.emitLocal('inventory', { slots: [], selected: 2 })
    const inv: Array<{ selected: number }> = []
    conn.on('inventory', (p) => inv.push(p as { selected: number }))
    await Promise.resolve()
    expect(inv.map((i) => i.selected)).toEqual([2])
  })
})
