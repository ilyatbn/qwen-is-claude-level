import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { C, Core, fogStrength } from '../core'
import { CloudRain, EmberField, FlareClock, FogClock, LavaClock, ServerClock, fogVeilAlpha, type RainCloud } from './weather-math'

beforeAll(async () => {
  const url = new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url)
  await Core.init(readFileSync(fileURLToPath(url)))
})

describe('EmberField', () => {
  it('spews upward from the vent', () => {
    const e = new EmberField(200, 500)
    e.emit(0.1, 100, 100, 0, 260)
    expect(e.embers.length).toBeGreaterThan(0)
    // Every ember leaves with an upward velocity: a "spew" that starts by falling
    // is a leak, not an eruption (§C6 asks for fire going *up*).
    for (const p of e.embers) expect(p.vy).toBeLessThan(0)
  })

  it('falls back under gravity, which is what makes it an arc', () => {
    const e = new EmberField(200, 500)
    e.emit(0.1, 100, 100, 0, 260)
    const first = e.embers[0]!
    const vy0 = first.vy
    for (let i = 0; i < 30; i++) e.update(0.016, 900)
    // Either it died, or it is now moving downward faster than it started.
    const alive = e.embers.find((p) => p === first)
    if (alive) expect(alive.vy).toBeGreaterThan(vy0)
  })

  it('never exceeds its cap, however long a vent jets', () => {
    const e = new EmberField(500, 40)
    for (let i = 0; i < 200; i++) {
      e.emit(0.05, 0, 0, 0, 200)
      e.update(0.0001, 0) // barely ages them, so the cap is what bounds it
    }
    expect(e.embers.length).toBeLessThanOrEqual(40)
  })

  it('expires them, so a finished jet leaves nothing behind', () => {
    const e = new EmberField(200, 500)
    e.emit(0.1, 0, 0, 0, 200)
    expect(e.embers.length).toBeGreaterThan(0)
    for (let i = 0; i < 200; i++) e.update(0.05, 900)
    expect(e.embers.length).toBe(0)
  })
})

describe('the heavy-fog veil (§F9)', () => {
  it('is FOG_SCREEN_ALPHA times the strength, across the whole ramp', () => {
    const c = C()
    // Sampled off `fog.rs`'s own ramp rather than off a list of made-up
    // strengths: this is the sequence the veil will actually be handed, ramp in
    // and ramp out included, and it is the same function `fov_multiplier` reads.
    let sawPartial = 0
    let sawFull = 0
    for (let t = 0; t <= c.FOG_DURATION; t += 0.1) {
      const s = fogStrength(t)
      expect(fogVeilAlpha(s, false)).toBeCloseTo(c.FOG_SCREEN_ALPHA * s, 6)
      if (s > 0.01 && s < 0.99) sawPartial++
      if (s >= 0.999) sawFull++
    }
    // The control the assertion above needs: if the ramp were a step, every
    // sample would be 0 or 1 and "alpha = ALPHA x strength" would be proved for
    // exactly two points. FOG_RAMP is 2 s at each end, so a 0.1 s walk must find
    // partial samples in between.
    expect(sawPartial).toBeGreaterThan(20)
    expect(sawFull).toBeGreaterThan(0)
  })

  it('is FOG_SCREEN_ALPHA at full strength and nothing at all outside the effect', () => {
    const c = C()
    expect(fogVeilAlpha(1, false)).toBeCloseTo(c.FOG_SCREEN_ALPHA, 6)
    // Before it starts and after it ends. Both come off the real ramp, so this
    // fails if `strength()` ever stops closing at its ends.
    expect(fogVeilAlpha(fogStrength(-1), false)).toBe(0)
    expect(fogVeilAlpha(fogStrength(0), false)).toBe(0)
    expect(fogVeilAlpha(fogStrength(c.FOG_DURATION), false)).toBe(0)
    expect(fogVeilAlpha(fogStrength(c.FOG_DURATION + 1), false)).toBe(0)
  })

  it('clamps, because a networked client walks the clock itself', () => {
    // `GameScene` computes `roundTime - fogStartedAt`, and a resync can hand it
    // a value outside the window. Phaser treats a negative alpha as opaque, so
    // an unclamped veil would black the screen out on a clock correction.
    expect(fogVeilAlpha(-0.5, false)).toBe(0)
    expect(fogVeilAlpha(2, false)).toBeCloseTo(C().FOG_SCREEN_ALPHA, 6)
  })
})

describe('FogClock — the networked client\'s half of §F9', () => {
  it('is clear until a HeavyFog starts, and then follows fog.rs\'s ramp', () => {
    const c = C()
    const f = new FogClock()
    // A control that matters: nothing is foggy before anything happens, so the
    // assertions below are about the fog rather than about a default.
    expect(f.running).toBe(false)
    expect(f.strength(0)).toBe(0)
    expect(f.strength(1000)).toBe(0)

    f.start(7, 'HeavyFog', 100)
    expect(f.running).toBe(true)
    // Round time, not elapsed time: the whole job of the class is to hold the
    // origin so the caller can hand it the clock it already has.
    expect(f.strength(100)).toBe(0)
    expect(f.strength(100 + c.FOG_RAMP / 2)).toBeCloseTo(fogStrength(c.FOG_RAMP / 2), 6)
    expect(f.strength(100 + c.FOG_DURATION / 2)).toBeCloseTo(1, 6)
    expect(f.strength(100 + c.FOG_DURATION)).toBe(0)
  })

  it('ignores every effect that is not heavy fog', () => {
    const f = new FogClock()
    f.start(1, 'ToxicRain', 0)
    f.start(2, 'MeteorShower', 0)
    f.start(3, 'LavaBurst', 0)
    expect(f.running).toBe(false)
    expect(f.strength(C().FOG_DURATION / 2)).toBe(0)
  })

  it('is not switched off by another effect ending inside it', () => {
    // The branch this class exists for. Weather overlaps: a toxic rain can start
    // *and finish* during a 15 s fog, and its `effect_end` carries a different
    // id. Dropping the id check here would clear the veil mid-fog while the
    // server still says it is foggy — invisible to every test that asserts on
    // simulation state, which is the failure §F9 is a fix for.
    const c = C()
    const f = new FogClock()
    f.start(7, 'HeavyFog', 0)
    const mid = c.FOG_DURATION / 2
    const during = f.strength(mid)
    expect(during).toBeCloseTo(1, 6)

    f.end(8) // somebody else's effect
    expect(f.strength(mid)).toBe(during)
    expect(f.running).toBe(true)

    f.end(7) // and now its own
    expect(f.strength(mid)).toBe(0)
    expect(f.running).toBe(false)
  })

  it('clear() forgets a running fog that end() would refuse (T20.13)', () => {
    // A round ends with the fog still up. The scene has no `effect_end` and no id
    // to quote, and `end()` is deliberately id-checked — so without `clear()` the
    // veil rode into the next match, on a `GameScene` Phaser reuses.
    const c = C()
    const f = new FogClock()
    f.start(7, 'HeavyFog', 0)
    const mid = c.FOG_DURATION / 2
    expect(f.strength(mid)).toBeCloseTo(1, 6)
    // The control: this is exactly the call the scene cannot make, and it is
    // refused. Without it, `clear()` would look like a synonym for `end`.
    f.end(-1)
    expect(f.running).toBe(true)

    f.clear()
    expect(f.running).toBe(false)
    expect(f.strength(mid)).toBe(0)
    // And it does not wedge the class: the next round's fog still starts.
    f.start(9, 'HeavyFog', 1000)
    expect(f.strength(1000 + c.FOG_DURATION / 2)).toBeCloseTo(1, 6)
  })

  it('a second fog re-bases the clock rather than stacking', () => {
    const c = C()
    const f = new FogClock()
    f.start(1, 'HeavyFog', 0)
    f.start(2, 'HeavyFog', 500)
    expect(f.strength(500 + c.FOG_DURATION / 2)).toBeCloseTo(1, 6)
    // And the first one's end no longer owns it, or the round's second fog would
    // be cancelled by the first one's cleanup event.
    f.end(1)
    expect(f.running).toBe(true)
  })
})

describe("LavaClock — the networked client's half of §A3's ground fire (T19.24)", () => {
  // 0x1_0000_0003 — deliberately past 32 bits, because the whole reason this
  // class splits the seed is that a `u64` survives neither JSON nor
  // `wasm_bindgen`. A seed that fitted in 32 bits would pass with the high half
  // wired to zero.
  const SEED = '4294967299'

  it('is idle until a LavaBurst starts, and then reports the seed split and the clock', () => {
    const l = new LavaClock()
    // The control: nothing is running before anything happens, so what follows
    // is about the burst and not about a default.
    expect(l.running).toBe(false)
    expect(l.query(0)).toBeNull()
    expect(l.query(1000)).toBeNull()

    l.start(7, 'LavaBurst', SEED)
    // **Still nothing.** `effect_start` is the telegraph; `lava.rs` opens no
    // vent until it goes active and re-bases their timers to that instant.
    expect(l.running).toBe(false)
    expect(l.telegraphing).toBe(true)
    expect(l.query(100)).toBeNull()

    l.activate(7, 'active', 100)
    expect(l.running).toBe(true)
    // Round time in, elapsed out: holding the origin is the job.
    expect(l.query(100)).toEqual({ lo: 3, hi: 1, elapsed: 0 })
    expect(l.query(104.5)?.elapsed).toBeCloseTo(4.5, 6)
  })

  it('ignores every effect that is not a lava burst', () => {
    const l = new LavaClock()
    l.start(1, 'ToxicRain', SEED)
    l.start(2, 'MeteorShower', SEED)
    l.start(3, 'HeavyFog', SEED)
    l.activate(1, 'active', 0)
    l.activate(2, 'active', 0)
    l.activate(3, 'active', 0)
    expect(l.running).toBe(false)
    expect(l.telegraphing).toBe(false)
    expect(l.query(5)).toBeNull()
  })

  it('is not switched off by another effect ending inside it', () => {
    // `FogClock`'s branch, and lava needs it for a sharper reason: the veil just
    // stops looking foggy, but vents that stop being reported stop being *drawn*
    // and stop lighting the ground — in the phase that is damaging you.
    const l = new LavaClock()
    l.start(7, 'LavaBurst', SEED)
    l.activate(7, 'active', 0)
    l.end(8) // somebody else's effect
    expect(l.running).toBe(true)
    expect(l.query(2)).toEqual({ lo: 3, hi: 1, elapsed: 2 })

    l.end(7)
    expect(l.running).toBe(false)
    expect(l.query(2)).toBeNull()
  })

  it('survives a malformed seed instead of taking the scene down', () => {
    // This runs inside a socket event handler; a throw here kills the round, and
    // a server that changed the wire format is a bug to see, not to crash on.
    const l = new LavaClock()
    expect(() => l.start(7, 'LavaBurst', 'not-a-number')).not.toThrow()
    expect(l.running).toBe(false)
    expect(l.telegraphing).toBe(false)
  })

  it('clear() discards the round whatever is running', () => {
    // `resetForNewRound`'s caller. A burst left running would open vents in the
    // *next* match that the server never announced.
    const l = new LavaClock()
    l.start(7, 'LavaBurst', SEED)
    l.activate(7, 'active', 0)
    l.clear()
    expect(l.running).toBe(false)
    expect(l.query(1)).toBeNull()
  })
})

describe("FlareClock — the networked client's half of a solar flare (T22.08B)", () => {
  // Past 32 bits for `LavaClock`'s reason: a high half wired to zero must fail.
  const SEED = '4294967299'

  it('starts its clock at effect_start — the telegraph — with the seed split', () => {
    const f = new FlareClock()
    // The control: idle before anything starts.
    expect(f.query(0)).toBeNull()
    f.start(4, 'SolarFlare', SEED, 100)
    // **Running at once**, unlike lava: the server's ribbon is measured from the
    // install tick, which is the `effect_start` tick.
    expect(f.query(100)).toEqual({ lo: 3, hi: 1, elapsed: 0 })
    expect(f.query(103.25)?.elapsed).toBeCloseTo(3.25, 6)
  })

  it('ignores every effect that is not a solar flare', () => {
    const f = new FlareClock()
    for (const kind of ['ToxicRain', 'MeteorShower', 'LavaBurst', 'HeavyFog']) f.start(1, kind, SEED, 0)
    expect(f.query(5)).toBeNull()
  })

  it('is not switched off by another effect ending inside it, and is by its own', () => {
    const f = new FlareClock()
    f.start(4, 'SolarFlare', SEED, 0)
    f.end(5)
    expect(f.query(2)).toEqual({ lo: 3, hi: 1, elapsed: 2 })
    f.end(4)
    expect(f.query(2)).toBeNull()
  })

  it('survives a malformed seed, and clear() discards the round', () => {
    const f = new FlareClock()
    expect(() => f.start(4, 'SolarFlare', 'not-a-number', 0)).not.toThrow()
    expect(f.query(1)).toBeNull()
    f.start(4, 'SolarFlare', SEED, 0)
    f.clear()
    expect(f.query(1)).toBeNull()
  })
})

describe('CloudRain — rain falls from clouds and stops at the ground (T21.31)', () => {
  // Fixture geometry, not tunables: one cloud over flat ground, and a rock shelf.
  const cloud = { left: 400, top: 100, w: 120, h: 50 }
  const groundY = 600
  const shelf = { x0: 440, x1: 480, y: 320 }
  const solid = (x: number, y: number) => y >= groundY || (x >= shelf.x0 && x < shelf.x1 && y >= shelf.y && y < shelf.y + 20)
  const DT = 1 / 60

  const run = (rain: CloudRain, seconds: number, clouds: RainCloud[], target = 1, onStep?: () => void) => {
    for (let t = 0; t < seconds; t += DT) {
      rain.update(DT, target, clouds, solid, groundY + 100)
      onStep?.()
    }
  }

  it('draws nothing without a cloud, however hard the schedule says it is raining', () => {
    const rain = new CloudRain(C().AMBIENT_RAIN_DROPS, 1, C())
    run(rain, 5, [])
    expect(rain.alive).toBe(0)
    // The control: the same pool under a cloud does rain.
    run(rain, 5, [cloud])
    expect(rain.alive).toBeGreaterThan(0)
  })

  it('draws nothing when the schedule is dry, even under a cloud', () => {
    const rain = new CloudRain(C().AMBIENT_RAIN_DROPS, 1, C())
    run(rain, 5, [cloud], 0)
    expect(rain.alive).toBe(0)
  })

  it('every live drop is under its cloud, below the cloud\'s lower part, and never in rock', () => {
    const k = C()
    const rain = new CloudRain(k.AMBIENT_RAIN_DROPS, 7, k)
    let seen = 0
    let underShelf = 0
    run(rain, 20, [cloud], 1, () => {
      for (const d of rain.drops) {
        if (!d.alive) continue
        seen++
        expect(d.x).toBeGreaterThanOrEqual(cloud.left)
        expect(d.x).toBeLessThanOrEqual(cloud.left + cloud.w)
        expect(d.y0).toBeCloseTo(cloud.top + cloud.h * k.AMBIENT_RAIN_SPAWN_DEPTH, 6)
        expect(d.y).toBeGreaterThanOrEqual(d.y0)
        expect(solid(Math.round(d.x), Math.round(d.y))).toBe(false)
        // The column the rock test asks about is the rounded one, so count that column.
        const rx = Math.round(d.x)
        if (rx >= shelf.x0 && rx < shelf.x1 && d.y > shelf.y) underShelf++
      }
    })
    // Presence, and the shelf really was in the rain's way: without the rock test the
    // column under it fills with drops.
    expect(seen).toBeGreaterThan(1000)
    expect(underShelf).toBe(0)
  })

  it('never steps over thin rock, however long the frame', () => {
    const k = C()
    // A ledge 2 px thick under the whole cloud, and a frame far longer than 60 fps: the
    // drop moves tens of px a step, so a test only at the landing row skips the ledge.
    const ledgeY = 300
    const thin = (_x: number, y: number) => y >= groundY || y === ledgeY || y === ledgeY + 1
    const rain = new CloudRain(k.AMBIENT_RAIN_DROPS, 5, k)
    const bigStep = 0.1
    let seen = 0
    for (let t = 0; t < 20; t += bigStep) {
      rain.update(bigStep, 1, [cloud], thin, groundY + 100)
      for (const d of rain.drops) {
        if (!d.alive) continue
        seen++
        expect(d.y).toBeLessThan(ledgeY)
      }
    }
    // Presence: drops were falling, or "none below the ledge" is a dry sky.
    expect(seen).toBeGreaterThan(100)
  })

  it('falls at the constant speeds and thins with the schedule', () => {
    const k = C()
    const rain = new CloudRain(k.AMBIENT_RAIN_DROPS, 3, k)
    run(rain, 10, [cloud], 1)
    const full = rain.alive
    for (const d of rain.drops.filter((x) => x.alive)) {
      expect(d.vy).toBeGreaterThanOrEqual(k.AMBIENT_RAIN_FALL_MIN)
      expect(d.vy).toBeLessThanOrEqual(k.AMBIENT_RAIN_FALL_MAX)
    }
    run(rain, 10, [cloud], 0.25)
    expect(rain.alive).toBeLessThanOrEqual(Math.round(0.25 * k.AMBIENT_RAIN_DROPS))
    expect(rain.alive).toBeLessThan(full)
  })

  it('is the same rain from the same seed', () => {
    const a = new CloudRain(40, 99, C())
    const b = new CloudRain(40, 99, C())
    run(a, 3, [cloud])
    run(b, 3, [cloud])
    expect(a.drops).toEqual(b.drops)
  })
})

describe('ServerClock — the flare clock is monotonic off jittered snapshots (T22.08D F2)', () => {
  /** 20 Hz snapshots arriving up to 30 ms late at random; frames at 60 Hz; returns elapsed per frame. */
  function run(truncated: boolean): number[] {
    const k = C()
    const clock = new ServerClock()
    let seed = 7
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
    const ticksPerSnap = k.SIM_HZ / k.SNAPSHOT_HZ
    const out: number[] = []
    let snapT = 0
    let pending: { server: number; arrive: number }[] = []
    for (let f = 0; f < 600; f++) {
      const local = f / 60
      while (snapT / k.SIM_HZ <= local) {
        const server = (snapT * k.SIM_DT)
        // The shape F2 replaced: the codec's 0.1 s round time.
        pending.push({ server: truncated ? Math.floor(server * 10) / 10 : server, arrive: snapT / k.SIM_HZ + rand() * 0.03 })
        snapT += ticksPerSnap
      }
      for (const p of pending.filter((p) => p.arrive <= local)) clock.sample(p.server, 0, p.arrive)
      pending = pending.filter((p) => p.arrive > local)
      const now = clock.now(local)
      if (now !== null) out.push(now)
    }
    return out
  }
  const decreases = (xs: number[]) => xs.slice(1).filter((x, i) => x < xs[i]!).length

  it('never runs backwards on tick samples', () => {
    const xs = run(false)
    expect(xs.length).toBeGreaterThan(500)
    expect(decreases(xs)).toBe(0)
    // And it tracks the truth: within one snapshot interval of the frame's tick-time.
    expect(Math.abs(xs[xs.length - 1]! - 599 / 60)).toBeLessThan(1 / C().SNAPSHOT_HZ)
  })

  it('the control: the instrument sees a step back when the clock really does go back', () => {
    // T22.08E: the 0.1 s-truncated round time used to be this control, and it no longer
    // distinguishes — truncation only ever makes a sample *low*, which is what a late
    // sample is, so the least-delayed-sample estimate recovers it (to under a tick). The
    // control that still means something is the one the stall tests lean on: a real
    // backwards clock (a restart) is seen by the same `decreases` count.
    const xs = run(true)
    expect(Math.abs(xs[xs.length - 1]! - 599 / 60)).toBeLessThan(C().SIM_DT)
    const c = new ServerClock()
    const seen: number[] = []
    for (let i = 0; i < 40; i++) {
      c.sample(i < 20 ? 100 + i * 0.05 : (i - 20) * 0.05, 0, i * 0.05)
      seen.push(c.now(i * 0.05)!)
    }
    expect(decreases(seen)).toBe(1)
  })

  /**
   * T22.08E F1: **a stall burst** — TCP holds every snapshot sent during `stall` and
   * delivers them together, each one `stall` late or less. The review measured the
   * T22.08D clock stepping back 22 ms after a 200 ms stall and 213 ms (~19 px of
   * ribbon) after 300 ms: a late sample read as the server's clock going backwards.
   */
  function stalled(stall: number): { xs: number[]; truth: number[] } {
    const k = C()
    const clock = new ServerClock()
    let seed = 11
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
    const ticksPerSnap = k.SIM_HZ / k.SNAPSHOT_HZ
    const stallAt = 4
    const xs: number[] = []
    const truth: number[] = []
    let snapT = 0
    let pending: { server: number; arrive: number }[] = []
    for (let f = 0; f < 600; f++) {
      const local = f / 60
      while (snapT / k.SIM_HZ <= local) {
        const sent = snapT / k.SIM_HZ
        let arrive = sent + rand() * 0.01
        if (sent >= stallAt && sent < stallAt + stall) arrive = Math.max(arrive, stallAt + stall)
        pending.push({ server: snapT * k.SIM_DT, arrive })
        snapT += ticksPerSnap
      }
      for (const p of pending.filter((p) => p.arrive <= local)) clock.sample(p.server, 0, p.arrive)
      pending = pending.filter((p) => p.arrive > local)
      const now = clock.now(local)
      if (now !== null) {
        xs.push(now)
        truth.push(local)
      }
    }
    return { xs, truth }
  }
  const worstStepBack = (xs: number[]) => xs.slice(1).reduce((m, x, i) => Math.max(m, xs[i]! - x), 0)

  for (const stall of [0.2, 0.3, 0.5]) {
    it(`never steps backwards after a ${stall * 1000} ms stall burst, and still tracks the server`, () => {
      const { xs, truth } = stalled(stall)
      expect(xs.length).toBeGreaterThan(500)
      expect(worstStepBack(xs)).toBe(0)
      // Through the stall and after it: never further behind than one snapshot interval.
      const lag = xs.reduce((m, x, i) => Math.max(m, truth[i]! - x), 0)
      expect(lag).toBeLessThan(1 / C().SNAPSHOT_HZ)
      expect(Math.abs(xs[xs.length - 1]! - truth[truth.length - 1]!)).toBeLessThan(0.01)
    })
  }

  it('leans on the least-delayed samples — delay only ever makes a sample late', () => {
    // 0–30 ms of arrival jitter: an average of the samples sits ~15 ms behind the
    // server; the least-delayed sample in a window is within a few ms of it.
    const xs = run(false)
    expect(Math.abs(xs[xs.length - 1]! - 599 / 60)).toBeLessThan(0.008)
  })

  it('an inflated round trip does not run it ahead — the trip is least-delayed on its own', () => {
    // A 20 ms route, every snapshot 10 ms in transit; one pong in four measured through a
    // busy main thread at 120 ms. Folded into the sample as `rtt/2`, the largest-offset rule
    // picked those and ran the clock 50 ms ahead.
    const k = C()
    const clock = new ServerClock()
    const out: number[] = []
    const snap = 1 / k.SNAPSHOT_HZ
    for (let i = 0; i < 100; i++) {
      const sent = i * snap
      clock.sample(sent, i % 4 === 0 ? 0.12 : 0.02, sent + 0.01)
      out.push(clock.now(sent + 0.01)! - (sent + 0.01))
    }
    expect(Math.abs(out[out.length - 1]!)).toBeLessThan(0.002)
  })

  it('adopts a new clock whole — a restart resets the tick', () => {
    const c = new ServerClock()
    c.sample(100, 0, 10)
    c.sample(0, 0, 10.05)
    expect(c.now(10.05)).toBeCloseTo(0, 6)
  })
})
