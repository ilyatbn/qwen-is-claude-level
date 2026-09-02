/**
 * Typed wrapper over the `game-wasm` bindings.
 *
 * Two things here are load-bearing:
 *
 * 1. **The mask view is re-acquired on demand.** A `Uint8Array` over WASM memory is
 *    detached whenever the heap grows, and a detached view reads as zeros — a map
 *    that renders blank with no error anywhere. `maskView()` checks the buffer
 *    identity every call so no caller has to remember.
 * 2. **Constants come from Rust.** Nothing in the client re-declares a tunable; they
 *    are read across the boundary once, so there is exactly one source of truth.
 */

import { Attract } from './attract'
import init, {
  GameCore,
  constants_json,
  core_darkness_at,
  core_fov_radius,
  quantize_angle,
  dequantize_angle,
  AttractCore,
} from './pkg/game_wasm.js'
import wasmUrl from './pkg/game_wasm_bg.wasm?url'

export const enum MapScale {
  Small = 0,
  Medium = 1,
  Large = 2,
}

/**
 * Which terrain generator builds a locally generated map. Mirrors
 * `game_core::constants::MapGenerator`; the server's `MAP_GENERATOR` picks the
 * same two for a networked round.
 */
export const enum MapGenerator {
  /** The warped-noise field with a cave network carved through it. */
  V1 = 0,
  /** The height-profile landscape: ground, islands, and a cave or two. */
  V2 = 1,
}

export interface Point {
  x: number
  y: number
}

export interface BuriedSlot {
  id: number
  pos: Point
  revealed: boolean
}

/**
 * An indestructible standing spot (§C5).
 *
 * `pos` is a **feet line**, as every surface point in this project is. The rect
 * the terrain protects is below it — see `TeleportPad::rect` in `map/meta.rs`;
 * the client never needs that rect, only somewhere to draw the ring.
 */
export interface TeleportPad {
  id: number
  pos: Point
}

export interface Decoration {
  kind: number
  pos: Point
  flip: boolean
  scale_tier: number
}

export interface MapMeta {
  seed: number
  requested_seed: number
  attempts: number
  used_safe_preset: boolean
  scale: string
  theme: number
  spawn_points: Point[]
  teleport_pads: TeleportPad[]
  surface_points: Point[]
  buried_slots: BuriedSlot[]
  decorations: Decoration[]
  wind: number
  traversable_fraction: number
}

export interface InventoryView {
  slots: Array<{ item: number; count: number; key: string } | null>
  selected: number
  health: number
  alive: boolean
  score: number
}

export interface FireEvent {
  rejected?: string
  weapon?: number
  hitscan?: Array<{ x0: number; y0: number; x1: number; y1: number; hit: string }>
  projectile?: { id: number; weapon: number; key: string; x: number; y: number }
}

export interface CombatEvent {
  explosion?: {
    id: number
    x: number
    y: number
    r: number
    hits: Array<{ id: number; damage: number; health_before: number; health_after: number }>
  }
}

export interface LiveProjectile {
  id: number
  key: string
  x: number
  y: number
}

export interface PlayerState {
  x: number
  y: number
  vx: number
  vy: number
  grounded: boolean
  fuel: number
  /** 0 grounded, 1 airborne, 2 jetpack */
  moveState: number
}

/**
 * Every tunable the client needs, read from `game-core`'s `constants.rs`.
 *
 * The client must never re-declare one of these. A literal in TypeScript that
 * shadows a Rust constant is exactly the drift this architecture exists to
 * prevent — see `docs/01-architecture.md`.
 */
export interface Constants {
  MINE_ARM_TIME: number
  TOMBSTONE_W: number
  TOMBSTONE_H: number
  MAX_TOMBSTONES: number
  VIEWPORT_W: number
  VIEWPORT_H: number
  CHUNK_SIZE: number
  INPUT_REDUNDANCY: number
  MAX_INPUT_QUEUE: number
  SNAPSHOT_PLAYER_BYTES: number
  SNAPSHOT_HEADER_BYTES: number
  SNAPSHOT_FOOTER_BYTES: number
  SNAPSHOT_HZ: number
  INTERP_DELAY_MS: number
  RECONCILE_EPSILON_PX: number
  COARSE_CELL: number
  /** Indestructible band at the bottom. **Zero since §C15** — see constants.rs. */
  BEDROCK_H: number
  /** The destructible floor generation lays at the bottom (§C15). */
  FLOOR_CRUST: number
  WALL_W: number
  SKY_MARGIN: number
  PLAYER_W: number
  PLAYER_H: number
  WALK_SPEED: number
  MAX_FALL_SPEED: number
  EDGE_BAND_PX: number
  CHUNK_REBAKE_BUDGET: number
  PARALLAX_FACTOR: number
  CAMERA_LERP: number
  CAMERA_ZOOM: number
  CAMERA_DEADZONE_W: number
  CAMERA_DEADZONE_H: number
  CAMERA_LOOKAHEAD: number
  CAMERA_LOOKAHEAD_LERP: number
  SIM_DT: number
  SIM_HZ: number
  AIM_RADIUS: number
  JETPACK_MAX_FUEL: number
  JETPACK_DRAIN: number
  JETPACK_REFILL: number
  JETPACK_REFILL_DELAY: number
  MINIMAP_W: number
  MINIMAP_H: number
  MINIMAP_ALPHA: number
  MINIMAP_REVEAL_R: number
  AIM_DEADZONE: number
  BTN_LEFT: number
  BTN_RIGHT: number
  BTN_UP: number
  BTN_DOWN: number
  BTN_JUMP: number
  BTN_FIRE: number
  BTN_FLASHLIGHT: number
  SUN_RADIUS: number
  MOON_RADIUS: number
  SKY_BODY_ARC_H: number
  SKY_BODY_PARALLAX: number
  STAR_COUNT: number
  STAR_FADE_START: number
  NIGHT_DARKNESS: number
  DAY_DURATION: number
  NIGHT_DURATION: number
  CYCLE_TRANSITION: number
  FOV_DAY: number
  FOV_NIGHT: number
  FOV_FOG_MULT: number
  FOV_HEALTH_MIN_MULT: number
  FOV_EDGE_SOFTNESS: number
  FLASHLIGHT_RANGE: number
  FLASHLIGHT_CONE_DEG: number
  FLASHLIGHT_AMBIENT_MULT: number
  BASE_HEALTH: number
  /** Seconds an environmental death still credits a recent attacker. */
  ASSIST_WINDOW: number
  RESPAWN_DELAY: number
  PICKUP_RADIUS: number
  FIRE_MOVE_MAX_SPEED: number
  JETPACK_MAX_SPEED: number
  LAVA_BURN_RADIUS: number
  TOXIC_POISON_DURATION: number
  TOXIC_POISON_DPS: number
  TOXIC_DROP_CARVE_R: number
  HEALTH_CAP: number
  SMG_MUZZLE_SPEED: number
  BEAM_LIFETIME: number
  BULLET_LENGTH: number
  BULLET_WIDTH: number
  TRACER_WIDTH: number
  PROJECTILE_TRAIL_LEN: number
  MUZZLE_OFFSET: number
  BAZOOKA_BLAST_RADIUS: number
  BAZOOKA_COOLDOWN: number
  BAZOOKA_AMMO: number
  GRENADE_BLAST_RADIUS: number
  SMG_BLAST_RADIUS: number
  SMG_RANGE: number
  SMG_COOLDOWN: number
  /** Whether the renderer paints interior air with dark rock at all. */
  /** Registry ids for the two bird rewards (§C16). */
  ITEM_MEDKIT: number
  ITEM_BATTERY_PACK: number
  /** §C16 — the bird hit box the renderer draws to. */
  BIRD_W: number
  BIRD_H: number
  BIRD_MAX: number
  BIRD_INTERVAL: number
  BIRD_SPEED: number
  BIRD_METAL_HEALTH: number
  CAVE_BACKDROP: boolean
  MOUNTAIN_LAYERS: number
  /** Scroll factor per layer, far to near. Both below `PARALLAX_FACTOR`. */
  MOUNTAIN_PARALLAX: number[]
  MOUNTAIN_HEIGHT_FRAC: number[]
  MOUNTAIN_BASE_FRAC: number
  MOUNTAIN_HAZE: number[]
  MOUNTAIN_CELLS: number
  MOUNTAIN_OCTAVES: number
  CLOUD_COUNT: number
  CLOUD_DRIFT: number
  CLOUD_PARALLAX: number
  CLOUD_TEX_W: number
  CLOUD_TEX_H: number
  CLOUD_SCALE_MIN: number
  CLOUD_SCALE_MAX: number
  CLOUD_BAND_TOP: number
  CLOUD_BAND_BOTTOM: number
  CLOUD_ALPHA: number
  CLOUD_SPEED_SPREAD: number
  CLOUD_BRIGHT_MIN: number
  CLOUD_BRIGHT_MAX: number
  CLOUD_ALPHA_MIN: number
  CLOUD_ALPHA_MAX: number
  CLOUD_SKY_MIX: number
  CLOUD_ALPHA_FLOOR: number
  RIDGE_TEX_W: number
  MOUNTAIN_INK: number
  BACKDROP_RAYS: number
  BACKDROP_RAY_LEN: number
  BACKDROP_MIN_HITS: number
  BACKDROP_MIN_UP: number
  BACKDROP_MAX_DIST_TO_SOLID: number
  BACKDROP_MIN_ROOF: number
  TIMER_WARN_SECONDS: number
  /** §C5 — the pads the client draws, and the timings it fills the ring over. */
  TELEPORT_PADS: number
  PAD_W: number
  PAD_H: number
  PAD_TOUCH_SLACK: number
  TELEPORT_CHARGE: number
  TELEPORT_COOLDOWN: number
  TELEPORT_ARM_DISTANCE: number
  BATTERY_MAX: number
  MAX_HEALS: number
  QUICK_SLOTS: number
  BACKPACK_SLOTS: number
  INVENTORY_SLOTS: number
  MEDKIT_HEAL: number
  MAX_BATTERIES: number
  BATTERY_PACK_AMOUNT: number
  SHIELD_DRAIN: number
  SHIELD_DURATION: number
}

/**
 * Angle ↔ wire word, from `game-core`. The server dequantises with the same code,
 * so a TypeScript reimplementation that rounds differently would put every shot a
 * fraction off its aim.
 */
export function quantizeAngle(a: number): number {
  return quantize_angle(a)
}

export function dequantizeAngle(q: number): number {
  return dequantize_angle(q)
}

/** Populated by `Core.init()`. Throws if read before then, rather than silently
 *  handing out zeros. */
let wasmMemory: WebAssembly.Memory | null = null
let constantsCache: Constants | null = null

export function C(): Constants {
  if (!constantsCache) {
    throw new Error('constants read before Core.init() — call it first')
  }
  return constantsCache
}

/**
 * The Rust FoV formula and darkness curve, for cross-checking the TypeScript
 * copies in `lightmap-math.ts` and `sky-math.ts`. Not the render path — see the
 * doc comments on the Rust side.
 */
export const coreFovRadius = core_fov_radius
export const coreDarknessAt = core_darkness_at

export interface WeatherState {
  active: { id: number; kind: 'toxic' | 'meteor' | 'lava' | 'fog'; phase: string }[]
  vents: { x: number; y: number; lean: number; jetting: boolean; burning: boolean }[]
  /** 0..1 */
  fog: number
}

export class Core {
  private readonly inner: GameCore
  private readonly memory: WebAssembly.Memory
  private view: Uint8Array | null = null
  private metaCache: MapMeta | null = null

  private constructor(inner: GameCore, memory: WebAssembly.Memory) {
    this.inner = inner
    this.memory = memory
  }

  /**
   * `source` overrides where the wasm binary comes from. The browser uses the
   * bundled URL; node tests pass the bytes directly, because `fetch` of a
   * file:// URL is not available there.
   */
  static async init(source?: BufferSource | WebAssembly.Module): Promise<Core> {
    const wasm = await init({ module_or_path: source ?? wasmUrl })
    constantsCache = JSON.parse(constants_json()) as Constants
    wasmMemory = wasm.memory
    return new Core(new GameCore(), wasm.memory)
  }

  /**
   * A self-contained round of bots fighting: a real `World` rather than the
   * prediction subset.
   *
   * **Dormant since T18.01 — this has no caller.** It was built for the title
   * screen under §B3, on the reasoning that a live round behind the menu is a
   * smoke test of the simulation anyone can see. `docs/74` §E9 overrides that:
   * the attract sim ran at a third of real time, un-gated its warmup at about
   * thirty seconds of wall clock, and rebuilt its world from inside `update()`
   * — where a throw removed the DOM *and* stopped Phaser's frame loop, taking
   * the Start button with the picture. A background that runs the game can
   * always break the menu.
   *
   * Kept rather than deleted, because §B3's argument is still a good one and the
   * sandbox is where it belongs if anyone wants it back. `Attract`
   * (`core/attract.ts`) and the Rust `AttractCore` are dormant for the same
   * reason and have no other caller either.
   */
  static attract(
    seed: bigint,
    scale: MapScale,
    bots: number,
    skill: number,
  ): Attract {
    if (!wasmMemory) {
      throw new Error('Core.init() must run before Core.attract()')
    }
    const lo = Number(seed & 0xffffffffn) >>> 0
    const hi = Number((seed >> 32n) & 0xffffffffn) >>> 0
    return new Attract(new AttractCore(lo, hi, scale, bots, skill), wasmMemory)
  }

  generate(seed: bigint, scale: MapScale): void {
    const lo = Number(seed & 0xffffffffn) >>> 0
    const hi = Number((seed >> 32n) & 0xffffffffn) >>> 0
    this.inner.generate(lo, hi, scale)
    this.invalidate()
  }

  /** `generate` against a named generator. Local only — see the WASM doc. */
  generateWith(seed: bigint, scale: MapScale, generator: MapGenerator): void {
    const lo = Number(seed & 0xffffffffn) >>> 0
    const hi = Number((seed >> 32n) & 0xffffffffn) >>> 0
    this.inner.generate_with(lo, hi, scale, generator)
    this.invalidate()
  }

  loadMask(w: number, h: number, rle: Uint8Array): boolean {
    const ok = this.inner.load_mask(w, h, rle)
    this.invalidate()
    return ok
  }

  /**
   * Install the round's teleport pads (§C5).
   *
   * **Required for mask agreement**, not for drawing. Pads are indestructible, so
   * `carve_circle` refuses pixels inside them — and this core runs the same
   * `carve_circle` the server does. A client that skips this digs holes the
   * server refused and its mask diverges by a pad-shaped patch per carve, which
   * is exactly what `two_clients_agree_on_the_mask_after_a_hundred_carves`
   * reported the moment pads landed.
   */
  setTeleportPads(pads: readonly { x: number; y: number }[]): void {
    const xs = new Int32Array(pads.map((p) => p.x))
    const ys = new Int32Array(pads.map((p) => p.y))
    this.inner.set_teleport_pads(xs, ys)
    this.invalidate()
  }

  /** Where this core thinks the pads are, as `[x0, y0, x1, y1, …]`. */
  teleportPads(): Int32Array {
    return this.inner.teleport_pads()
  }

  private invalidate(): void {
    this.view = null
    this.metaCache = null
  }

  get width(): number {
    return this.inner.width()
  }

  get height(): number {
    return this.inner.height()
  }

  get chunksX(): number {
    return this.inner.chunks_x()
  }

  get chunksY(): number {
    return this.inner.chunks_y()
  }

  get meta(): MapMeta {
    if (!this.metaCache) {
      this.metaCache = JSON.parse(this.inner.meta_json()) as MapMeta
    }
    return this.metaCache
  }

  /**
   * A live view over the mask in WASM memory.
   *
   * Re-acquired whenever the heap has grown. `byteLength === 0` catches an already
   * detached view; comparing `buffer` against `memory.buffer` catches the case
   * where the buffer was swapped but this view has not been touched since.
   */
  maskView(): Uint8Array {
    const v = this.view
    if (v === null || v.byteLength === 0 || v.buffer !== this.memory.buffer) {
      this.view = new Uint8Array(
        this.memory.buffer,
        this.inner.mask_ptr(),
        this.inner.mask_byte_len(),
      )
    }
    return this.view as Uint8Array
  }

  /**
   * Reads the view directly rather than crossing the boundary per pixel: a WASM
   * call per pixel over a 65k-pixel chunk would be unusably slow.
   *
   * Bit order matches `Mask` exactly: `bit = y * w + x`, byte `bit >> 3`,
   * `(byte >> (bit & 7)) & 1`. Rust packs the mask as `u64` words while this reads
   * bytes; on little-endian — every platform that runs a browser — the two agree.
   */
  solidAt(x: number, y: number): boolean {
    const w = this.width
    if (x < 0 || y < 0 || x >= w || y >= this.height) return false
    const bit = y * w + x
    const view = this.maskView()
    return ((view[bit >> 3]! >> (bit & 7)) & 1) !== 0
  }

  carve(cx: number, cy: number, r: number): void {
    this.inner.carve(cx, cy, r)
  }

  /**
   * A swept-circle carve. Distinct from `carve` on purpose: replaying a lava
   * channel as a circle gives a different mask, and a client whose mask differs
   * from the server's is shot through walls it can still see.
   */
  carveCapsule(x0: number, y0: number, x1: number, y1: number, r: number): void {
    this.inner.carve_capsule(x0, y0, x1, y1, r)
  }

  takeDirtyChunks(): Uint32Array {
    return this.inner.take_dirty_chunks()
  }

  addPlayer(id: number, x: number, y: number): void {
    this.inner.add_player(id, x, y)
  }

  removePlayer(id: number): void {
    this.inner.remove_player(id)
  }

  applyInput(id: number, seq: number, buttons: number, aim: number, dt: number): void {
    this.inner.apply_input(id, seq, buttons, aim, dt)
  }

  setPlayerState(id: number, s: PlayerState): void {
    this.inner.set_player_state(id, s.x, s.y, s.vx, s.vy, s.grounded, s.fuel)
  }

  playerState(id: number): PlayerState | null {
    const a = this.inner.player_state(id)
    if (a.length < 7) return null
    return {
      x: a[0]!,
      y: a[1]!,
      vx: a[2]!,
      vy: a[3]!,
      grounded: a[4]! !== 0,
      fuel: a[5]!,
      moveState: a[6]!,
    }
  }

  give(id: number, item: number, count: number): void {
    this.inner.give(id, item, count)
  }

  selectSlot(id: number, slot: number): void {
    this.inner.select_slot(id, slot)
  }

  /**
   * The item registry as JSON — id, key, name, sprite, max stack.
   *
   * The wire carries only a numeric `item_id`, so without this the client cannot
   * turn a world item into a sprite. `ItemDef.sprite` has existed since T4.01 and
   * was unreadable here until now.
   */
  itemRegistryJson(): string {
    return this.inner.item_registry_json()
  }

  inventory(id: number): InventoryView | null {
    return JSON.parse(this.inner.inventory_json(id)) as InventoryView | null
  }

  fire(id: number, now: number): FireEvent {
    return JSON.parse(this.inner.fire(id, now)) as FireEvent
  }

  /** Solid pixel count, for asserting an effect did or did not reshape the map. */
  countSolid(): number {
    return this.inner.count_solid()
  }

  /** Force a weather effect: 0 toxic, 1 meteor, 2 lava, 3 fog. */
  forceEffect(kind: 0 | 1 | 2 | 3, now: number): void {
    this.inner.force_effect(kind, now)
  }

  /** Advance the weather and return the hazards to draw. */
  weatherStep(now: number, dt: number): WeatherState {
    return JSON.parse(this.inner.weather_step(now, dt)) as WeatherState
  }

  combatStep(now: number, dt: number): CombatEvent[] {
    return JSON.parse(this.inner.combat_step(now, dt)) as CombatEvent[]
  }

  liveProjectiles(): LiveProjectile[] {
    return JSON.parse(this.inner.projectiles_json()) as LiveProjectile[]
  }

  maskHash(): Uint8Array {
    return this.inner.mask_hash()
  }

  maskRle(): Uint8Array {
    return this.inner.mask_rle()
  }
}
