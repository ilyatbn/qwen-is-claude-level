import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { C, Core, MapScale, type PlayerState } from '../core'
import type { InputFrame } from './codec'
import { Predictor } from './prediction'

/**
 * Against the real wasm core. A fake `applyInput` would make the reconciliation
 * identity below trivially true, and that identity is the entire reason the
 * netcode is allowed to be this simple.
 */
let core: Core
let mirror: Core

beforeAll(async () => {
  const bytes = readFileSync(
    fileURLToPath(new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url)),
  )
  core = await Core.init(bytes)
  mirror = await Core.init(bytes)
}, 60_000)

const BTN = { LEFT: 1, RIGHT: 2, UP: 4, DOWN: 8, JUMP: 16 }
const DT = 1 / 60

function inp(seq: number, buttons: number, aim = 0): InputFrame {
  return { seq, buttons, aim }
}

/** Both cores generate the same map and seat the same player on the ground. */
function reset(): { spawnX: number; spawnY: number } {
  core.generate(4242n, MapScale.Small)
  mirror.generate(4242n, MapScale.Small)
  // T22.10E: the phase is the core's, and a test that rings the bell must not
  // leave the next one on a results screen.
  core.setPhase('playing')
  mirror.setPhase('playing')
  const sp = core.meta.spawn_points[0]!
  core.removePlayer(0)
  mirror.removePlayer(0)
  core.addPlayer(0, sp.x, sp.y - C().PLAYER_H / 2)
  mirror.addPlayer(0, sp.x, sp.y - C().PLAYER_H / 2)
  return { spawnX: sp.x, spawnY: sp.y }
}

beforeEach(() => {
  reset()
})

describe('the pending buffer', () => {
  it('drops exactly the acknowledged prefix', () => {
    const p = new Predictor(core, 0)
    for (let i = 1; i <= 5; i++) p.pushInput(inp(i, BTN.RIGHT), DT)
    expect(p.stats.pending).toBe(5)

    const s = core.playerState(0)!
    p.reconcile({ tick: 0, lastInputSeq: 3, state: s })
    expect(p.pendingInputs.map((q) => q.input.seq)).toEqual([4, 5])
  })

  it('an acknowledgement for everything empties the buffer', () => {
    const p = new Predictor(core, 0)
    for (let i = 1; i <= 5; i++) p.pushInput(inp(i, BTN.RIGHT), DT)
    p.reconcile({ tick: 0, lastInputSeq: 99, state: core.playerState(0)! })
    expect(p.stats.pending).toBe(0)
  })
})

describe('the reconciliation identity', () => {
  /**
   * `docs/42` §9: replaying n pending inputs from a corrected state must match
   * simulating those n inputs from the original state. If this fails, nothing
   * else in the netcode is trustworthy.
   */
  it('replaying pending inputs from a correction lands where the server will', () => {
    const p = new Predictor(core, 0)

    // The server is 8 inputs behind. It has processed 1..4; 5..12 are pending.
    const all: InputFrame[] = []
    for (let i = 1; i <= 12; i++) all.push(inp(i, i % 3 === 0 ? BTN.JUMP : BTN.RIGHT))

    // Mirror plays the server: it applies 1..4, and that is its snapshot state.
    for (const f of all.slice(0, 4)) {
      mirror.applyInput(0, f.seq, f.buttons, f.aim, DT)
    }
    const serverState = mirror.playerState(0)!

    // Force a correction: the client starts 40 px off, so its prediction *at the
    // ack* is wrong (T22.10D F8 gates on that one, not on the current state).
    core.setPlayerState(0, { ...core.playerState(0)!, x: core.playerState(0)!.x + 40 })
    // Client predicts all 12.
    for (const f of all) p.pushInput(f, DT)
    p.reconcile({ tick: 0, lastInputSeq: 4, state: serverState })
    expect(p.stats.corrections).toBe(1)

    // The server then processes 5..12 itself.
    for (const f of all.slice(4)) {
      mirror.applyInput(0, f.seq, f.buttons, f.aim, DT)
    }

    const a = core.playerState(0)!
    const b = mirror.playerState(0)!
    expect(a.x).toBeCloseTo(b.x, 4)
    expect(a.y).toBeCloseTo(b.y, 4)
    expect(a.vx).toBeCloseTo(b.vx, 4)
    expect(a.vy).toBeCloseTo(b.vy, 4)
  })

  it('is falsifiable: replaying the wrong inputs does not land there', () => {
    const p = new Predictor(core, 0)
    const all: InputFrame[] = []
    for (let i = 1; i <= 12; i++) all.push(inp(i, BTN.RIGHT))
    for (const f of all.slice(0, 4)) mirror.applyInput(0, f.seq, f.buttons, f.aim, DT)
    const serverState = mirror.playerState(0)!
    core.setPlayerState(0, { ...core.playerState(0)!, x: core.playerState(0)!.x + 40 })
    for (const f of all) p.pushInput(f, DT)

    // Acknowledge *everything*, so nothing is replayed — the client should then
    // sit at the server state rather than 8 inputs ahead of it.
    p.reconcile({ tick: 0, lastInputSeq: 12, state: serverState })
    for (const f of all.slice(4)) mirror.applyInput(0, f.seq, f.buttons, f.aim, DT)

    expect(Math.abs(core.playerState(0)!.x - mirror.playerState(0)!.x)).toBeGreaterThan(1)
  })
})

/**
 * T22.14C HIGH-1: a correction installs the server's state **at the ack**, so the
 * replay must start from the movement state the mirror had there — previous input,
 * jump buffer, jetpack, airborne ticks — not from the newest applied one. The
 * `i % 3` identity above cannot see it: its first pending input is RIGHT, whose edge
 * reads the same against either previous input.
 */
describe('a correction replays from the acked seq’s movement state (T22.14C HIGH-1)', () => {
  it('a jump pressed inside the pending window keeps its edge on the replay', () => {
    const p = new Predictor(core, 0)
    const all: InputFrame[] = []
    for (let i = 1; i <= 12; i++) all.push(inp(i, i <= 4 ? 0 : BTN.JUMP))
    // The premise: the first pending input and the last pushed one both hold JUMP.
    expect(all[4]!.buttons & BTN.JUMP).toBeTruthy()
    expect(all[11]!.buttons & BTN.JUMP).toBeTruthy()
    for (const f of all.slice(0, 4)) mirror.applyInput(0, f.seq, f.buttons, f.aim, DT)
    // The server's body at the ack, a few px off the prediction so the gate corrects —
    // the server continues from exactly what it sends.
    const truth = { ...mirror.playerState(0)!, x: mirror.playerState(0)!.x + C().RECONCILE_EPSILON_PX * 2 }
    mirror.setPlayerState(0, truth)
    expect(truth.grounded).toBe(true)
    for (const f of all) p.pushInput(f, DT)
    p.reconcile({ tick: 0, lastInputSeq: 4, state: truth })
    expect(p.stats.corrections).toBe(1)
    for (const f of all.slice(4)) mirror.applyInput(0, f.seq, f.buttons, f.aim, DT)
    const a = core.playerState(0)!
    const b = mirror.playerState(0)!
    // Control: the server did jump on seq 5.
    expect(b.y).toBeLessThan(truth.y - C().PLAYER_H / 2)
    expect(a.x).toBeCloseTo(b.x, 4)
    expect(a.y).toBeCloseTo(b.y, 4)
    expect(a.vx).toBeCloseTo(b.vx, 4)
    expect(a.vy).toBeCloseTo(b.vy, 4)
  })

  /**
   * The server steps a dead player's input stream (`World::apply_inputs`: the seq and
   * `prev_input` advance, the body does not move) and `PlayerState::respawn` resets the
   * jump and the jetpack. So JUMP held from death through the respawn is *held*, not
   * pressed: no jump. The control is a fresh press after it, which jumps.
   */
  it('a respawn while holding JUMP does not jump, and a fresh press does', () => {
    const p = new Predictor(core, 0)
    for (let i = 1; i <= 3; i++) p.pushInput(inp(i, 0), DT)
    const spawn = core.playerState(0)!
    expect(spawn.grounded).toBe(true)
    p.reconcile({ tick: 3, lastInputSeq: 3, state: spawn })
    // Dies by seq 6, pressing nothing; presses JUMP while dead and holds it.
    for (let i = 4; i <= 6; i++) p.pushInput(inp(i, 0), DT)
    p.reconcile({ tick: 6, lastInputSeq: 6, state: { ...core.playerState(0)!, alive: false } })
    for (let i = 7; i <= 14; i++) p.pushInput(inp(i, BTN.JUMP), DT)
    // Respawned by seq 10, at rest on the ground; 11..14 pending, JUMP still held.
    p.reconcile({ tick: 10, lastInputSeq: 10, state: { ...spawn, alive: true } })
    const held = core.playerState(0)!
    expect(held.alive).toBe(true)
    // A jump launches at −`JUMP_VELOCITY`; settling on the ground moves a fraction of a px.
    expect(held.vy).toBeGreaterThanOrEqual(0)
    expect(Math.abs(held.y - spawn.y)).toBeLessThan(1)
    // Control: release and press again — that is an edge, and it jumps.
    p.pushInput(inp(15, 0), DT)
    p.pushInput(inp(16, BTN.JUMP), DT)
    expect(core.playerState(0)!.vy).toBeLessThan(0)
  })
})

describe('corrections', () => {
  it('ignores error below the epsilon', () => {
    const p = new Predictor(core, 0)
    p.pushInput(inp(1, 0), DT)
    const s = core.playerState(0)!
    const nudged: PlayerState = { ...s, x: s.x + C().RECONCILE_EPSILON_PX * 0.5 }
    p.reconcile({ tick: 0, lastInputSeq: 1, state: nudged })
    expect(p.stats.corrections).toBe(0)
    // and it did not move us
    expect(core.playerState(0)!.x).toBeCloseTo(s.x, 5)
  })

  it('corrects above the epsilon and records the distance', () => {
    const p = new Predictor(core, 0)
    p.pushInput(inp(1, 0), DT)
    const s = core.playerState(0)!
    const nudged: PlayerState = { ...s, x: s.x + 10 }
    p.reconcile({ tick: 0, lastInputSeq: 1, state: nudged })
    expect(p.stats.corrections).toBe(1)
    expect(p.stats.lastCorrectionPx).toBeCloseTo(10, 3)
    expect(core.playerState(0)!.x).toBeCloseTo(nudged.x, 3)
  })

  it('tracks the maximum correction across several', () => {
    const p = new Predictor(core, 0)
    for (const dx of [10, 40, 25]) {
      p.pushInput(inp(1, 0), DT)
      const s = core.playerState(0)!
      p.reconcile({ tick: 0, lastInputSeq: 1, state: { ...s, x: s.x + dx } })
    }
    expect(p.stats.maxCorrectionPx).toBeGreaterThanOrEqual(39)
  })
})

describe('render smoothing', () => {
  it('eases toward the simulation rather than jumping', () => {
    const p = new Predictor(core, 0)
    p.pushInput(inp(1, 0), DT)
    const s = core.playerState(0)!
    p.reconcile({ tick: 0, lastInputSeq: 1, state: { ...s, x: s.x + 20 } })

    const before = p.renderPos.x
    p.updateRender(DT)
    const after = p.renderPos.x
    const target = core.playerState(0)!.x
    // It moved toward the target, but did not arrive in one frame.
    expect(Math.abs(after - target)).toBeLessThan(Math.abs(before - target))
    expect(after).not.toBeCloseTo(target, 3)
  })

  it('snaps the render too when the correction is a teleport', () => {
    const p = new Predictor(core, 0)
    p.pushInput(inp(1, 0), DT)
    const s = core.playerState(0)!
    p.reconcile({ tick: 0, lastInputSeq: 1, state: { ...s, x: s.x + 400 } })
    expect(p.stats.snaps).toBe(1)
    expect(p.renderPos.x).toBeCloseTo(core.playerState(0)!.x, 3)
  })

  it('smoothing is frame-rate independent', () => {
    // Two predictors, same correction, same elapsed time, different step counts.
    const a = new Predictor(core, 0)
    a.pushInput(inp(1, 0), DT)
    const s = core.playerState(0)!
    a.reconcile({ tick: 0, lastInputSeq: 1, state: { ...s, x: s.x + 20 } })
    for (let i = 0; i < 6; i++) a.updateRender(1 / 60)
    const after60 = a.renderPos.x
    const target = core.playerState(0)!.x

    reset()
    const b = new Predictor(core, 0)
    b.pushInput(inp(1, 0), DT)
    const s2 = core.playerState(0)!
    b.reconcile({ tick: 0, lastInputSeq: 1, state: { ...s2, x: s2.x + 20 } })
    for (let i = 0; i < 3; i++) b.updateRender(1 / 30)
    const after30 = b.renderPos.x
    const target2 = core.playerState(0)!.x

    // Same fraction of the way there, within a percent.
    const f60 = (after60 - (target - 20)) / 20
    const f30 = (after30 - (target2 - 20)) / 20
    expect(Math.abs(f60 - f30)).toBeLessThan(0.02)
  })
})

/**
 * T20.19 — a hurt player rubber-bands, permanently.
 *
 * `apply_input` scales the walk target by `PlayerState::speed_multiplier()`,
 * which is a function of health. The server passed it; the wasm mirror passed a
 * literal `1.0`, and `set_player_state` never carried health at all, so a
 * damaged player was predicted up to 25 % fast **and could not self-correct** —
 * the correction itself did not tell the mirror what its health was.
 *
 * Both cores here are the same compiled wasm, so a one-sided bug cannot be
 * staged by making one of them wrong. The lever that works is the **snapshot**:
 * `snapshotHealth` is what the wire claims, and withholding it is exactly the
 * state the client was permanently in before this task. The Rust half of this
 * pair — `game-wasm`'s `the_client_predicts_a_hurt_player_where_the_server_puts_them`
 * — runs the real `game_core::world::World` against the mirror and checks the
 * multipliers themselves agree.
 */
describe('a hurt player is predicted at the hurt speed (T20.19)', () => {
  const FRAMES = 40

  /**
   * Walk for `FRAMES` frames on the client and on the mirror-as-server,
   * reconciling every frame.
   *
   * The three healths are separate on purpose. `server` is the truth; `client`
   * is what the mirror starts believing; `snapshot` is what the wire says.
   * Before T20.19 the client's was **permanently** `BASE_HEALTH` and the
   * snapshot carried nothing, which is `{ server: hurt, client: full,
   * snapshot: full }` — the only way to stage a one-sided bug when both cores
   * are the same compiled wasm.
   *
   * `lastInputSeq` acknowledges everything, so nothing is replayed and the
   * correction distance is purely the two simulations disagreeing.
   */
  function walkReconciling(h: {
    server: number
    client: number
    snapshot: number
    button: number
  }) {
    reset()
    const body = core.playerState(0)!
    core.setPlayerState(0, { ...body, health: h.client })
    mirror.setPlayerState(0, { ...body, health: h.server })

    const p = new Predictor(core, 0)
    let correctionsAtHalf = 0
    for (let seq = 1; seq <= FRAMES; seq++) {
      p.pushInput(inp(seq, h.button), DT)
      mirror.applyInput(0, seq, h.button, 0, DT)
      const s = mirror.playerState(0)!
      p.reconcile({ tick: 0, lastInputSeq: seq, state: { ...s, health: h.snapshot } })
      if (seq === FRAMES / 2) correctionsAtHalf = p.stats.corrections
    }
    return {
      stats: p.stats,
      correctionsAtHalf,
      server: mirror.playerState(0)!,
      startX: body.x,
    }
  }

  function even(health: number, button: number) {
    return walkReconciling({ server: health, client: health, snapshot: health, button })
  }

  /**
   * The direction this spawn can actually be walked in, memoised.
   *
   * **`roomFor(dir)`, in the language this fixture is written in.** Holding
   * RIGHT from `spawn_points[0]` on seed 4242 travels 41 px and stops dead
   * against a wall — `vx` exactly 0 — so every "no corrections" assertion below
   * would have been satisfied by two bodies standing still together. That is
   * `checks/audio.mjs`'s lesson and T20.20's defect, and it caught this fixture
   * on its first run. LEFT is clear.
   */
  let roomDir = 0
  function directionWithRoom(): number {
    if (roomDir !== 0) return roomDir
    for (const b of [BTN.RIGHT, BTN.LEFT]) {
      const probe = even(C().BASE_HEALTH, b)
      if (Math.abs(probe.server.vx) >= C().WALK_SPEED - 1e-3) {
        roomDir = b
        return b
      }
    }
    throw new Error('neither direction has room at this spawn; the fixture is measuring a wall')
  }

  it('the fixture has room to walk', () => {
    // The control every assertion below rests on: a full-health run ends at
    // exactly WALK_SPEED, which a body against a wall cannot reach. Without it
    // "no corrections" is satisfied by two bodies that went nowhere together.
    const full = even(C().BASE_HEALTH, directionWithRoom())
    expect(Math.abs(full.server.vx)).toBeCloseTo(C().WALK_SPEED, 3)
    expect(Math.abs(full.server.x - full.startX)).toBeGreaterThan(0)
    expect(full.stats.corrections).toBe(0)
  })

  it('produces no more corrections than a healthy player', () => {
    const hurt = even(C().BASE_HEALTH / 2, directionWithRoom())
    // Slower than the healthy control, so the multiplier really is in play.
    expect(Math.abs(hurt.server.vx)).toBeLessThan(C().WALK_SPEED)
    expect(Math.abs(hurt.server.vx)).toBeGreaterThan(0)
    expect(hurt.stats.corrections).toBe(0)
    expect(hurt.stats.snaps).toBe(0)
  })

  it('and the control: a mirror that never learns its health never stops correcting', () => {
    // The pre-T20.19 client, staged deliberately: the server is hurt, the
    // mirror believes it is whole, and the wire never says otherwise. If this
    // read zero the two tests above would be vacuous — and it is what fails
    // first if either half of the fix is undone, since with `apply_input` back
    // on `1.0`, or `setPlayerState` no longer forwarding health, neither side
    // can be made slow and the two agree again.
    const lied = walkReconciling({
      server: C().BASE_HEALTH / 2,
      client: C().BASE_HEALTH,
      snapshot: C().BASE_HEALTH,
      button: directionWithRoom(),
    })
    expect(lied.stats.corrections).toBeGreaterThan(0)
    // *Permanently*, and this is the half that says so: a correction snaps the
    // body onto the server's, but nothing it carries slows the mirror down, so
    // the same 12.5 % speed error re-crosses the epsilon and it corrects again,
    // in the second half of the run exactly as in the first. A one-off
    // disagreement that settled would satisfy the line above and fail this one.
    expect(lied.stats.corrections).toBeGreaterThan(lied.correctionsAtHalf)
    expect(lied.correctionsAtHalf).toBeGreaterThan(0)
  })

  it('a correction teaches the mirror its health', () => {
    const p = new Predictor(core, 0)
    p.pushInput(inp(1, directionWithRoom()), DT)
    expect(core.playerState(0)!.health).toBe(C().BASE_HEALTH)

    const s = core.playerState(0)!
    const hurt = C().BASE_HEALTH / 4
    // Far enough off to be above the epsilon, or reconcile returns early.
    p.reconcile({
      tick: 0,
      lastInputSeq: 1,
      state: { ...s, x: s.x + C().RECONCILE_EPSILON_PX * 10, health: hurt },
    })
    expect(p.stats.corrections).toBe(1)
    expect(core.playerState(0)!.health).toBe(hurt)
  })
})

/**
 * T22.10B: a relocation the server announces (a pad, a vortex trip) snaps the
 * simulation and the render at once — and only when the prediction is not already
 * there, so an event that arrives after the snapshot does not throw away the
 * inputs replayed since.
 */
describe('relocate', () => {
  /**
   * T22.12E F1's fixtures walk right from the spawn: 150 px/s, and a wall stops the
   * body at seq 21 on this map (measured), so every tick they read is before it.
   */
  const LEAD = 20

  it('snaps sim and render to the arrival, at rest', () => {
    const p = new Predictor(core, 0)
    for (let i = 1; i <= 3; i++) p.pushInput(inp(i, BTN.RIGHT), DT)
    const s = core.playerState(0)!
    const to = { x: s.x + 600, y: s.y - 200 }
    expect(p.relocate(to.x, to.y, 3)).toBe(true)
    const after = core.playerState(0)!
    expect([after.x, after.y, after.vx, after.vy]).toEqual([to.x, to.y, 0, 0])
    expect(p.renderPos).toEqual(to)
  })

  // T22.12D F3: the dev hook's placement is tens of pixels — under the snap distance.
  it('a relocation too short to snap still makes the next correction its own, not a misprediction', () => {
    const short = C().RECONCILE_EPSILON_PX * 20
    const run = (told: boolean) => {
      reset()
      const p = new Predictor(core, 0)
      p.pushInput(inp(1, 0), DT)
      p.reconcile({ tick: 1, lastInputSeq: 1, state: core.playerState(0)! })
      p.pushInput(inp(2, 0), DT)
      const s = core.playerState(0)!
      if (told) expect(p.relocate(s.x + short, s.y, 2)).toBe(false)
      const settled = p.stats.settled
      p.reconcile({ tick: 2, lastInputSeq: 2, state: { ...s, x: s.x + short, vx: 0, vy: 0 } })
      return { corrected: p.stats.corrections, settled: p.stats.settled - settled, maxAck: p.stats.maxAckErrorPx }
    }
    const told = run(true)
    expect(told.corrected).toBe(1)
    expect(told.settled).toBe(1)
    expect(told.maxAck).toBeLessThanOrEqual(C().RECONCILE_EPSILON_PX)
    // Control: the same move unannounced is a counted misprediction of that size.
    const untold = run(false)
    expect(untold.settled).toBe(0)
    expect(untold.maxAck).toBeCloseTo(short, 3)
  })

  /**
   * T22.12E F1: a moving body, 30 inputs pushed; the snapshot for tick 20 (acking
   * seq 20, which ran on it) is reconciled **first** and already carries the move,
   * then the relocation event for tick 20 arrives. The current prediction is ten
   * inputs ahead, so measured there the move looks unexplained — and the next
   * correction, a **genuine** misprediction, was marked the relocation's and left
   * out of the maxima. Control: the same event arriving *before* its snapshot, for
   * a move the prediction did not make, is still the relocation's.
   */
  it('a snapshot that already carried the relocation leaves the next misprediction counted', () => {
    const wrong = C().RECONCILE_EPSILON_PX * 10
    const run = (eventTick: number, lastSnap: number) => {
      reset()
      const p = new Predictor(core, 0)
      const at = new Map<number, PlayerState>()
      for (let i = 1; i <= LEAD; i++) {
        p.pushInput(inp(i, BTN.RIGHT), DT)
        at.set(i, core.playerState(0)!)
      }
      p.reconcile({ tick: lastSnap, lastInputSeq: lastSnap, state: at.get(lastSnap)! })
      const arrive = at.get(10)!
      expect(p.relocate(arrive.x + (eventTick > lastSnap ? wrong : 0), arrive.y, eventTick)).toBe(false)
      const settled = p.stats.settled
      const s14 = at.get(14)!
      p.reconcile({ tick: 14, lastInputSeq: 14, state: { ...s14, x: s14.x + wrong } })
      return { settled: p.stats.settled - settled, maxAck: p.stats.maxAckErrorPx }
    }
    const seen = run(10, 10)
    expect(seen.settled).toBe(0)
    expect(seen.maxAck).toBeCloseTo(wrong, 3)
    // Control: the event first (tick 10, last snapshot 9), a move the prediction lacked.
    const first = run(10, 9)
    expect(first.settled).toBe(1)
    expect(first.maxAck).toBeLessThanOrEqual(C().RECONCILE_EPSILON_PX)
  })

  /**
   * T22.12E F1: the event arrives before its snapshot, and the prediction **made**
   * the move (a vortex trip the core predicted): at the event's tick it is already
   * there, so nothing is the relocation's, and a genuine error after it counts. The
   * current prediction, eight inputs on, is what the old branch compared.
   */
  it('a relocation the prediction already made at its tick marks nothing', () => {
    const wrong = C().RECONCILE_EPSILON_PX * 10
    const p = new Predictor(core, 0)
    const at = new Map<number, PlayerState>()
    for (let i = 1; i <= LEAD; i++) {
      p.pushInput(inp(i, BTN.RIGHT), DT)
      at.set(i, core.playerState(0)!)
    }
    p.reconcile({ tick: 8, lastInputSeq: 8, state: at.get(8)! })
    const arrive = at.get(12)!
    expect(Math.hypot(core.playerState(0)!.x - arrive.x, 0)).toBeGreaterThan(C().RECONCILE_EPSILON_PX)
    expect(p.relocate(arrive.x, arrive.y, 12)).toBe(false)
    const settled = p.stats.settled
    p.reconcile({ tick: 12, lastInputSeq: 12, state: { ...arrive, x: arrive.x + wrong } })
    expect(p.stats.settled - settled).toBe(0)
    expect(p.stats.maxAckErrorPx).toBeCloseTo(wrong, 3)
  })

  it('does nothing when the prediction is already there (the snapshot came first)', () => {
    const p = new Predictor(core, 0)
    p.pushInput(inp(1, BTN.RIGHT), DT)
    const s = core.playerState(0)!
    expect(p.relocate(s.x + 3, s.y, 1)).toBe(false)
    expect(core.playerState(0)!.x).toBe(s.x)
  })
})

/**
 * T22.10B: `lastJumpPx` is the rubber-band — how far a correction moved the body —
 * and it is ~0 for a right prediction of a *moving* body, where `lastCorrectionPx`
 * (current prediction against the acknowledged state) reads the pending inputs'
 * travel. The control is a wrong server state: then the jump is the error.
 */
describe('the correction jump', () => {
  it('is ~0 when the prediction was right, however far the pending inputs moved it', () => {
    const p = new Predictor(core, 0)
    for (let i = 1; i <= 6; i++) p.pushInput(inp(i, BTN.RIGHT), DT)
    // The server's state at seq 3, computed by the same code on the second core.
    for (let i = 1; i <= 3; i++) mirror.applyInput(0, i, BTN.RIGHT, 0, DT)
    const at3 = mirror.playerState(0)!
    const before = core.playerState(0)!
    p.reconcile({ tick: 0, lastInputSeq: 3, state: at3 })
    // The prediction's own error at the acked input is ~0 …
    expect(p.stats.lastAckErrorPx).toBeLessThan(0.01)
    // … while the pending inputs' travel is past the epsilon (the control that this
    // is the moving case the old gate got wrong).
    expect(Math.hypot(before.x - at3.x, before.y - at3.y)).toBeGreaterThan(C().RECONCILE_EPSILON_PX)
    // T22.10D F8: so nothing is corrected, and nothing moves.
    expect(p.stats.corrections).toBe(0)
    expect(core.playerState(0)!.x).toBeCloseTo(before.x, 5)
  })

  /**
   * T22.10D F8, the other way: the gate reads the prediction **at the ack**, so a
   * wrong one is corrected even when the current prediction happens to sit on the
   * server's state. The old gate compared those two and returned early.
   */
  it('corrects a wrong prediction at the ack however close the current one is', () => {
    const p = new Predictor(core, 0)
    for (let i = 1; i <= 6; i++) p.pushInput(inp(i, BTN.RIGHT), DT)
    const now = core.playerState(0)!
    // The server says: after seq 3 the body is where this client has it after 6.
    p.reconcile({ tick: 0, lastInputSeq: 3, state: now })
    expect(p.stats.lastAckErrorPx).toBeGreaterThan(C().RECONCILE_EPSILON_PX)
    expect(p.stats.corrections).toBe(1)
    expect(p.stats.lastJumpPx).toBeGreaterThan(C().RECONCILE_EPSILON_PX)
  })

  /**
   * T22.10D: a snapshot may ack the **same** seq as the last one — the results
   * screen stops sending while the prediction keeps stepping. A right prediction
   * there is still left alone; the server moving the body without input (it
   * steps a neutral tick after the bell) is still corrected.
   */
  it('a repeated ack compares against the same prediction, both ways', () => {
    const p = new Predictor(core, 0)
    for (let i = 1; i <= 4; i++) p.pushInput(inp(i, BTN.LEFT), DT)
    mirror.applyInput(0, 1, BTN.LEFT, 0, DT)
    const at1 = mirror.playerState(0)!
    p.reconcile({ tick: 0, lastInputSeq: 1, state: at1 })
    p.reconcile({ tick: 0, lastInputSeq: 1, state: at1 })
    expect(p.stats.corrections).toBe(0)
    p.reconcile({ tick: 0, lastInputSeq: 1, state: { ...at1, y: at1.y + 10 } })
    expect(p.stats.corrections).toBe(1)
  })

  /**
   * T22.10D F8: the render snaps on how far the correction **moved** the body, not
   * on the pending travel. A fast body with many inputs in flight is more than
   * `SNAP_PX` from the acked state however right its prediction; a small real
   * error there must be eased, not snapped.
   */
  it('does not snap the render for a small error on a fast body', () => {
    const p = new Predictor(core, 0)
    // Left: this seed's spawn has open ground that way (right meets a wall at ~42 px).
    const n = 40
    for (let i = 1; i <= n; i++) p.pushInput(inp(i, BTN.LEFT), DT)
    for (let i = 1; i <= 3; i++) mirror.applyInput(0, i, BTN.LEFT, 0, DT)
    const at3 = mirror.playerState(0)!
    const now = core.playerState(0)!
    // The control: the pending travel is past the render's snap distance (64 px,
    // `prediction.ts::SNAP_PX`), so the old gate snapped on it.
    expect(Math.hypot(now.x - at3.x, now.y - at3.y)).toBeGreaterThan(64)
    p.reconcile({ tick: 0, lastInputSeq: 3, state: { ...at3, x: at3.x + 5 } })
    expect(p.stats.corrections).toBe(1)
    expect(p.stats.snaps).toBe(0)
  })

  /**
   * A velocity the prediction does not have (a knockback applied on the server)
   * leaves the position right at the ack and wrong a snapshot later. The gate
   * takes it now rather than one snapshot late.
   */
  it('corrects a velocity the prediction missed although the position agrees', () => {
    const p = new Predictor(core, 0)
    for (let i = 1; i <= 3; i++) p.pushInput(inp(i, 0), DT)
    const s = core.playerState(0)!
    p.reconcile({ tick: 0, lastInputSeq: 3, state: { ...s, vx: s.vx + 400 } })
    expect(p.stats.lastAckErrorPx).toBeLessThan(0.01)
    expect(p.stats.corrections).toBe(1)
  })

  it('is the error when the server disagrees', () => {
    const p = new Predictor(core, 0)
    for (let i = 1; i <= 3; i++) p.pushInput(inp(i, 0), DT)
    const s = core.playerState(0)!
    p.reconcile({ tick: 0, lastInputSeq: 3, state: { ...s, x: s.x + 40 } })
    expect(p.stats.lastJumpPx).toBeCloseTo(40, 3)
    expect(p.stats.lastAckErrorPx).toBeCloseTo(40, 3)
  })
})

/**
 * T22.10E F-6: `alive` and `health` are in the gate beside `moveMods` because
 * prediction never changes them and the gate now holds while moving (T22.10D F8).
 * Each alone, with the position right at the ack, must still be installed — the
 * control is `is ~0 when the prediction was right` above, the same fixture with
 * nothing changed, which corrects nothing.
 */
describe('the reconcile gate carries what the position cannot (T22.10E F-6)', () => {
  function movingAt3(): { p: Predictor; at3: PlayerState } {
    const p = new Predictor(core, 0)
    // Left: this seed's spawn has open ground that way.
    for (let i = 1; i <= 6; i++) p.pushInput(inp(i, BTN.LEFT), DT)
    for (let i = 1; i <= 3; i++) mirror.applyInput(0, i, BTN.LEFT, 0, DT)
    return { p, at3: mirror.playerState(0)! }
  }

  it('a change of health alone, while moving, is installed', () => {
    const { p, at3 } = movingAt3()
    expect(Math.abs(at3.vx)).toBeGreaterThan(0)
    const hurt = C().BASE_HEALTH / 2
    p.reconcile({ tick: 0, lastInputSeq: 3, state: { ...at3, health: hurt } })
    expect(p.stats.lastAckErrorPx).toBeLessThan(0.01)
    expect(p.stats.corrections).toBe(1)
    expect(core.playerState(0)!.health).toBe(hurt)
  })

  it('a death alone, while moving, is installed', () => {
    const { p, at3 } = movingAt3()
    p.reconcile({ tick: 0, lastInputSeq: 3, state: { ...at3, alive: false } })
    expect(p.stats.lastAckErrorPx).toBeLessThan(0.01)
    expect(p.stats.corrections).toBe(1)
    expect(core.playerState(0)!.alive).toBe(false)
  })
})

/**
 * T22.10E F-4: the maxima the harness prints leave out the first reconcile after
 * a relocation or an ack gap — that snapshot measures the event (a trip, the
 * round change of a rematch), not the prediction. Only the first: the control is
 * the next correction, which counts.
 */
describe('the rubber-band maxima (T22.10E F-4)', () => {
  const off = () => C().RECONCILE_EPSILON_PX * 10

  it('leave out the first correction after an ack gap, and only the first', () => {
    const p = new Predictor(core, 0)
    for (let i = 1; i <= 3; i++) p.pushInput(inp(i, 0), DT)
    p.reconcile({ tick: 0, lastInputSeq: 3, state: core.playerState(0)! })
    // The seq ran on through a results screen: 4..9 were never pushed.
    for (let i = 10; i <= 12; i++) p.pushInput(inp(i, 0), DT)
    const s = core.playerState(0)!
    p.reconcile({ tick: 0, lastInputSeq: 11, state: { ...s, x: s.x + off() } })
    expect(p.stats.corrections).toBe(1)
    expect(p.stats.lastJumpPx).toBeGreaterThan(off() / 2)
    expect(p.stats.maxEasedJumpPx).toBe(0)
    expect(p.stats.maxAckErrorPx).toBe(0)
    p.pushInput(inp(13, 0), DT)
    const t = core.playerState(0)!
    p.reconcile({ tick: 0, lastInputSeq: 13, state: { ...t, x: t.x + off() } })
    expect(p.stats.corrections).toBe(2)
    // Two events: the first ack's anchor (T22.10F) and the gap's correction.
    expect(p.stats.settled).toBe(2)
    expect(p.stats.maxEasedJumpPx).toBeGreaterThan(off() / 2)
    expect(p.stats.maxAckErrorPx).toBeGreaterThan(off() / 2)
  })

  it('leave out the first correction after a relocation, and only the first', () => {
    const p = new Predictor(core, 0)
    for (let i = 1; i <= 3; i++) p.pushInput(inp(i, 0), DT)
    const s = core.playerState(0)!
    // Past the render's snap distance (`prediction.ts::SNAP_PX`, 64), or it is no relocation.
    expect(p.relocate(s.x, s.y - 100, 3)).toBe(true)
    const r = core.playerState(0)!
    p.reconcile({ tick: 0, lastInputSeq: 3, state: { ...r, x: r.x + off() } })
    expect(p.stats.corrections).toBe(1)
    expect(p.stats.lastJumpPx).toBeGreaterThan(off() / 2)
    expect(p.stats.maxEasedJumpPx).toBe(0)
    p.pushInput(inp(4, 0), DT)
    const t = core.playerState(0)!
    p.reconcile({ tick: 0, lastInputSeq: 4, state: { ...t, x: t.x + off() } })
    expect(p.stats.maxEasedJumpPx).toBeGreaterThan(off() / 2)
  })

  // T22.10E review (a): a void death freezes the server's body where it died while
  // the local copy falls on — `void` read 45–63 px of "rubber-band" that was the death.
  it('leave out a correction that flips alive, and only that one', () => {
    const p = new Predictor(core, 0)
    p.pushInput(inp(1, 0), DT)
    // Anchored first, so the flip below is not the first ack's anchor (T22.10F).
    p.reconcile({ tick: 0, lastInputSeq: 1, state: core.playerState(0)! })
    expect(p.stats.settled).toBe(1)
    for (let i = 2; i <= 3; i++) p.pushInput(inp(i, 0), DT)
    const s = core.playerState(0)!
    p.reconcile({ tick: 0, lastInputSeq: 3, state: { ...s, x: s.x + off(), alive: false } })
    expect(p.stats.corrections).toBe(1)
    expect(p.stats.lastJumpPx).toBeGreaterThan(off() / 2)
    expect(p.stats.settled).toBe(2)
    expect(p.stats.maxEasedJumpPx).toBe(0)
    expect(p.stats.maxAckErrorPx).toBe(0)
    // The control: still dead, off again — no flip, so it counts.
    p.pushInput(inp(4, 0), DT)
    const t = core.playerState(0)!
    p.reconcile({ tick: 0, lastInputSeq: 4, state: { ...t, x: t.x + off(), alive: false } })
    expect(p.stats.corrections).toBe(2)
    expect(p.stats.settled).toBe(2)
    expect(p.stats.maxEasedJumpPx).toBeGreaterThan(off() / 2)
  })

  // T22.10F: the first ack anchors; a repeated ack is time this client lost.
  it('leave out the first ack, a repeated ack and its residue, and count the next', () => {
    const p = new Predictor(core, 0)
    for (let i = 1; i <= 4; i++) p.pushInput(inp(i, 0), DT)
    const s = core.playerState(0)!
    p.reconcile({ tick: 0, lastInputSeq: 2, state: { ...s, x: s.x + off() } })
    expect(p.stats.corrections).toBe(1)
    expect(p.stats.settled).toBe(1)
    expect(p.stats.maxEasedJumpPx).toBe(0)
    const t = core.playerState(0)!
    p.reconcile({ tick: 0, lastInputSeq: 2, state: { ...t, x: t.x + off() } })
    expect(p.stats.corrections).toBe(2)
    expect(p.stats.settled).toBe(2)
    expect(p.stats.maxEasedJumpPx).toBe(0)
    // The first new ack after it is the hitch's residue — left out too.
    const u = core.playerState(0)!
    p.reconcile({ tick: 0, lastInputSeq: 3, state: { ...u, x: u.x + off() } })
    expect(p.stats.corrections).toBe(3)
    expect(p.stats.settled).toBe(3)
    expect(p.stats.maxEasedJumpPx).toBe(0)
    // The control: the next new ack, still off — counted.
    const v = core.playerState(0)!
    p.reconcile({ tick: 0, lastInputSeq: 4, state: { ...v, x: v.x + off() } })
    expect(p.stats.corrections).toBe(4)
    expect(p.stats.maxEasedJumpPx).toBeGreaterThan(off() / 2)
  })
})

/**
 * T22.10G: the two hitch events the T22.10F review found counted as rubber-band — each
 * with its control, the next ordinary correction, which is counted.
 */
describe('the rubber-band maxima leave out the startup and a trim (T22.10G)', () => {
  const off = () => C().RECONCILE_EPSILON_PX * 10

  it('leave out an ack-0 correction while inputs are pending', () => {
    const p = new Predictor(core, 0)
    for (let i = 1; i <= 3; i++) p.pushInput(inp(i, 0), DT)
    // The server has not run seq 1 yet (the jitter buffer's lead): ack 0, and a body
    // that differs from the spawn this client predicted from.
    const s = core.playerState(0)!
    p.reconcile({ tick: 3, lastInputSeq: 0, state: { ...s, x: s.x + off() } })
    expect(p.stats.corrections).toBe(1)
    expect(p.stats.settled).toBe(1)
    expect(p.stats.maxEasedJumpPx).toBe(0)
    expect(p.stats.maxAckErrorPx).toBe(0)
    // The first ack is the anchor (T22.10F), then the control: counted.
    p.reconcile({ tick: 6, lastInputSeq: 1, state: core.playerState(0)! })
    p.pushInput(inp(4, 0), DT)
    const t = core.playerState(0)!
    p.reconcile({ tick: 9, lastInputSeq: 4, state: { ...t, x: t.x + off() } })
    expect(p.stats.maxEasedJumpPx).toBeGreaterThan(off() / 2)
  })

  it('leave out a correction whose ack ran more seqs than ticks — a server trim', () => {
    const p = new Predictor(core, 0)
    for (let i = 1; i <= 3; i++) p.pushInput(inp(i, 0), DT)
    p.reconcile({ tick: 3, lastInputSeq: 1, state: core.playerState(0)! })
    expect(p.stats.settled).toBe(1)
    for (let i = 4; i <= 9; i++) p.pushInput(inp(i, 0), DT)
    // Three ticks, six seqs acked: the buffer dropped its oldest past the target.
    const s = core.playerState(0)!
    p.reconcile({ tick: 6, lastInputSeq: 7, state: { ...s, x: s.x + off() } })
    expect(p.stats.corrections).toBe(1)
    expect(p.stats.settled).toBe(2)
    expect(p.stats.maxEasedJumpPx).toBe(0)
    expect(p.stats.maxAckErrorPx).toBe(0)
    // The control: three seqs in three ticks, off — counted.
    p.pushInput(inp(10, 0), DT)
    const t = core.playerState(0)!
    p.reconcile({ tick: 9, lastInputSeq: 10, state: { ...t, x: t.x + off() } })
    expect(p.stats.corrections).toBe(2)
    expect(p.stats.settled).toBe(2)
    expect(p.stats.maxEasedJumpPx).toBeGreaterThan(off() / 2)
  })
})

/**
 * T22.10F (R89): **the server stands in for a late input with the held one.** Every
 * tick simulates every player once; when input `k` has not arrived, the server runs
 * the newest input's held buttons under seq `k` and acks `k`. A client that held
 * the same buttons predicted exactly that tick; one whose input changed on it takes
 * one correction, and the tick after — the real input again — agrees.
 */
describe('a stood-in tick (T22.10F)', () => {
  function hitch(fifth: number) {
    const p = new Predictor(core, 0)
    const sent = [BTN.RIGHT, BTN.RIGHT, BTN.RIGHT, BTN.RIGHT, fifth, fifth, fifth]
    sent.forEach((b, i) => p.pushInput(inp(i + 1, b), DT))
    // The server: 1..4 arrived on time; 5 is late, so it stands in with 4's held RIGHT.
    for (let s = 1; s <= 4; s++) mirror.applyInput(0, s, BTN.RIGHT, 0, DT)
    mirror.applyInput(0, 5, BTN.RIGHT, 0, DT)
    p.reconcile({ tick: 5, lastInputSeq: 5, state: mirror.playerState(0)! })
    const first = p.stats.corrections
    // 5 arrives late and is discarded; 6 and 7 arrive on time and run.
    for (const s of [6, 7]) {
      mirror.applyInput(0, s, fifth, 0, DT)
      p.reconcile({ tick: s, lastInputSeq: s, state: mirror.playerState(0)! })
    }
    return { first, total: p.stats.corrections }
  }

  it('agrees when the held input did not change', () => {
    expect(hitch(BTN.RIGHT)).toEqual({ first: 0, total: 0 })
  })

  // The slow page's normal case: a frame's inputs are produced at its end, after
  // the server has already stood in for the first of them and acked it.
  it('stands in locally for acked seqs not yet pushed, and skips them when they come', () => {
    const p = new Predictor(core, 0)
    for (let s = 1; s <= 4; s++) p.pushInput(inp(s, BTN.RIGHT), DT)
    for (let s = 1; s <= 4; s++) mirror.applyInput(0, s, BTN.RIGHT, 0, DT)
    p.reconcile({ tick: 4, lastInputSeq: 4, state: mirror.playerState(0)! })
    // The server stands in for 5 and 6 (held RIGHT) and acks 6 before 5..8 arrive.
    for (const s of [5, 6]) mirror.applyInput(0, s, BTN.RIGHT, 0, DT)
    p.reconcile({ tick: 6, lastInputSeq: 6, state: mirror.playerState(0)! })
    expect(p.stats.corrections).toBe(0)
    // The frame's inputs arrive: 5 and 6 are discarded by the server, 7 and 8 run.
    for (let s = 5; s <= 8; s++) p.pushInput(inp(s, BTN.RIGHT), DT)
    expect(p.stats.pending).toBe(2)
    for (const s of [7, 8]) mirror.applyInput(0, s, BTN.RIGHT, 0, DT)
    p.reconcile({ tick: 8, lastInputSeq: 8, state: mirror.playerState(0)! })
    expect(p.stats.corrections).toBe(0)
    expect(Math.hypot(core.playerState(0)!.x - mirror.playerState(0)!.x, core.playerState(0)!.y - mirror.playerState(0)!.y)).toBeLessThan(1e-3)
    // The control: the body moved, so a tick counted twice or skipped would show.
    expect(mirror.playerState(0)!.x - core.meta.spawn_points[0]!.x).toBeGreaterThan(C().RECONCILE_EPSILON_PX)
  })

  it('corrects once when it did', () => {
    // The control for the case above: the stood-in tick is visible to the gate —
    // at the stood-in ack or, while one tick's difference is still under the
    // epsilon, at the next; once either way, and the replay then agrees.
    expect(hitch(BTN.LEFT).total).toBe(1)
  })
})

/**
 * T22.10E F-3: **after the bell the prediction runs the server's neutral ticks
 * and keeps nothing.** The server drops every input in `ended` and steps each
 * body a neutral tick (T21.30); the ack stands still. The client kept predicting
 * from its own inputs, grew `pending` without bound (14 → 301 in a match), and
 * corrected every snapshot against a stale prediction — measured, 104 corrections
 * and jumps to 41 px over one results screen.
 *
 * Staged with the mirror as the server: a body in the air (so a neutral tick
 * still moves it), two inputs in flight at the bell (the server drops them), the
 * client told of the bell two ticks late, and snapshots every
 * `SIM_HZ / SNAPSHOT_HZ` ticks delivered after a jittered number of local steps.
 */
describe('the results screen (T22.10E F-3)', () => {
  function bell(jitter: number[]) {
    reset()
    const lift = (c: Core) => {
      const b = c.playerState(0)!
      c.setPlayerState(0, { ...b, y: b.y - C().PLAYER_H * 12, vy: 0, grounded: false })
    }
    lift(core)
    lift(mirror)
    const p = new Predictor(core, 0)
    const per = C().SIM_HZ / C().SNAPSHOT_HZ
    let seq = 0
    let tick = 0
    // Playing: the server consumes 1..4; 5..6 are in flight when the bell rings.
    for (let i = 0; i < 6; i++) p.pushInput(inp(++seq, BTN.LEFT), DT)
    for (let s = 1; s <= 4; s++) {
      mirror.applyInput(0, s, BTN.LEFT, 0, DT)
      tick++
    }
    const acked = 4
    mirror.setPhase('ended')
    const neutral = () => {
      mirror.applyInput(0, acked, 0, 0, DT)
      tick++
    }
    // The client hears of it two ticks late, still sending.
    for (let i = 0; i < 2; i++) {
      neutral()
      p.pushInput(inp(++seq, BTN.LEFT), DT)
    }
    core.setPhase('ended')
    const from = mirror.playerState(0)!
    const jumps: number[] = []
    let pendingMax = 0
    for (let i = 0; i < 10; i++) {
      for (let k = 0; k < per; k++) neutral()
      for (let k = 0; k < per + jitter[i % jitter.length]!; k++) {
        p.pushInput(inp(++seq, BTN.LEFT), DT)
        pendingMax = Math.max(pendingMax, p.stats.pending)
      }
      const before = p.stats.corrections
      p.reconcile({ tick, lastInputSeq: acked, state: mirror.playerState(0)! })
      if (p.stats.corrections > before) jumps.push(p.stats.lastJumpPx)
    }
    const to = mirror.playerState(0)!
    return { jumps, pendingMax, fell: Math.hypot(to.x - from.x, to.y - from.y), stats: p.stats }
  }

  for (const [name, jitter] of [
    ['on time', [0]],
    // The first snapshot anchors; after it the local body is behind the server
    // (it has run fewer ticks than the snapshot's and must run the ones it owes),
    // then ahead, then behind again.
    ['jittered', [0, -1, 2, -2, 1, -1, 1, 0]],
  ] as const) {
    it(`keeps nothing pending and corrects only the bell itself (${name})`, () => {
      const r = bell([...jitter])
      // The control: the body moved after the bell, so a stale prediction would show.
      expect(r.fell).toBeGreaterThan(C().RECONCILE_EPSILON_PX * 10)
      expect(r.pendingMax).toBe(0)
      // The first correction is the two inputs the server dropped at the bell.
      const [, ...later] = r.jumps
      expect(Math.max(0, ...later)).toBeLessThanOrEqual(C().RECONCILE_EPSILON_PX)
    })

    it(`counts the bell's anchoring correction as settled, not in the maxima (${name})`, () => {
      const r = bell([...jitter])
      // The control: the anchoring correction really moved the body.
      expect(r.jumps[0]!).toBeGreaterThan(C().RECONCILE_EPSILON_PX)
      expect(r.stats.maxEasedJumpPx).toBeLessThanOrEqual(C().RECONCILE_EPSILON_PX)
      expect(r.stats.settled).toBeGreaterThanOrEqual(1)
    })
  }
})

/**
 * T22.10E review (c): **the results screen's catch-up is capped at one frame.** A
 * local body behind the snapshot's tick runs the ticks it owes — at most
 * `MAX_FRAME_TICKS` (`MAX_FRAME_DT`, the fixed step's own ceiling); further behind
 * than that the local clock has lost the server's (a hidden tab) and the
 * correction re-anchors instead of running them all in one frame.
 */
describe('the results screen catch-up cap (T22.10E review)', () => {
  const frameTicks = () => Math.ceil(C().MAX_FRAME_DT * C().SIM_HZ)
  function behind(by: number): number {
    core.setPhase('ended')
    const p = new Predictor(core, 0)
    p.pushInput(inp(1, 0), DT)
    // Anchors the label on tick 100.
    p.reconcile({ tick: 100, lastInputSeq: 0, state: core.playerState(0)! })
    const spy = vi.spyOn(core, 'applyInput')
    try {
      p.reconcile({ tick: 100 + by, lastInputSeq: 0, state: core.playerState(0)! })
      return spy.mock.calls.length
    } finally {
      spy.mockRestore()
    }
  }

  it('runs the owed ticks within a frame', () => {
    // The control: the counter sees catch-up steps at all.
    expect(behind(3)).toBeGreaterThanOrEqual(3)
  })

  it('re-anchors past a frame, stepping fewer than a frame', () => {
    expect(behind(10 * frameTicks())).toBeLessThan(frameTicks())
  })
})
