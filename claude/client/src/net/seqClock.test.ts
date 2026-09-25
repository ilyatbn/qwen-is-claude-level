import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { C, Core } from '../core'
import { firstSeqAfter, roundClockOnSnapshot, seqAtTick, tickAtSeq } from './seqClock'

// T22.14D F5: the lead is the core's `MAX_FRAME_DT` (what `GameScene` passes), not a copy.
beforeAll(async () => {
  await Core.init(readFileSync(fileURLToPath(new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url))))
}, 60_000)

describe('the seq ↔ tick mapping (T22.14C LOW-5)', () => {
  // A snapshot on tick 500 acking seq 100: seq 100 + k runs on tick 500 + k (R89).
  const a = { ack: 100, tick: 500 }

  it('maps both ways, and each is the other’s inverse', () => {
    expect(seqAtTick(500, a)).toBe(100)
    expect(seqAtTick(503, a)).toBe(103)
    expect(seqAtTick(497, a)).toBe(97)
    expect(tickAtSeq(104, a)).toBe(504)
    for (const t of [490, 500, 517]) expect(tickAtSeq(seqAtTick(t, a), a)).toBe(t)
  })

  /**
   * The bell's own numbers from `black-hole` (ends_tick 4389, the first tick stepped
   * in `Ended` 4390): an event on a tick changes the steps from the next tick on.
   * `game-core`'s `the_bell_predicted_at_round_start_is_the_servers` checks the same
   * rule against the server for every round length.
   */
  it('an event on a tick first changes the seq stepped on the next tick', () => {
    expect(firstSeqAfter(503, a)).toBe(104)
    const bell = { ack: 4000, tick: 4380 }
    expect(tickAtSeq(firstSeqAfter(4389, bell), bell)).toBe(4390)
  })

  it('never names a seq below 0 (the core takes a u32)', () => {
    expect(firstSeqAfter(0, { ack: 3, tick: 900 })).toBe(0)
  })
})

describe('the round clock on a snapshot (T22.14C MED-3)', () => {
  // One frame's worth of lead is jitter: the frame ceiling `GameScene` passes.
  let lead = 0
  beforeAll(() => {
    lead = C().MAX_FRAME_DT
  })

  it('never steps back for a late snapshot', () => {
    // The frames ran the clock to 10.05; a snapshot of 10.0 arrives late.
    expect(roundClockOnSnapshot(10.05, 10.0, 9.95, lead)).toBe(10.05)
  })

  it('takes the server’s time when it is ahead', () => {
    expect(roundClockOnSnapshot(10.0, 10.1, 10.05, lead)).toBe(10.1)
  })

  it('adopts a restart whole, backwards included', () => {
    expect(roundClockOnSnapshot(300.2, 0.05, 300.1, lead)).toBe(0.05)
  })

  it('does not keep a clock that ran more than a frame fast', () => {
    expect(roundClockOnSnapshot(11.0, 10.0, 9.95, lead)).toBe(10.0)
  })
})
