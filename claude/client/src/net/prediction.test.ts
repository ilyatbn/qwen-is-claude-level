import { describe, expect, it, beforeAll, beforeEach } from 'vitest'
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
    p.reconcile({ lastInputSeq: 3, state: s })
    expect(p.pendingInputs.map((q) => q.input.seq)).toEqual([4, 5])
  })

  it('an acknowledgement for everything empties the buffer', () => {
    const p = new Predictor(core, 0)
    for (let i = 1; i <= 5; i++) p.pushInput(inp(i, BTN.RIGHT), DT)
    p.reconcile({ lastInputSeq: 99, state: core.playerState(0)! })
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

    // Client predicts all 12.
    for (const f of all) p.pushInput(f, DT)

    // Now force a correction by nudging the client off, then reconciling.
    core.setPlayerState(0, { ...core.playerState(0)!, x: core.playerState(0)!.x + 40 })
    p.reconcile({ lastInputSeq: 4, state: serverState })

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
    for (const f of all) p.pushInput(f, DT)

    core.setPlayerState(0, { ...core.playerState(0)!, x: core.playerState(0)!.x + 40 })
    // Acknowledge *everything*, so nothing is replayed — the client should then
    // sit at the server state rather than 8 inputs ahead of it.
    p.reconcile({ lastInputSeq: 12, state: serverState })
    for (const f of all.slice(4)) mirror.applyInput(0, f.seq, f.buttons, f.aim, DT)

    expect(Math.abs(core.playerState(0)!.x - mirror.playerState(0)!.x)).toBeGreaterThan(1)
  })
})

describe('corrections', () => {
  it('ignores error below the epsilon', () => {
    const p = new Predictor(core, 0)
    p.pushInput(inp(1, 0), DT)
    const s = core.playerState(0)!
    const nudged: PlayerState = { ...s, x: s.x + C().RECONCILE_EPSILON_PX * 0.5 }
    p.reconcile({ lastInputSeq: 1, state: nudged })
    expect(p.stats.corrections).toBe(0)
    // and it did not move us
    expect(core.playerState(0)!.x).toBeCloseTo(s.x, 5)
  })

  it('corrects above the epsilon and records the distance', () => {
    const p = new Predictor(core, 0)
    p.pushInput(inp(1, 0), DT)
    const s = core.playerState(0)!
    const nudged: PlayerState = { ...s, x: s.x + 10 }
    p.reconcile({ lastInputSeq: 1, state: nudged })
    expect(p.stats.corrections).toBe(1)
    expect(p.stats.lastCorrectionPx).toBeCloseTo(10, 3)
    expect(core.playerState(0)!.x).toBeCloseTo(nudged.x, 3)
  })

  it('tracks the maximum correction across several', () => {
    const p = new Predictor(core, 0)
    for (const dx of [10, 40, 25]) {
      p.pushInput(inp(1, 0), DT)
      const s = core.playerState(0)!
      p.reconcile({ lastInputSeq: 1, state: { ...s, x: s.x + dx } })
    }
    expect(p.stats.maxCorrectionPx).toBeGreaterThanOrEqual(39)
  })
})

describe('render smoothing', () => {
  it('eases toward the simulation rather than jumping', () => {
    const p = new Predictor(core, 0)
    p.pushInput(inp(1, 0), DT)
    const s = core.playerState(0)!
    p.reconcile({ lastInputSeq: 1, state: { ...s, x: s.x + 20 } })

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
    p.reconcile({ lastInputSeq: 1, state: { ...s, x: s.x + 400 } })
    expect(p.stats.snaps).toBe(1)
    expect(p.renderPos.x).toBeCloseTo(core.playerState(0)!.x, 3)
  })

  it('smoothing is frame-rate independent', () => {
    // Two predictors, same correction, same elapsed time, different step counts.
    const a = new Predictor(core, 0)
    a.pushInput(inp(1, 0), DT)
    const s = core.playerState(0)!
    a.reconcile({ lastInputSeq: 1, state: { ...s, x: s.x + 20 } })
    for (let i = 0; i < 6; i++) a.updateRender(1 / 60)
    const after60 = a.renderPos.x
    const target = core.playerState(0)!.x

    reset()
    const b = new Predictor(core, 0)
    b.pushInput(inp(1, 0), DT)
    const s2 = core.playerState(0)!
    b.reconcile({ lastInputSeq: 1, state: { ...s2, x: s2.x + 20 } })
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
      p.reconcile({ lastInputSeq: seq, state: { ...s, health: h.snapshot } })
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
      lastInputSeq: 1,
      state: { ...s, x: s.x + C().RECONCILE_EPSILON_PX * 10, health: hurt },
    })
    expect(p.stats.corrections).toBe(1)
    expect(core.playerState(0)!.health).toBe(hurt)
  })
})
