import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Core, DEFAULT_MAP_GENERATOR, MapGenerator, MapScale, C } from './index'
import { DEFAULT_GRAVITY, SPACE_GRAVITY } from '../scenes/sceneParams'
import { MOVE_MOD } from '../net/codec'

const here = dirname(fileURLToPath(import.meta.url))
const wasmBytes = readFileSync(join(here, 'pkg/game_wasm_bg.wasm'))

async function newCore(): Promise<Core> {
  return Core.init(wasmBytes)
}

describe('Core', () => {
  let core: Core

  beforeAll(async () => {
    core = await newCore()
  })

  it('initialises and exposes constants from Rust', () => {
    const c = C()
    expect(c.VIEWPORT_W).toBe(1280)
    expect(c.VIEWPORT_H).toBe(720)
    expect(c.CHUNK_SIZE).toBe(256)
    expect(c.CAMERA_ZOOM).toBe(2)
    expect(c.PLAYER_W).toBe(16)
    expect(c.PLAYER_H).toBe(28)
  })

  /**
   * T22.05A / R15: the gravity mode decides the map, and the client has to be
   * able to ask for it — `PreviewScene` shows a host the map they are about to
   * play while they are still choosing the mode.
   *
   * The discriminator is `meta.asteroids`, which is empty for every generator
   * but the space one. The control is the same call under `standard`, without
   * which this passes for a build that always makes space maps.
   */
  it('builds a space map for space gravity and a normal one otherwise', () => {
    expect(core.generateForGravity(4242n, MapScale.Small, MapGenerator.V2, 'space')).toBe(true)
    expect(core.meta.asteroids.length).toBeGreaterThan(0)
    const spaceHash = Array.from(core.maskHash()).join(',')
    // Every rock carries a level in 1..5, and they are not all the same one.
    const levels = core.meta.asteroids.map((a) => a.level)
    expect(Math.min(...levels)).toBeGreaterThanOrEqual(1)
    expect(Math.max(...levels)).toBeLessThanOrEqual(5)
    expect(new Set(levels).size).toBeGreaterThan(1)

    expect(core.generateForGravity(4242n, MapScale.Small, MapGenerator.V2, 'standard')).toBe(true)
    expect(core.meta.asteroids).toEqual([])
    expect(Array.from(core.maskHash()).join(',')).not.toBe(spaceHash)

    // And the generator cannot be picked beside the mode: asking for the space
    // generator under standard gravity gets the default map back.
    core.generateForGravity(4242n, MapScale.Small, MapGenerator.Space, 'standard')
    expect(core.meta.asteroids).toEqual([])
  })

  /**
   * `generateWith` is a **request**, not a selection: `MapGenerator::for_gravity`
   * runs on it too, so byte 2 cannot produce a space map under standard gravity
   * and byte 1 cannot produce a landscape under space gravity.
   *
   * Both were reachable in one public call each when T22.05A landed, while the
   * `MapGenerator.Space` doc a few lines up claimed the opposite. Asserted here
   * because that doc is the only other place the rule is written down.
   */
  it('derives the generator from the gravity even when generateWith names one', () => {
    core.setGravity('standard')
    core.generateWith(4242n, MapScale.Small, MapGenerator.Space)
    expect(core.meta.asteroids).toEqual([])

    core.setGravity('space')
    core.generateWith(4242n, MapScale.Small, MapGenerator.V2)
    expect(core.meta.asteroids.length).toBeGreaterThan(0)
    // And `generate`, which routes through the same place.
    core.generate(4242n, MapScale.Small)
    expect(core.meta.asteroids.length).toBeGreaterThan(0)

    core.setGravity('standard')
    core.generate(4242n, MapScale.Small)
    expect(core.meta.asteroids).toEqual([])
  })

  /**
   * `DEFAULT_MAP_GENERATOR` is a TypeScript copy of a Rust constant and nothing
   * about `V2` says it is the default, so this is what notices if the Rust one
   * moves. The control is the other generator: without it this passes for a
   * `generateWith` that ignores its argument.
   */
  it('exports the same default generator Rust generates by default', () => {
    core.setGravity('standard')
    core.generate(4242n, MapScale.Small)
    const byDefault = Array.from(core.maskHash()).join(',')
    core.generateWith(4242n, MapScale.Small, DEFAULT_MAP_GENERATOR)
    expect(Array.from(core.maskHash()).join(',')).toBe(byDefault)
    const other =
      DEFAULT_MAP_GENERATOR === MapGenerator.V2 ? MapGenerator.V1 : MapGenerator.V2
    core.generateWith(4242n, MapScale.Small, other)
    expect(Array.from(core.maskHash()).join(',')).not.toBe(byDefault)
  })

  /**
   * The dev scenes fall back to `DEFAULT_GRAVITY` when the URL says nothing, and
   * `generateForGravity` refuses a spelling it does not know **by generating
   * nothing**. A typo in that constant would therefore leave every sandbox and
   * preview page showing the map that happened to be there before.
   */
  it('accepts the gravity spelling the dev scenes fall back to', () => {
    expect(core.setGravity(DEFAULT_GRAVITY)).toBe(true)
    expect(core.generateForGravity(4242n, MapScale.Small, DEFAULT_MAP_GENERATOR, DEFAULT_GRAVITY)).toBe(
      true,
    )
  })

  /** T22.04: the plume is drawn only when the match's spelling equals this one. */
  it('accepts the zero-g spelling the thruster plume keys on', () => {
    expect(C().GRAVITY_MODES).toContain(SPACE_GRAVITY)
    expect(core.setGravity(SPACE_GRAVITY)).toBe(true)
    // Put it back: the tests below share this core and predict under standard.
    expect(core.setGravity(DEFAULT_GRAVITY)).toBe(true)
  })

  it('refuses an unknown gravity spelling rather than guessing a map', () => {
    core.generate(4242n, MapScale.Small)
    const before = Array.from(core.maskHash()).join(',')
    expect(core.generateForGravity(1n, MapScale.Small, MapGenerator.V2, 'zero-g')).toBe(false)
    // Nothing was generated: refuse rather than clamp (§E6). A silent fallback
    // to standard would show a host the wrong map with no signal at all.
    expect(Array.from(core.maskHash()).join(',')).toBe(before)
  })

  it('generates each scale at the right dimensions', () => {
    core.generate(4242n, MapScale.Small)
    expect([core.width, core.height]).toEqual([2048, 1024])
    core.generate(4242n, MapScale.Medium)
    expect([core.width, core.height]).toEqual([3072, 1536])
    expect(core.chunksX).toBe(12)
    expect(core.chunksY).toBe(6)
  })

  it('parses meta with spawn and surface points', () => {
    core.generate(4242n, MapScale.Small)
    const m = core.meta
    expect(m.spawn_points.length).toBeGreaterThanOrEqual(6)
    expect(m.surface_points.length).toBeGreaterThan(0)
    expect(m.traversable_fraction).toBeGreaterThan(0.5)
    expect(Math.abs(m.wind)).toBeLessThanOrEqual(90)
  })

  it('caches meta until the map changes', () => {
    core.generate(1n, MapScale.Small)
    const a = core.meta
    expect(core.meta).toBe(a)
    core.generate(2n, MapScale.Small)
    expect(core.meta).not.toBe(a)
  })

  it('solidAt agrees with a carve', () => {
    core.generate(4242n, MapScale.Small)
    // Just above the bedrock in the middle is reliably solid.
    const x = Math.floor(core.width / 2)
    const y = core.height - 60
    expect(core.solidAt(x, y)).toBe(true)

    core.carve(x, y, 40)
    expect(core.solidAt(x, y)).toBe(false)
    // Well outside the crater is untouched.
    expect(core.solidAt(x + 120, y)).toBe(true)
  })

  it('reports dirty chunks once per carve', () => {
    core.generate(4242n, MapScale.Small)
    core.takeDirtyChunks()
    core.carve(Math.floor(core.width / 2), core.height - 60, 30)
    expect(core.takeDirtyChunks().length).toBeGreaterThan(0)
    expect(core.takeDirtyChunks().length).toBe(0)
  })

  it('solidAt is out-of-bounds safe', () => {
    core.generate(1n, MapScale.Small)
    expect(core.solidAt(-1, 10)).toBe(false)
    expect(core.solidAt(10, -1)).toBe(false)
    expect(core.solidAt(core.width, 10)).toBe(false)
    expect(core.solidAt(10, core.height)).toBe(false)
  })

  /**
   * The trap this wrapper exists to close: a view over WASM memory is detached by
   * heap growth, and a detached view reads as zeros — a blank map with no error.
   */
  it('survives WASM memory growth after a view is held', () => {
    core.generate(4242n, MapScale.Small)
    const x = Math.floor(core.width / 2)
    const y = core.height - 60
    expect(core.solidAt(x, y)).toBe(true)

    const stale = core.maskView()
    const staleBuffer = stale.buffer

    // Generating a much larger map reallocates and very likely grows the heap.
    core.generate(4242n, MapScale.Large)
    expect([core.width, core.height]).toEqual([4096, 2048])

    const fresh = core.maskView()
    expect(fresh.byteLength).toBe((4096 * 2048) / 8)

    // The mask must still read correctly. If the wrapper handed back the stale
    // view, every read here would be a zero and the map would render blank.
    let solidCount = 0
    for (let px = 0; px < core.width; px += 64) {
      for (let py = 0; py < core.height; py += 64) {
        if (core.solidAt(px, py)) solidCount++
      }
    }
    expect(solidCount).toBeGreaterThan(0)

    if (staleBuffer !== fresh.buffer) {
      // The heap did grow, so this run actually exercised the re-acquire path.
      expect(stale.byteLength === 0 || stale.buffer !== core.maskView().buffer).toBe(true)
    }
  })

  it('round-trips a mask through RLE', () => {
    core.generate(31337n, MapScale.Small)
    const before = core.maskHash()
    const rle = core.maskRle()

    const other = core
    expect(other.loadMask(core.width, core.height, rle)).toBe(true)
    expect(Array.from(other.maskHash())).toEqual(Array.from(before))
  })

  it('rejects a malformed mask payload', () => {
    core.generate(1n, MapScale.Small)
    expect(core.loadMask(256, 256, new Uint8Array([255, 255, 255, 255]))).toBe(false)
    expect(core.loadMask(100, 100, new Uint8Array([0]))).toBe(false)
  })

  it('round-trips player state, health included', () => {
    core.addPlayer(1, 0, 0)
    // Deliberately not BASE_HEALTH: `addPlayer` seats a player at full health,
    // so a snapshot value equal to it would be indistinguishable from the
    // mirror ignoring the argument (T20.19).
    const hurt = C().BASE_HEALTH / 2
    core.setPlayerState(1, {
      x: 12.5,
      y: -3.25,
      vx: 7,
      vy: -1.5,
      grounded: true,
      fuel: 2.5,
      moveState: 0,
      health: hurt,
      // Deliberately `false`, for the same reason `hurt` is not `BASE_HEALTH`:
      // `addPlayer` seats a player alive, so `true` here would be
      // indistinguishable from the mirror ignoring the argument (T20.21).
      alive: false,
      // Deliberately non-zero, for the third time and the same reason
      // (T21.02): `addPlayer` seats a player carrying nothing, so 0 here would
      // be indistinguishable from the mirror ignoring the argument.
      moveMods: MOVE_MOD.boots,
    })
    const s = core.playerState(1)
    expect(s).not.toBeNull()
    expect(s!.moveMods).toBe(MOVE_MOD.boots)
    expect(s!.x).toBe(12.5)
    expect(s!.y).toBe(-3.25)
    expect(s!.grounded).toBe(true)
    expect(s!.fuel).toBe(2.5)
    expect(s!.health).toBe(hurt)
    expect(s!.health).not.toBe(C().BASE_HEALTH)
    expect(s!.alive).toBe(false)
  })

  it('a dead player is not predicted moving, and an alive one is (T20.21)', () => {
    // `world/mod.rs::apply_inputs` skips a dead player before it computes speed.
    // The mirror had no `alive`, so `GameScene` — which pushes input every frame
    // whether or not you are dead — predicted a corpse walking at full speed.
    core.generate(4242n, MapScale.Small)
    const walk = (id: number, alive: boolean): number => {
      core.addPlayer(id, 200, 200)
      const s0 = core.playerState(id)!
      core.setPlayerState(id, { ...s0, vx: 0, vy: 0, alive })
      const x0 = core.playerState(id)!.x
      for (let seq = 1; seq <= 15; seq++) {
        core.applyInput(id, seq, C().BTN_RIGHT, 0, 1 / C().SIM_HZ)
      }
      return Math.abs(core.playerState(id)!.x - x0)
    }
    // The control that makes the zero mean something: the same call on a living
    // player moves. Without it "a dead player does not move" is satisfied by a
    // mirror that never moves anybody.
    expect(walk(21, true)).toBeGreaterThan(1)
    expect(walk(22, false)).toBe(0)
  })

  it('returns null for an unknown player', () => {
    expect(core.playerState(200)).toBeNull()
  })

  it('applies input and moves the player', () => {
    core.generate(4242n, MapScale.Small)
    core.addPlayer(9, 500, 40)
    const before = core.playerState(9)!
    const RIGHT = 1 << 1
    for (let seq = 0; seq < 60; seq++) core.applyInput(9, seq, RIGHT, 0, C().SIM_DT)
    const after = core.playerState(9)!
    expect(after.x).not.toBe(before.x)
  })

  /**
   * T22.02 — the mirror predicts the match's gravity, not the default.
   *
   * **What this would report if `setGravity` reached nothing:** the two falls
   * would be identical and the inequality fails. The `'standard'` arm in the
   * same test is the control — without it, "the fall is shorter" is satisfied
   * by a mirror that stopped simulating.
   *
   * A free fall from a standing start rather than a jump: it needs no button,
   * no ground and no map feature, so the only thing deciding it is gravity.
   * Pinned to `LOW_GRAVITY_SCALE` read from Rust, never to 0.5 written here —
   * a literal in TypeScript that shadows a Rust constant is the drift this
   * architecture exists to prevent.
   */
  it('predicts a low-gravity match under low gravity (T22.02)', () => {
    /**
     * `rocks` picks the map, and the mechanism is worth stating because it is
     * not obvious: `setGravity` deliberately does **not** regenerate, and
     * `generate` derives the generator from whatever the mode is *at that
     * moment*. So setting `'standard'` first and the real mode after gives a
     * space player on a landscape map — a space match with no asteroids in it,
     * which is the fixture the free-fall arms below need now that T22.11B has
     * given space a field.
     */
    const fall = (mode: string, rocks = false): number => {
      expect(core.setGravity(rocks ? mode : 'standard')).toBe(true)
      core.generate(4242n, MapScale.Small)
      expect(core.setGravity(mode)).toBe(true)
      core.addPlayer(11, 500, 40)
      const y0 = core.playerState(11)!.y
      for (let seq = 0; seq < 20; seq++) core.applyInput(11, seq, 0, 0, C().SIM_DT)
      const dropped = core.playerState(11)!.y - y0
      core.removePlayer(11)
      return dropped
    }

    const standard = fall('standard')
    const low = fall('low')
    expect(standard).toBeGreaterThan(0)
    expect(low).toBeCloseTo(standard * C().LOW_GRAVITY_SCALE, 3)
    // T22.03 — and there is no *global* gravity in space: on a map with no
    // asteroids on it, nothing pulls this player anywhere.
    expect(fall('space')).toBe(0)
    // T22.11B — and on a real space map something does, which is the mirror's
    // own attractor field. This is the client-side half of "the field has a
    // production caller": `GameCore::apply_input` builds its `Env` from
    // `world::attractors::env_at`, and if it did not, this would read 0 like the
    // line above. What the field *is* belongs to the Rust tests; what this pins
    // is that the mirror computes one at all.
    expect(fall('space', true)).toBeGreaterThan(0)
    // And an unknown spelling is refused rather than clamped to standard.
    expect(core.setGravity('none')).toBe(false)
  })

  /**
   * T22.03 — the mirror predicts **momentum that never damps**.
   *
   * A free fall shows that gravity is off; it cannot show that nothing damps,
   * because a body at zero velocity has nothing to lose. This drives a sideways
   * drift through `setPlayerState` — the call `prediction.ts::reconcile` makes —
   * and then holds no buttons at all, so the only thing acting on `vel.x` is
   * `apply_horizontal`'s drag.
   *
   * **What this would report if `setGravity` reached only the gravity term and
   * not the damping:** the two drifts would be equal, because `AIR_DRAG` would
   * still be bleeding the space run, and the `toBeGreaterThan` fails. The
   * `'standard'` arm is the control: without it, "the space run drifted 100 px"
   * is satisfied by any build that moves a body at all.
   *
   * Pinned to nothing written here — the expected distance comes from the
   * velocity fed in and `SIM_DT` read out of Rust.
   */
  /**
   * T22.11C / R49: **the rocks are installed over the wire, and the body is
   * pulled by them.**
   *
   * Red before green: before `setAsteroids` existed a networked core's
   * `meta.asteroids` was empty — not stale, empty — because `GameCore::new()`
   * generates on the standard generator. The two arms below are exactly that
   * difference, on one map, at one point, with the same start state.
   *
   * The field's direction is asked of Rust (`fieldAccelAt`, which goes through
   * `attractors::env_at`) rather than computed here: summing the falloff in
   * TypeScript would be the second spelling R11 exists to prevent, and it would
   * agree with itself whatever the core did.
   */
  it('installs the wire’s rocks and lets the field pull a body (T22.11C)', () => {
    expect(core.generateForGravity(4242n, MapScale.Small, MapGenerator.V2, 'space')).toBe(true)
    // A copy, because `setAsteroids([])` below invalidates the cached meta and
    // this list is what a `map_init` would have carried.
    const rocks = core.meta.asteroids.map((a) => ({ x: a.x, y: a.y, r: a.r, level: a.level }))
    expect(rocks.length).toBeGreaterThan(0)

    // The deepest rock's neighbourhood, offset by two body heights so the point
    // is outside the rock and still well inside its reach.
    const deepest = rocks.reduce((best, a) => (a.level > best.level ? a : best), rocks[0]!)
    const start = { x: deepest.x + deepest.r + C().PLAYER_H * 2, y: deepest.y }
    const field = core.fieldAccelAt(start.x, start.y)
    const mag = Math.hypot(field[0]!, field[1]!)
    expect(mag).toBeGreaterThan(0)

    const drift = (): { x: number; y: number } => {
      core.removePlayer(9)
      core.addPlayer(9, start.x, start.y)
      core.setPlayerState(9, {
        x: start.x,
        y: start.y,
        vx: 0,
        vy: 0,
        grounded: false,
        fuel: C().JETPACK_MAX_FUEL,
        moveState: 1,
        health: C().BASE_HEALTH,
        alive: true,
        moveMods: 0,
      })
      // No buttons: in space nothing but the field touches an ungrounded body,
      // so every pixel of the move below is the wells.
      for (let seq = 0; seq < 30; seq++) core.applyInput(9, seq, 0, 0, C().SIM_DT)
      const p = core.playerState(9)!
      return { x: p.x - start.x, y: p.y - start.y }
    }

    // **The control frame: the rocks taken away.** Asserted on the effect —
    // the table read back through `meta`, and the field read back through Rust —
    // rather than on having made the call.
    core.setAsteroids([])
    expect(core.meta.asteroids).toEqual([])
    expect(Array.from(core.fieldAccelAt(start.x, start.y))).toEqual([0, 0])
    const still = drift()
    expect(Math.hypot(still.x, still.y)).toBeLessThan(1)

    // And put them back, which is what `applyMapInit` does.
    core.setAsteroids(rocks)
    expect(core.meta.asteroids).toEqual(rocks)
    const moved = drift()
    expect(Math.hypot(moved.x, moved.y)).toBeGreaterThan(C().PLAYER_H)
    // It went the way the field pointed, which is what attributes the move to
    // the wells rather than to anything else a tick does.
    expect(moved.x * field[0]! + moved.y * field[1]!).toBeGreaterThan(0)
  })

  it('predicts undamped momentum in space (T22.03)', () => {
    const VX = 240
    const TICKS = 30
    const drift = (mode: string): number => {
      // Generated under standard gravity and switched after, so this measures
      // damping with no attractor field in the way — see the `fall` helper in
      // the test above for why that is what those two calls do.
      expect(core.setGravity('standard')).toBe(true)
      core.generate(4242n, MapScale.Small)
      expect(core.setGravity(mode)).toBe(true)
      core.addPlayer(12, 500, 300)
      // Airborne, drifting right, full tank, alive, no move mods.
      core.setPlayerState(12, {
        x: 500,
        y: 300,
        vx: VX,
        vy: 0,
        grounded: false,
        fuel: C().JETPACK_MAX_FUEL,
        moveState: 1,
        health: C().BASE_HEALTH,
        alive: true,
        moveMods: 0,
      })
      const x0 = core.playerState(12)!.x
      for (let seq = 0; seq < TICKS; seq++) core.applyInput(12, seq, 0, 0, C().SIM_DT)
      const moved = core.playerState(12)!.x - x0
      core.removePlayer(12)
      return moved
    }

    const space = drift('space')
    const standard = drift('standard')
    // Undamped: the distance is the velocity times the time, to within the
    // sub-step accumulation.
    expect(space).toBeCloseTo(VX * C().SIM_DT * TICKS, 1)
    // And the control damped, so the equality above is about this mode.
    expect(standard).toBeGreaterThan(0)
    expect(space).toBeGreaterThan(standard)
  })
})
