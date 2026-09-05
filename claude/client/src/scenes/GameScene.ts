/**
 * The multiplayer scene: the one that turns `Connection`, `WorldMirror`,
 * `Predictor` and `RemoteInterpolator` into a game.
 *
 * What it does, in the order it does it (`docs/42-netcode-prediction.md`):
 *  - joins, waits for `welcome`, decodes `map_init`, builds chunks, sends `ready`
 *  - predicts the local body every frame at a fixed timestep, and reconciles it
 *    against each snapshot
 *  - renders every other player from the interpolation buffer, 100 ms in the
 *    past — never through `apply_input`, because there are no remote inputs
 *  - applies carves in `seq` order, buffering a gap and resyncing after 2 s
 */

import Phaser from 'phaser'
import { loadAssetManifest, runLoader } from '../render/assets'
import { DeathOverlay } from '../ui/deathOverlay'
import { TombstoneLayer } from '../render/tombstones'
import { BirdLayer } from '../render/birds'
import { padUnderfoot, type PadView } from '../render/pads'
import { atlasArt } from '../render/objects'
import type { MapObject } from '../net/codec'
import { C, Core, dequantizeAngle, strictConstants } from '../core'
import { asRecord, Connection, type Welcome } from '../net/connection'
import { parseLobbyState } from '../net/lobby'
import { WorldMirror, hex } from '../net/worldMirror'
import { WEAPON_KEYS } from '../render/ordnance-state'

/**
 * Weapon key to launch sound.
 *
 * By key, never by id: `WEAPON_KEYS` is pinned to the Rust registry so an
 * inserted weapon is a test failure rather than a re-sounded arsenal (§B16).
 * A weapon absent from this table makes no launch sound at all, which is the
 * honest state for something that has not been given one.
 */
const FIRE_CUE: Record<string, 'fire_bazooka' | 'fire_grenade' | 'fire_smg' | null> = {
  bazooka: 'fire_bazooka',
  grenade: 'fire_grenade',
  smoke: 'fire_grenade',
  molotov: 'fire_grenade',
  toxic_grenade: 'fire_grenade',
  airburst: 'fire_grenade',
  // §F1: the five guns fire projectiles now, and they get the gun sound that
  // used to be cued off the hitscan event they no longer emit.
  smg: 'fire_smg',
  pistol: 'fire_smg',
  revolver: 'fire_smg',
  deagle: 'fire_smg',
  machinegun: 'fire_smg',
  // **Silent on purpose, and said so rather than left absent.** Weather
  // ordnance arrives as `projectile_spawn` like everything else, and none of it
  // is *launched* by anyone — a meteor has no muzzle. `null` is the difference
  // between "decided to be quiet" and "nobody has looked at this yet", which is
  // what makes `unmappedFireCues` an assertable zero instead of a number that
  // counts the weather.
  meteor: null,
  meteor_fragment: null,
  toxic_drop: null,
}

// Those fourteen keys are **exactly** the weapons whose delivery is `Projectile`
// or `Bullet` in `defs.rs` — the only two that produce a `projectile_spawn`. The
// rest (melee, cone, placed, hitscan) can never reach this branch, so they have
// no entry and their absence is not a gap.
import { Predictor } from '../net/prediction'
import { ClockSync, RemoteInterpolator } from '../net/interpolation'
import { WorldView } from '../render/worldView'
import { DEPTH } from '../render/backdrop'
import { PlayerView } from '../render/playerView'
import { Crosshair, LocalInput } from '../input/localInput'
import { MAX_FRAME_DT, RepeatFire } from '../input/autoFire'
import { SkyLayer } from '../render/sky'
import { Lightmap, fovRadius, type LightSource } from '../render/lightmap'
import { OrdnanceFxLayer } from '../render/ordnanceFx'
import { hazardKind } from '../render/ordnanceFx-math'
import { cycleU, darknessAt } from '../render/sky-math'
import { formatClock, phaseBanner, rankScores, type Phase } from '../ui/scoreboard'
import { ResultsScreen } from '../ui/results'
import { phaseDeadline, secondsUntil } from '../ui/results-math'
import { fuelText, fuelTrend } from '../ui/jetpackReadout-math'
import { FLAG, flag } from '../net/codec'
import { FeelLayer, type FeelFrame } from '../ui/feelLayer'
import { Minimap } from '../ui/minimap'
import { Hud, type EffectPhase } from '../ui/hud'
import { Bars } from '../ui/bars'
import { InventoryPanel } from '../ui/inventory'
import { EscapeMenu, handleEscape } from '../ui/escapeMenu'
import { DebugMode } from '../ui/debugMode'
import { devSurface } from '../dev'
import { DebugOverlay } from '../render/debugOverlay'
import { energyBar, healthBar, inRefillDelay, jetpackBar } from '../ui/bars-math'
import { DebugHud } from '../ui/debugHud'
import { ITEM_ATLAS } from '../render/itemSprites'
import { artFor } from '../render/itemSprites-math'
import { traumaFromExplosion } from '../render/cameraRig-math'
import { Mixer } from '../audio/mixer'
import { loadAudio } from '../audio/sfx'
import { FogClock } from '../render/weather-math'
import { loadIdentity, readId } from '../ui/skins'

interface RemoteView {
  view: PlayerView
  lastSeen: number
}

/**
 * What actually happened during the round, accumulated as it arrives.
 *
 * T9.06 needs to assert on a four-minute round, and the things worth asserting
 * are **events**, not states: a weather telegraph lasts `EFFECT_TELEGRAPH` (3 s)
 * and a death is instantaneous. A check that polls `debug()` once a second sees
 * neither, and would pass on a round where nothing ever happened — so the scene
 * records them at the moment they land instead of the check sampling for them.
 *
 * Every field here is a count or a set of things seen. None of it feeds
 * rendering; removing it changes nothing the player sees.
 *
 * It is a **factory**, not a literal in the field list, because
 * `resetForNewRound` needs the same shape a fresh scene has. Two copies of a
 * sixty-line object literal would agree on the day they were written and
 * disagree on the first counter anybody adds.
 */
function freshObserved() {
  return {
    phases: new Set<string>(),
    dayPhases: new Set<string>(),
    /** effect id -> the lifecycle phases seen for it, so "ran start to finish" is checkable. */
    effects: new Map<number, { kind: string; phases: Set<string> }>(),
    hazards: 0,
    /** What the *server* said about mines, to assert against what is drawn. */
    minesPlaced: 0,
    minesEnded: 0,
    swings: 0,
    jets: 0,
    /**
     * `hitscan` events received — what the SERVER said about gunfire.
     *
     * There was no counter for this at all, at either end, which is the reason
     * §C23 could not be answered by reading the debug handle: `ordnance-visible`
     * fired a bazooka and never once fired a gun, so "you must be able to see
     * what you fired" was tested for one of the two delivery kinds.
     */
    hitscans: 0,
    /**
     * `projectile_spawn` events received — a **cumulative** count.
     *
     * `projectilesLive` is the mirror's current size, and a live count is the
     * wrong instrument for "did a throw happen": a molotov detonates on contact,
     * so its whole life can fall between two polls and the check then reports an
     * empty sky about a throw that plainly occurred. That is §B25's lesson in the
     * other direction — a count that misses what has already gone. This only ever
     * goes up, so an assertion on it cannot be raced.
     */
    projectileSpawns: 0,
    /**
     * `projectile_spawn` events whose weapon is the flame (§F10.2).
     *
     * **The replacement for `jets`**, which counted `cone` events from a
     * delivery that no longer exists. Both are the server's word rather than the
     * client's; what is *drawn* is T19.13's number, and keeping them separate is
     * how "the server made fire and nothing drew it" stays visible (§A39).
     */
    flamesSpawned: 0,
    /**
     * Spawns whose weapon has **no entry** in `FIRE_CUE` — not the ones entered
     * as deliberately silent.
     *
     * Counted rather than defaulted: the previous code played the bazooka for
     * anything it did not recognise, which is why every grenade in the game
     * launched with a rocket's roar and nobody noticed for eight milestones. A
     * silent shot is visible in this number; a plausible wrong sound is not.
     *
     * **Assertable at zero**, which is the whole point: weather ordnance spawns
     * projectiles too and is silent by design, so counting that as a gap would
     * make this a number nobody could ever check.
     */
    unmappedFireCues: 0,
    /** Where the most recent hazard landed, so a screenshot can frame one. */
    lastHazard: null as { x: number; y: number } | null,
    deaths: [] as Array<{ victim: number; attacker: number | null; cause: string }>,
    respawns: 0,
    itemSpawns: 0,
    itemPickups: 0,
    darknessMin: 1,
    darknessMax: 0,
    /** Largest gap between the server's tick and the last one we applied. */
    maxTickLag: 0,
  }
}

export class GameScene extends Phaser.Scene {
  private core!: Core
  private conn!: Connection
  private mirror!: WorldMirror
  private predictor: Predictor | null = null
  private interp!: RemoteInterpolator
  private clock!: ClockSync

  private world: WorldView | null = null
  private sky!: SkyLayer
  /** The map seed from `welcome`, for §C14's seeded skyline. */
  private mapSeed = 0
  /**
   * The **round's** seed, as `welcome` sent it.
   *
   * Distinct from `core.meta.seed`, which is this client's *local* core — and in
   * a networked round that core never generates the map, it is handed the mask
   * through `map_init`. So `core.meta.seed` is a constant unrelated to the round,
   * and `e2e-two-clients` was comparing it between two clients: `x !== x`,
   * sitting directly above the real agreement check and reading like a second
   * independent one.
   */
  private roundSeed = ''
  private lightmap!: Lightmap
  private fx!: OrdnanceFxLayer
  /** e2e only: point the camera here instead of at the player. */
  private watchPoint: { x: number; y: number } | null = null
  private localView: PlayerView | null = null
  private remotes = new Map<number, RemoteView>()
  private localInput!: LocalInput
  private crosshair!: Crosshair
  private hud!: HTMLDivElement
  /** §C8: the round timer and the event banner. Its own element tree. */
  private topHud: Hud | null = null
  /** §C8: the bottom-left health / energy / jetpack cluster. */
  private bars: Bars | null = null
  /** §C10: the quick bar, and the backpack behind right-click. */
  private inventory: InventoryPanel | null = null
  /** §C13: Resume / Options / Quit, over a round that keeps running. */
  private escapeMenu: EscapeMenu | null = null
  /** §C12: `F1` / `?debug=1`. Off by default, and it owns the T3.11 overlays. */
  private debugMode: DebugMode | null = null
  private overlay: DebugOverlay | null = null
  /** Energy pool, straight from the snapshot (§B5). */
  private battery = 0
  /** §C9's counters, straight from the snapshot. Not inventory. */
  private heals = 0
  private batteries = 0
  /** Whether the server says damage against me is being reduced (bit 3). */
  private shieldOn = false
  /** §E13: is toxic rain still working on me? Snapshot flag, never predicted. */
  private poisoned = false
  /**
   * Is a flashlight in my bag? Snapshot bit 4 (§T20.07).
   *
   * The server derives it from the inventory, so this is *carrying one* and not a
   * toggle — there is no toggle any more. Read like `shieldOn` and `poisoned`
   * above: a snapshot boolean the client never predicts, because the item can be
   * picked up or dropped between two frames and a locally guessed answer would
   * flicker the whole field of view.
   */
  private hasFlashlight = false
  private jetReadout: HTMLDivElement | null = null
  /** The private room's join code, once the server has told us (§B9). */
  private joinCode: string | null = null
  private codeBanner: HTMLElement | null = null
  private feel!: FeelLayer
  private minimap: Minimap | null = null
  private debugHud!: DebugHud
  /** Silent until `audio.json` loads; `docs/50` §8 — no assets is a supported state. */
  private audio = new Mixer()
  private unlockAudio: () => void = () => {}
  /** Footstep pacing and edge detection for land/jetpack cues. */
  private stepAcc = 0
  private wasGrounded = true
  private wasJetting = false
  private serverPos: { x: number; y: number } | null = null
  private lastRtt = 0
  private invOpen = false
  private scoreboardOpen = false
  private selectedSlot = 0
  /**
   * §F3's hold-to-repeat. Repeats only — the first shot of a press is still
   * `pointerdown`'s, so a click pressed and released between two frames is never
   * lost.
   */
  private readonly repeatFire = new RepeatFire()
  /**
   * The whole inventory, quick bar then backpack (§C10).
   *
   * Sized from the constant on the first `inventory` event; the initial length
   * only has to be non-empty, because every read is bounds-checked.
   */
  private slots: Array<{ key: string; count: number } | null> = []
  /** Set from `BASE_HEALTH` in `resetForNewRound`; 0 until the scene starts. */
  private health = 0
  private rttSamples = 0
  private rttAcc = 0

  private me = -1
  /** FoV multiplier from the server: fog times the smoke I am standing in. */
  private vision = 1
  /**
   * Which heavy fog is running, for §F9's veil.
   *
   * **A networked client has no `HeavyFog`** — the server owns the weather and
   * the snapshot carries only `vision`, which is fog *times the smoke you are
   * standing in*. Deriving the veil from `vision` would cast a full-screen fog
   * every time somebody threw a smoke grenade at you: a field that means two
   * things, used for the one it does not mean. The effect lifecycle already
   * arrives as events, and `fog.rs`'s header says the ramp is a pure timer *so
   * that* a client can walk it locally.
   *
   * In `weather-math` rather than inline here because the id rule inside it —
   * only *this* fog's `effect_end` clears it — is a branch vitest can reach
   * there and cannot reach in a scene that needs a canvas.
   */
  private readonly fog = new FogClock()
  private seq = 0
  private acc = 0
  private roundTime = 0
  /**
   * The last round time the **server** sent, never advanced locally.
   *
   * `roundTime` above is extrapolated every frame (`this.roundTime += dt`) so
   * the sky and the HUD move smoothly between 20 Hz snapshots. That makes it
   * useless as an answer to "is the server simulating": in a `Lobby`, where the
   * server's round time is frozen at 0 by design (§C18), it still drifts up by
   * one frame between snapshots. A browser check reading it concluded the lobby
   * was simulating, on the strength of 16 ms of client-side interpolation.
   */
  private serverRoundTime = 0
  private readonly death = new DeathOverlay()
  private tombstones!: TombstoneLayer
  private birds!: BirdLayer
  /** §C5's pads, as `map_init` gave them. The layer lives in `WorldView` (§C1). */
  private padViews: PadView[] = []
  /** §D6's scenery, straight off the wire — the count the index is checked against. */
  private mapObjects: MapObject[] = []
  /** The local player's pad charge, `0..1`, straight from the snapshot. */
  private teleportCharge = 0
  private results!: ResultsScreen
  /**
   * Input packets actually put on the wire. Counted at the send site, not at the
   * sample site: the point is what leaves, and a counter incremented where the
   * input is *built* would keep rising while the send was suppressed — reporting
   * intent rather than effect (§A15).
   */
  private inputsSent = 0
  /** The server's word on whether the local player is alive. */
  private meAlive = true
  private phase: Phase = 'lobby'
  private timeLeft = 0
  /**
   * Jetpack fuel, straight from the snapshot (§C26).
   *
   * The **server's** number, not the predictor's: the readout exists so the
   * refill curve can be read off the screen and checked against
   * `JETPACK_DRAIN`/`JETPACK_REFILL_DELAY`/`JETPACK_REFILL`, and a locally
   * predicted value would be showing the client's opinion of those constants
   * rather than the simulation's.
   */
  private fuel = 0
  /** Last fuel value rendered, so the trend arrow can be derived from two samples. */
  private fuelShown = 0
  /**
   * Round time at which the current phase ends (§C25).
   *
   * A **deadline**, not a remaining time, for the reason §B4 gives and T10.06
   * already applied to the death countdown: `round_state` is not broadcast at
   * all during `Ended` or `Warmup`, so a client that stores `time_left` renders
   * the same number for the whole of either. Recomputed against the server's
   * clock on every frame instead, so it falls without a local stopwatch.
   *
   * `timeLeft` below is kept because the lobby countdown genuinely *is*
   * re-broadcast on every displayed second, and `Playing` once a second.
   */
  private phaseEndsAt = 0
  /**
   * Who is in the room, as the two JSON events describe them.
   *
   * **`skinId` is required and not optional, and that is the guard.** There are
   * three writers — `lobby_state` merges, `player_join` clobbers, and `score`
   * reconstructs field by field from a two-field payload — written in three
   * different idioms, and `score` fires on every kill. A `skinId?: number` would
   * let all three compile while the third silently reset everybody to skin 0 on
   * the next death, which is this bug again one layer down. Required means the
   * compiler names the writer you forgot.
   */
  private scores = new Map<number, { name: string; score: number; deaths: number; skinId: number }>()
  private ready = false
  private lastServerTick = 0
  private serverDarkness = 0

  private observed = freshObserved()

  /**
   * Snapshots that arrived before the mask did.
   *
   * A mid-round join is normal (`docs/41` §4), and the server starts the 20 Hz
   * stream as soon as it seats you — so the first snapshots can easily land
   * while `map_init` is still decoding. Dropping them would leave the scene
   * blind until the next one; holding the newest means the first rendered frame
   * is already correct.
   */
  private pendingSnapshot: string | null = null

  constructor() {
    super('Game')
  }

  /**
   * Everything that must not outlive a round, in **one** list.
   *
   * **Phaser constructs a `Scene` once and runs `create()` every
   * `scene.start('Game')`.** Every field above with a `= value` initializer is
   * therefore initialised exactly once, for the life of the tab — so a player who
   * exits to the title and starts another match re-enters carrying the previous
   * round's `scores`, `phase`, `health`, `slots`, seeds and counters, and a
   * `world` and `ready` that describe a scene Phaser has already destroyed.
   *
   * That is T20.13's report in both of its halves:
   *
   *  - **"an empty screen"** — `update` guards on `this.ready && this.world &&
   *    this.predictor`, all three stale, so it drives a destroyed camera and
   *    throws. Phaser's `RequestAnimationFrame.step` calls its callback *before*
   *    re-arming itself, so **one** throw out of `update` ends the render loop for
   *    the life of the page. The socket keeps running on the event loop, so
   *    `debug().phase` reads `playing` over a frozen canvas — which is exactly why
   *    `rematch.mjs` asserts on pixels and not on phase. A refresh works because a
   *    refresh builds a new `Scene`.
   *  - **"they both appear on the list"** — `scores` is one of these fields, and
   *    the Tab scoreboard and the results screen are both fed from it. The
   *    `lobby_state` handler seeds rather than overwrites and only `dropRemote`
   *    ever removes an id, so the previous room's players, scores and deaths ride
   *    into the new match's roster.
   *
   * **Called from `create()` before its first `await`**, which is the load-bearing
   * detail: `create()` is `async` and Phaser does not await it, so `update()` runs
   * against these fields while `loadAssetManifest`/`runLoader` are still pending.
   * A reset after the awaits would leave the crashing window wide open. It is
   * called from `SHUTDOWN` as well, for the frame between the teardown and the
   * scene going inactive.
   *
   * **One list, two callers** — the teardown block below used to null four fields
   * by hand out of the thirty-odd that needed it, which is how this was missed.
   * `resetForNewRound.test.ts` fails if a new initialised field is added to the
   * class and named in neither this method nor its exemption list.
   */
  private resetForNewRound(): void {
    // `update`'s three guards, and the view they drive.
    this.ready = false
    this.world = null
    this.predictor = null
    this.localView = null

    // Who is in the room. `remotes` holds `PlayerView`s, so it is emptied rather
    // than dropped — the sprites belong to a scene that is going away.
    for (const r of this.remotes.values()) r.view.destroy()
    this.remotes.clear()
    this.scores.clear()
    this.me = -1

    // The round's identity and its clocks.
    this.mapSeed = 0
    this.roundSeed = ''
    this.phase = 'lobby'
    this.roundTime = 0
    this.serverRoundTime = 0
    this.timeLeft = 0
    this.phaseEndsAt = 0
    this.lastServerTick = 0
    this.serverDarkness = 0
    this.vision = 1
    this.pendingSnapshot = null
    this.observed = freshObserved()

    // The local body, as the snapshot will describe it. `BASE_HEALTH` rather
    // than a literal 100 — the field's own initializer is 0 for this reason.
    this.health = C().BASE_HEALTH
    this.meAlive = true
    this.battery = 0
    this.heals = 0
    this.batteries = 0
    this.shieldOn = false
    this.poisoned = false
    this.hasFlashlight = false
    this.fuel = 0
    this.fuelShown = 0
    this.teleportCharge = 0
    this.slots = []
    this.selectedSlot = 0
    this.serverPos = null
    this.watchPoint = null

    // Input bookkeeping and the send clock.
    this.seq = 0
    this.acc = 0
    this.stepAcc = 0
    this.inputsSent = 0
    this.lastRtt = 0
    this.rttSamples = 0
    this.rttAcc = 0
    this.wasGrounded = true
    this.wasJetting = false

    // UI that `create()` rebuilds and `SHUTDOWN` destroys. Nulled here too so the
    // two paths cannot disagree about which of them owns the field.
    this.topHud = null
    this.bars = null
    this.inventory = null
    this.escapeMenu = null
    this.debugMode = null
    this.overlay = null
    this.jetReadout = null
    this.minimap = null
    this.codeBanner = null
    this.joinCode = null
    this.invOpen = false
    this.scoreboardOpen = false

    // Map payload. Reassigned by `onMapInit`, but not before `update` can read
    // them, and last round's scenery is not this round's.
    this.padViews = []
    this.mapObjects = []

    // The two helpers that carry state of their own.
    this.fog.clear()
    this.death.cleared()
  }

  async create(): Promise<void> {
    // **First, and before the first `await`.** See `resetForNewRound`: Phaser
    // does not await `create`, so `update` runs against these fields while the
    // two loads below are still pending.
    this.resetForNewRound()

    await loadAssetManifest(this)
    await runLoader(this)

    this.core = this.registry.get('core') as Core
    const params = new URLSearchParams(location.search)

    this.mirror = new WorldMirror(this.core)
    this.interp = new RemoteInterpolator()
    this.clock = new ClockSync()
    // **Adopt the lobby's socket if there is one** (§E1).
    //
    // `MenuScene` opens the connection, sits in the lobby with it, and hands it
    // over when `map_init` arrives. Constructing a second one here would leave
    // the player seated in the lobby's room *and* joined somewhere else — and
    // because a plain `join` with no intent falls through to quick match, both
    // clients of one private lobby would land together in a brand new public
    // room. That reads correct from every roster: they can see each other. It is
    // two rooms on the server, and it is what `lobby.mjs` now measures.
    this.conn = (this.registry.get('liveConn') as Connection | undefined) ?? new Connection()

    this.sky = new SkyLayer(this)
    this.lightmap = new Lightmap(this)
    // §A39 #10: the server has narrated melee, cones, mines and hazards since
    // T11.05 and nothing subscribed. This is the other half.
    this.fx = new OrdnanceFxLayer(this, C().MINE_ARM_TIME)
    this.tombstones = new TombstoneLayer(this, C().TOMBSTONE_W, C().TOMBSTONE_H)
    // **Deliberately built here and not by `WorldView`**, unlike the pad and
    // item layers — a departure from §C1's layer-parity rule, so it is written
    // down rather than left to look like an oversight.
    //
    // `WorldView` owns layers it can drive from the map and the core. `BirdLayer`
    // is driven by `mirror.birds`, which is network state `WorldView` has no
    // handle on: birds are server-simulated and never derived locally. Moving it
    // there would mean handing `WorldView` the mirror, which is a much larger
    // coupling than the parity is worth. `PadLayer` reads map meta, which it can
    // already see, which is why that one does belong there.
    this.birds = new BirdLayer(this)
    this.results = new ResultsScreen({
      onPlayAgain: () => this.conn.sendVoteRestart(true),
      // Close the socket, do not merely change scene: the seat stays occupied
      // otherwise and the room never reaps (§B14's shape — quitting that does
      // not quit). A disconnect is how the server already frees a seat
      // (`docs/40` §6); the explicit `leave_room` of §B9 has no client method
      // yet and belongs with T14.06, which owns the quit path and `connection.ts`.
      onExit: () => {
        this.conn.close()
        this.scene.start('Title')
      },
    })
    this.localInput = new LocalInput(this)
    this.crosshair = new Crosshair(this, DEPTH.hud)
    this.buildHud()
    this.feel = new FeelLayer()
    this.debugHud = new DebugHud(this, C().PLAYER_W, C().PLAYER_H)
    this.input.keyboard?.on('keydown-F3', () => this.debugHud.toggle())
    this.input.keyboard?.on('keydown-M', () => this.minimap?.toggle())
    this.initAudio()

    this.mirror.onResyncNeeded = () => this.conn.requestResync()

    // Wire the handlers *before* connecting, so nothing that arrives during the
    // handshake is missed. `Connection.on` queues until the socket exists.
    // `map_init` and `snapshot` are base64 **strings**, not objects (§A27).
    // §E6: the lobby's roster, which is where names come from now that
    // `welcome` no longer carries them. Seeded rather than overwritten — a
    // player already carrying a score from a `score` event keeps it, because
    // `lobby_state` is authoritative about *who is here*, not about the game.
    this.conn.on('lobby_state', (raw) => {
      const st = parseLobbyState(asRecord(raw))
      for (const p of st.players) {
        const had = this.scores.get(p.seat)
        this.scores.set(p.seat, {
          name: p.name || `p${p.seat}`,
          score: had?.score ?? 0,
          deaths: had?.deaths ?? 0,
          // §B9's other half. This has been parsed into `LobbySeat.skinId` all
          // along and thrown away here, which is why everybody was a Recruit.
          skinId: p.skinId,
        })
      }
      this.syncLocalSkin()
    })
    this.conn.on('map_init', (p) => this.onMapInit(typeof p === 'string' ? p : ''))
    this.conn.on('snapshot', (p) => this.onSnapshot(typeof p === 'string' ? p : ''))
    this.conn.on('round_state', (raw) => {
      const p = asRecord(raw)
      this.phase = String(p['phase'] ?? 'lobby') as Phase
      this.timeLeft = Number(p['time_left'] ?? 0)
      const stateTick = Number(p['tick'] ?? this.lastServerTick)
      // A restart hands us a brand-new `World`, so the server's tick and round
      // time both go back to 0 (`Room::restart`). Every clock the client holds
      // is now an anchor to a world that is gone; the next snapshot re-anchors
      // them, but the deadline below is computed *before* it arrives.
      if (stateTick < this.lastServerTick) {
        this.lastServerTick = stateTick
        this.roundTime = 0
        this.serverRoundTime = 0
      }
      // §C25. Converted to a deadline on the server's own clock the moment the
      // phase is announced, because no further `round_state` is coming: the
      // `Ended` branch of `round.rs` emits none.
      this.phaseEndsAt = phaseDeadline(
        this.serverRoundTime,
        this.lastServerTick,
        stateTick,
        this.timeLeft,
        C().SIM_DT,
      )
      this.observed.phases.add(this.phase)
      // The big code is for inviting someone, which is a warmup activity. Once
      // the round is live it belongs in the strip, not across the screen.
      if (this.phase !== 'lobby' && this.phase !== 'warmup') this.hideJoinCodeBanner()
      // §E1: waiting happens in the **menu**, not here. A client only reaches
      // this scene once `map_init` has arrived, so a `lobby` phase seen from
      // inside a match is a round that ended and went back — not a place to
      // draw a waiting panel over a world the player is standing in, which is
      // what this used to do and is the defect T17.07 exists to fix.
    })
    // The payload is the point: `score` carries the whole table (`docs/40` §3),
    // and this handler used to discard it and merely re-render `this.scores` —
    // a map only ever written by `welcome` and `player_join`, both of which set
    // 0. So the scoreboard read 0 for everyone for the whole round no matter who
    // killed whom, and the HUD refreshed faithfully to show it. Found by the
    // first check that played a round and then reconciled the scoreboard against
    // the deaths it had watched (T9.06).
    this.conn.on('score', (raw) => {
      const rows = asRecord(raw)['scores']
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const r = asRecord(row)
          const id = Number(r['id'] ?? -1)
          if (id < 0) continue
          const prev = this.scores.get(id)
          this.scores.set(id, {
            name: prev?.name ?? `p${id}`,
            score: Number(r['score'] ?? 0),
            deaths: Number(r['deaths'] ?? 0),
            // **Carried, not defaulted.** A `score` event carries two fields and
            // is rebuilt field by field from them, so anything not carried
            // forward here is reset — and this one fires on every kill. The
            // comment above records the same shape costing the scoreboard a
            // whole round once (T9.06).
            skinId: prev?.skinId ?? 0,
          })
        }
      }
      this.refreshHud()
    })
    // Owner-only (docs/30 §6). The whole 8-slot array arrives on every change,
    // which removes a class of desync bug for 16 bytes.
    this.conn.on('inventory', (raw) => {
      const p = asRecord(raw)
      const arr = Array.isArray(p['slots']) ? (p['slots'] as unknown[]) : []
      // `INVENTORY_SLOTS`, not 8. §C10 took it to 24, and a fixed 8 here would
      // silently drop everything in the backpack — the server sends the whole
      // array (`docs/30` §6) and this decides how much of it is read.
      this.slots = Array.from({ length: C().INVENTORY_SLOTS }, (_, i) => {
        const sl = arr[i]
        if (!sl || typeof sl !== 'object') return null
        const r = sl as Record<string, unknown>
        return { key: String(r['key'] ?? '?'), count: Number(r['count'] ?? 0) }
      })
      const sel = p['selected']
      if (typeof sel === 'number') this.selectedSlot = sel
      this.inventory?.update(
        this.slots.map((sl, i) => ({
          slot: i,
          key: sl?.key ?? null,
          count: sl?.count ?? 0,
          // Asked of the layer that parsed the registry, not re-derived here.
          // The wire carries a registry key and art is keyed by `ItemDef.sprite`.
          sprite: this.world?.items.spriteForKey(sl?.key ?? null) ?? null,
        })),
        this.selectedSlot,
      )
      this.refreshHud()
    })
    // RTT, measured. `docs/42` §7 says it comes from socket.io's own ping/pong,
    // but the client library does not expose that measurement, so this was
    // hardcoded to 0 and the HUD reported "rtt 0ms" on every connection.
    this.conn.on('pong_rtt', (raw) => {
      const sent = Number(raw)
      if (Number.isFinite(sent)) {
        this.lastRtt = performance.now() - sent
        this.rttSamples++
      }
    })
    this.conn.on('player_join', (raw) => {
      const p = asRecord(raw)
      const id = Number(p['id'] ?? -1)
      if (id >= 0) {
        this.scores.set(id, {
          name: String(p['name'] ?? `p${id}`),
          score: 0,
          deaths: 0,
          // `session.rs` puts it here as `skin_id`; it was never read.
          skinId: Number(p['skin_id'] ?? 0) || 0,
        })
        this.syncLocalSkin()
      }
    })
    this.conn.on('player_leave', (raw) => this.dropRemote(Number(asRecord(raw)['id'] ?? -1)))
    // The join code is shown in the **lobby**, which is where a player is when
    // there is anyone to invite (§E1). `MenuScene` subscribes to `lobby_state`
    // and renders `code` from it; by the time this scene exists the match has
    // started and §E4 has closed the door, so a code on screen here would
    // invite people to a game they cannot join.
    for (const ev of ['carve', 'carve_capsule', 'item_spawn', 'crate_spawn', 'item_pickup',
      // `item_move` is where a falling crate goes (§C7). Written into the mirror
      // and left out of this list, it did exactly what the comment below warns
      // about — the crate hung in the sky and every unit test stayed green.
      'item_move',
      'item_despawn', 'projectile_spawn',
      // §C22/§C23. `projectile_spawn` carries where a projectile was created and
      // nothing carried where it went, so every rocket, grenade and meteor was
      // drawn frozen at its muzzle. Written into the mirror and left out of this
      // list it would do exactly what `item_move` did before it was added here:
      // nothing, with every unit test green.
      'projectile_move',
      // §C16. Same shape again: birds are server-simulated, so all three of
      // these have to be asked for or the sky stays empty with every test green.
      // `subscription.test.ts` caught this omission before the browser did.
      'bird_spawn', 'bird_move', 'bird_despawn',
      'projectile_despawn', 'mask_checksum',
      // §B8. The mirror handles these; this list is what actually subscribes,
      // and a handler with no subscription is the §A39 shape one layer down.
      'tombstone_spawn', 'tombstone_despawn']) {
      this.conn.on(ev, (raw) => {
        const p = asRecord(raw)
        this.mirror.applyEvent(ev, p, performance.now())
        if (ev === 'carve' || ev === 'carve_capsule') {
          this.minimap?.setTerrainDirty()
          // The terrain re-bake needs nothing here: `WorldView.update()` drains
          // the core's dirty set every frame, so it does not matter who carved.
          // Props do need the position, because "which decorations were standing
          // on that" is not recoverable from a chunk id.
          if (ev === 'carve') {
            this.world?.onCarve(Number(p['x'] ?? 0), Number(p['y'] ?? 0), Number(p['r'] ?? 0))
          } else {
            const x0 = Number(p['x0'] ?? 0)
            const y0 = Number(p['y0'] ?? 0)
            const x1 = Number(p['x1'] ?? 0)
            const y1 = Number(p['y1'] ?? 0)
            const r = Number(p['r'] ?? 0)
            this.world?.onCarve(
              (x0 + x1) / 2,
              (y0 + y1) / 2,
              Math.hypot(x1 - x0, y1 - y0) / 2 + r,
            )
          }
        }
        this.cueFor(ev, p)
      })
    }
    // Cue-only subscriptions. The world does not simulate these — they are
    // server-authoritative announcements (`docs/13` §7) — but they are exactly
    // the moments a player needs to hear.
    for (const ev of ['phase_change', 'effect_start', 'hazard_spawn', 'respawn']) {
      this.conn.on(ev, (raw) => this.cueFor(ev, asRecord(raw)))
    }
    // Record the effect lifecycle. `effect_start` carries the telegraph phase,
    // `effect_phase` the activation and `effect_end` the cleanup (`docs/13` §2),
    // so "an effect ran start to finish" is only answerable by keeping all three
    // against the same id — a single sample cannot distinguish a full run from
    // one that was cut short by the round ending.
    for (const ev of ['effect_start', 'effect_phase', 'effect_end']) {
      this.conn.on(ev, (raw) => {
        const p = asRecord(raw)
        const id = Number(p['id'] ?? -1)
        if (id < 0) return
        const rec = this.observed.effects.get(id) ?? { kind: '', phases: new Set<string>() }
        if (p['kind'] !== undefined) rec.kind = String(p['kind'])
        rec.phases.add(ev === 'effect_end' ? 'end' : String(p['phase'] ?? ev))
        this.observed.effects.set(id, rec)

        // §C8: and the banner, from the same three events.
        //
        // Here rather than in `cueFor`, which is subscribed to `effect_start`
        // alone — a banner fed from there would go up on the telegraph and never
        // come down. Grep the layer that owns the state, not the one that looks
        // like it should.
        if (ev === 'effect_start') {
          this.topHud?.startEffect(
            id,
            String(p['kind'] ?? ''),
            this.serverRoundTime,
            Number(p['duration'] ?? 0),
          )
          // §F9. The server calls `HeavyFog::new(now)` on the same tick it emits
          // this, so the round time carried by the last snapshot is the ramp's
          // origin to within one snapshot interval — and the ramp is `FOG_RAMP`
          // (2 s) long, so that lag is invisible.
          this.fog.start(id, rec.kind, this.serverRoundTime)
        } else if (ev === 'effect_phase') {
          this.topHud?.setEffectPhase(id, String(p['phase'] ?? 'active') as EffectPhase)
        } else {
          this.topHud?.endEffect(id)
          // Only *this* fog's end clears it — `FogClock` owns that rule.
          this.fog.end(id)
        }
      })
    }
    this.conn.on('hazard_spawn', (raw) => {
      this.observed.hazards++
      // Where, not just how many: a check that screenshots "the weather" needs to
      // know whether any of it is actually in frame (§A22).
      const p = asRecord(raw)
      this.observed.lastHazard = { x: Number(p['x'] ?? 0), y: Number(p['y'] ?? 0) }
      this.fx.addHazard(
        Number(p['id'] ?? -1),
        hazardKind(String(p['kind'] ?? '')),
        Number(p['x'] ?? 0),
        Number(p['y'] ?? 0),
        Number(p['r'] ?? 0),
        Number(p['duration'] ?? 0),
      )
    })
    this.conn.on('hazard_ended', (raw) => {
      this.fx.removeHazard(Number(asRecord(raw)['id'] ?? -1))
    })
    // The four §B6 events. Each was emitted by the server and consumed by
    // nothing; a swing you cannot see reads as damage from nowhere.
    this.conn.on('melee', (raw) => {
      const p = asRecord(raw)
      const x = Number(p['x'] ?? 0)
      const y = Number(p['y'] ?? 0)
      this.observed.swings++
      this.fx.addSwing(
        x,
        y,
        Number(p['aim'] ?? 0),
        Number(p['reach'] ?? 0),
        Number(p['arc'] ?? 0),
        Number(p['hits'] ?? 0),
      )
      this.audio.spatial(Number(p['hits'] ?? 0) > 0 ? 'hit' : 'fire_smg', x, y, this.ear(), 0.6)
    })
    this.conn.on('cone', (raw) => {
      const p = asRecord(raw)
      this.observed.jets++
      this.fx.addJet(
        Number(p['x'] ?? 0),
        Number(p['y'] ?? 0),
        Number(p['aim'] ?? 0),
        Number(p['range'] ?? 0),
        Number(p['arc'] ?? 0),
      )
    })
    this.conn.on('mine_placed', (raw) => {
      const p = asRecord(raw)
      this.observed.minesPlaced++
      this.fx.addMine(
        Number(p['id'] ?? -1),
        Number(p['owner'] ?? -1),
        Number(p['x'] ?? 0),
        Number(p['y'] ?? 0),
      )
    })
    this.conn.on('mine_ended', (raw) => {
      this.observed.minesEnded++
      // An id we never saw placed is a no-op: a mid-round joiner has exactly
      // that history, and throwing here would kill the scene.
      this.fx.removeMine(Number(asRecord(raw)['id'] ?? -1))
    })
    this.conn.on('phase_change', (raw) => {
      const p = asRecord(raw)
      this.observed.dayPhases.add(String(p['day_phase'] ?? p['phase'] ?? ''))
    })
    this.conn.on('respawn', (raw) => {
      this.observed.respawns++
      if (Number(asRecord(raw)['id'] ?? -1) === this.me) {
        this.meAlive = true
        this.death.cleared()
      }
    })
    this.conn.on('item_spawn', () => this.observed.itemSpawns++)
    this.conn.on('item_pickup', () => this.observed.itemPickups++)
    this.conn.on('explosion', (raw) => {
      const p = asRecord(raw)
      const x = Number(p['x'] ?? 0)
      const y = Number(p['y'] ?? 0)
      const r = Number(p['r'] ?? 0)
      this.world?.ordnance.addImpact(x, y, r, 'blast')
      // A meteor is a different, heavier sound from a rocket: the kind is on the
      // event already (`docs/40` §3), so nothing new has to be sent for it.
      const kind = String(p['kind'] ?? '')
      this.audio.spatial(kind === 'meteor' ? 'meteor' : 'explode', x, y, this.ear())
      // Distance-scaled trauma, from the layer that owns trauma (§A24).
      const me = this.predictor?.state
      const dist = me ? Math.hypot(me.x - x, me.y - y) : 0
      this.world?.rig.shake(traumaFromExplosion(dist, r))
    })
    // `damage` is scoped to victim and attacker only (docs/40 §3), so receiving
    // one already means it concerns me — no filtering needed here.
    this.conn.on('damage', (raw) => {
      const p = asRecord(raw)
      const victim = Number(p['victim'] ?? -1)
      const amount = Number(p['amount'] ?? 0)
      const at = this.predictor?.renderPos ?? { x: 0, y: 0 }
      const x = Number(p['x'] ?? at.x)
      const y = Number(p['y'] ?? at.y)
      if (victim === this.me) this.feel.damageTaken(x, y, amount)
      else this.feel.damageDealt(x, y, amount, false)
      this.audio.spatial('hit', x, y, this.ear())
    })
    this.conn.on('death', (raw) => {
      const p = asRecord(raw)
      const victim = Number(p['victim'] ?? -1)
      const attacker = p['attacker'] === null ? undefined : Number(p['attacker'])
      const cause = String(p['cause'] ?? 'player')
      this.observed.deaths.push({
        victim,
        attacker: attacker === undefined ? null : attacker,
        cause,
      })
      const nameOf = (id: number) => this.scores.get(id)?.name ?? `p${id}`
      this.feel.kill({
        victim: nameOf(victim),
        killer: attacker === undefined ? undefined : nameOf(attacker),
        cause:
          attacker === victim
            ? 'self'
            : cause === 'weather' || cause === 'void'
              ? (cause as 'weather' | 'void')
              : 'player',
        by: String(p['by'] ?? cause),
        involvesYou: victim === this.me || attacker === this.me,
      })
      this.audio.play('death', { volume: victim === this.me ? 1 : 0.5 })

      // §B4. The countdown targets the server's `respawn_at` and is recomputed
      // against the round time in every snapshot, so it cannot drift by the
      // latency of this very event.
      if (victim === this.me) {
        this.meAlive = false
        const respawnAt = Number(p['respawn_at'] ?? NaN)
        this.death.died({
          victim,
          attacker: attacker === undefined ? null : attacker,
          cause: String(p['by'] ?? cause),
          // If the server did not send one, fall back to its round time plus
          // the constant — still the server's clock, not a local stopwatch.
          respawnAt: Number.isFinite(respawnAt)
            ? respawnAt
            : Number(p['round_time'] ?? this.roundTime) + C().RESPAWN_DELAY,
        })
      }
    })
    this.conn.on('hitscan', (raw) => {
      const p = asRecord(raw)
      this.observed.hitscans += 1
      const x0 = Number(p['x0'] ?? 0)
      const y0 = Number(p['y0'] ?? 0)
      this.world?.ordnance.addTracer(x0, y0, Number(p['x1'] ?? 0), Number(p['y1'] ?? 0))
      this.audio.spatial('fire_smg', x0, y0, this.ear())
    })

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (p.rightButtonDown()) {
        this.toggleBackpack()
        return
      }
      this.conn.sendFire()
    })
    this.input.keyboard?.on('keydown-F', () => this.conn.sendFire())

    // Slot selection and item use. `Connection` has had `sendSelectSlot` and
    // `sendUseItem` since T6.08 and nothing called them, so in the real game a
    // medkit, a shield and the flashlight were all unusable — the flashlight
    // being the item the whole night design turns on (docs/30 §4, docs/14 §4).
    // `1`-`8`: the quick bar, and only the quick bar (§C10). Bounded by the
    // constant rather than by a literal 8 — the inventory is 24 slots now and the
    // two numbers are no longer the same.
    for (let i = 0; i < C().QUICK_SLOTS; i++) {
      const key = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT'][i] as string
      this.input.keyboard?.on(`keydown-${key}`, () => {
        this.selectedSlot = i
        this.conn.sendSelectSlot(i)
        this.audio.play('ui_click', { volume: 0.4 })
        this.refreshHud()
      })
    }
    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      const n = C().QUICK_SLOTS
      this.selectedSlot = (this.selectedSlot + (dy > 0 ? 1 : n - 1)) % n
      this.conn.sendSelectSlot(this.selectedSlot)
      this.refreshHud()
    })
    // §C11: `E` is quick-throw now. `use_item` on the selection moves to `G`.
    //
    // Not a doc'd binding — §C10 gives the quick bar `1`-`8` and the wheel and
    // says firing and using act on the selection, without naming a use key, and
    // §C11 takes `E`. Something still has to use a shield generator: heals and
    // batteries left the inventory with §C9, so `use_item` now has exactly one
    // remaining target and no key. `G` is next to it and unbound.
    this.input.keyboard?.on('keydown-G', () => this.conn.sendUseItem(this.selectedSlot))
    this.input.keyboard?.on('keydown-E', () => this.conn.sendQuickThrow())
    // §C9: `Q` heals, `R` charges. Both slotless and both refused server-side at
    // zero, so the client sends unconditionally — a client-side "do you have
    // one?" would be a second copy of a rule the server already owns, and the
    // two would disagree the first time a pickup was in flight.
    this.input.keyboard?.on('keydown-Q', () => this.conn.sendUseHeal())
    this.input.keyboard?.on('keydown-R', () => this.conn.sendUseBattery())
    this.input.keyboard?.on('keydown-TAB', (e: KeyboardEvent) => {
      e.preventDefault()
      this.scoreboardOpen = !this.scoreboardOpen
      this.refreshHud()
    })

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.conn.close()
      this.audio.stopAll()
      this.results?.destroy()
      this.hud?.remove()
      this.topHud?.destroy()
      this.bars?.destroy()
      this.inventory?.destroy()
      this.escapeMenu?.destroy()
      this.debugMode?.destroy()
      this.overlay?.destroy()
      this.jetReadout?.remove()
      this.hideJoinCodeBanner()
      this.feel?.destroy()
      this.minimap?.destroy()
      this.debugHud?.destroy()
      this.world?.destroy()
      this.lightmap.destroy()
      this.sky.destroy()
      this.fx?.destroy()
      // **Destroyed, then forgotten.** This block used to null seven of its
      // fields by hand and leave the rest — including `world` and `ready`, the
      // two `update` guards on — so the next frame drove a destroyed camera and
      // killed the render loop (§T20.13). `resetForNewRound` is the one list,
      // shared with `create()`, so the two cannot disagree about what a round
      // owns; the `destroy()` calls stay here because only the teardown knows
      // the objects are going away.
      this.resetForNewRound()
    })

    // §C17: the handle is a **development** surface. `devSurface()` folds to a
    // literal at build time, so in a production bundle this whole call and the
    // body it reaches are deleted rather than merely unreachable.
    if (devSurface() && params.get('e2e') === '1') this.exposeDebugHandle()

    // **The dev path stays dev-only, and that is the answer to T20.02's
    // question.** `?game=1` skips the menu entirely and eight browser checks
    // name their client through this parameter; routing it through
    // `localStorage` would make the URL inert and every one of them anonymous.
    // The stored name is deliberately not consulted here — a check that sets
    // `deepcut.name` and one that passes `?name=` would then disagree about
    // which wins.
    //
    // **Who owns `<>`:** every HTML sink, through `escapeHtml` — `results.ts`,
    // `deathOverlay.ts`, `MenuScene`'s roster and `SkinsScene`'s input. The
    // server strips control characters and neither brackets nor quotes
    // (`sanitise_name`), and `cleanName`'s strip is a second layer at the
    // storage boundary that this path skips. It is skipped safely because the
    // sinks escape, not because the name is clean.
    const name = params.get('name') ?? `player${Math.floor(Math.random() * 1000)}`

    // Handed over from the lobby: already connected, already seated, and its
    // `map_init` already delivered once. Nothing to join.
    const adopted = this.registry.get('liveWelcome') as Welcome | undefined
    if (adopted) {
      this.registry.remove('liveConn')
      this.registry.remove('liveWelcome')
      this.onWelcome(adopted)
      // Replayed **after** the handlers above are registered. The map arrived
      // while `MenuScene` owned the socket, so nothing in this scene saw it;
      // `emitLocal` runs the real handler, which is what turns a lobby into a
      // world. Without it the client sits in an empty game forever.
      // The roster first: `map_init` starts the world, and the scoreboard has to
      // know who is in it before that. Both go through `emitLocal`, which runs
      // the real handlers — the production path, minus the wire.
      const lob = this.registry.get('pendingLobbyState') as unknown
      this.registry.remove('pendingLobbyState')
      if (lob) this.conn.emitLocal('lobby_state', lob)
      const map = this.registry.get('pendingMapInit') as string | undefined
      this.registry.remove('pendingMapInit')
      if (map) this.conn.emitLocal('map_init', map)
      return
    }

    try {
      const w = await this.conn.connect(
      undefined,
      name,
      // **`?skin=` first, storage second** (T20.04). Two clients on the dev path
      // need two different skins for any check to see a skin at all, and
      // `openClient` builds its URL and *then* navigates — so `page.evaluate`
      // on `localStorage` runs after `GameScene.create()` has already read it
      // and is too late. `ctx.addInitScript` would work and appears nowhere in
      // `scripts/`; a query parameter sits beside the `name` one this path
      // already reads, is visible in a failing check's URL, and needs no new
      // mechanism. It wins over storage for the same reason `?name=` does: on
      // this path the URL *is* the identity, and two sources that can disagree
      // is the argument the name half already settled.
      //
      // Parsed through `readId`, not `Number`: `?skin=banana` is `NaN`, which
      // `JSON.stringify` sends as `null` and which this client then hands to its
      // own atlas. Unbounded for the same reason `loadIdentity` is.
      params.get('skin') !== null
        ? readId({ getItem: () => params.get('skin') }, 'skin', Number.POSITIVE_INFINITY)
        : loadIdentity(localStorage).skinId,
      // `?game=1` skips the front end entirely, so there is no lobby to adopt
      // and a plain `join` happens — which is what every check written before
      // the menu expects. The menu path never reaches here.
      undefined,
    )
      this.onWelcome(w)
    } catch (e) {
      this.setStatus(`could not join: ${String(e)}`)
    }
  }

  // ------------------------------------------------------------------ server

  private onWelcome(w: Welcome): void {
    this.me = w.playerId
    // §C14's skyline is seeded from the map. `welcome` is where a networked
    // client learns the seed — `map_init` carries the mask, the pads and the
    // carve sequence, and nothing else — so it is kept here and applied once the
    // map lands. Low 32 bits, because that is all the ridge hash consumes.
    this.mapSeed = Number(BigInt(w.seed || '0') & 0xffffffffn) | 0
    this.roundSeed = String(w.seed ?? '')
    this.roundTime = w.roundTime
    this.serverRoundTime = w.roundTime
    this.phase = w.phase as Phase
    // `welcome` is the only place a client learns the phase it *joined* in:
    // `round_state` is broadcast on transitions and once a second during
    // `Playing` (`docs/41` §3), so the transition into `Warmup` happens before
    // anyone is seated and no client ever receives a `round_state` for it.
    this.observed.phases.add(this.phase)
    // §E6: the roster no longer rides on `welcome` — `lobby_state` carries it,
    // from `Seats`, which is §E1.1's single source. `onLobbyState` below seeds
    // the scoreboard, and it arrives before this does not matter: whichever is
    // second fills in what the first could not.
    //
    // Dropping this without a replacement would render every player as `p1`,
    // `p2`, `p3` — the bug `Seat.name`'s own doc comment records this project
    // already paying for once.
    this.setStatus('decoding map…')
  }

  private onMapInit(b64: string): void {
    if (!b64) return
    const init = this.mirror.applyMapInitB64(b64)

    this.world?.destroy()
    this.world = new WorldView(this, this.core)

    // The **same** theme the terrain resolves, not a second opinion: `WorldView`
    // reads `core.meta.theme` for the rock palette, so reading it here is what
    // keeps a distant ridge the colour of the ground in front of it. The theme
    // is not on the wire today, so both are 0 in a networked round — and they
    // are 0 *together*, which is the property that matters.
    this.sky.setSeed(this.mapSeed, this.core.meta.theme)

    // §C5. Built from the wire rather than from `core.meta`: a networked client
    // never runs the generator, so `core.meta.teleport_pads` is empty here and a
    // renderer reading it would draw nothing while looking correct.
    this.padViews = init.pads.map((p, i) => ({ id: i, x: p.x, y: p.y }))
    this.world.pads.build(this.padViews)

    // §D6. From the wire for the same reason the pads are: a networked client
    // never runs the generator. `atlasArt` returns null frames when the objects
    // atlas did not load, and the bake then draws terrain with no scenery on it
    // rather than failing — `docs/50` §8, the game starts with no art at all.
    this.mapObjects = init.objects
    this.world.terrain.setObjects(init.objects, atlasArt(this.textures, 'objects'))
    // The item layer lives in the shared stack (§C0), so its registry is set
    // here rather than in `create` — there is no layer before there is a world.
    this.world.items.setRegistry(this.core.itemRegistryJson())

    // Seat the local body so prediction has something to move. The server owns
    // the real position and the first snapshot corrects it; this only avoids a
    // frame with no player in it.
    const spawn = this.core.meta.spawn_points[0] ?? { x: this.core.width / 2, y: 0 }
    this.core.removePlayer(this.me)
    this.core.addPlayer(this.me, spawn.x, spawn.y - C().PLAYER_H / 2)
    this.predictor = new Predictor(this.core, this.me)

    this.buildLocalView()

    this.world.rig.follow(spawn)
    this.world.rig.snapTo(spawn)
    this.world.flush(spawn)

    this.minimap?.destroy()
    this.minimap = new Minimap(this.core, this.core.width, this.core.height)

    this.ready = true
    this.conn.sendRaw('ready', {})
    this.setStatus('')

    // A snapshot that beat the map is applied now rather than discarded.
    if (this.pendingSnapshot) {
      const s = this.pendingSnapshot
      this.pendingSnapshot = null
      this.onSnapshot(s)
    }
  }

  private onSnapshot(b64: string): void {
    if (!b64) return
    if (!this.ready) {
      // Keep only the newest: an older one would be immediately superseded.
      this.pendingSnapshot = b64
      return
    }
    const now = performance.now()
    const s = this.mirror.applySnapshotB64(b64, now)

    const lag = s.tick - this.lastServerTick
    if (this.lastServerTick > 0 && lag > this.observed.maxTickLag) this.observed.maxTickLag = lag
    this.lastServerTick = s.tick
    this.debugHud?.noteSnapshot(now, s.tick)
    this.roundTime = s.roundTime
    this.serverRoundTime = s.roundTime
    // The overlay's visibility follows the **server's** alive flag rather than
    // the countdown reaching zero, so a respawn that lands early or late is
    // still what closes it (§B4).
    const meNow = s.players.find((p) => p.id === this.me)
    if (meNow) this.meAlive = flag(meNow.flags, FLAG.alive)
    this.serverDarkness = s.darkness
    if (s.darkness < this.observed.darknessMin) this.observed.darknessMin = s.darkness
    if (s.darkness > this.observed.darknessMax) this.observed.darknessMax = s.darkness
    this.clock.addSample(s.roundTime * 1000, now, this.lastRtt)
    this.interp.push(
      s.tick,
      now,
      s.players.filter((p) => p.id !== this.me),
    )

    const mine = s.players.find((p) => p.id === this.me)
    if (mine) {
      this.serverPos = { x: mine.x, y: mine.y }
      this.health = mine.health
      // §C26. **Already in fuel units.** `codec.ts` dequantises the wire byte
      // when it decodes the snapshot, so `jetpackFuel` is 0..JETPACK_MAX_FUEL
      // here and dividing by 255 again would be the second half of a conversion
      // that has already happened.
      this.fuel = mine.jetpackFuel
      // Also already dequantised by `codec.ts`, for the same reason (§A24).
      this.battery = mine.battery
      this.heals = mine.heals
      this.batteries = mine.batteries
      // §C5. The server's number, not a clock this scene runs — see `pads.ts`.
      this.teleportCharge = mine.teleportCharge
      // The shield is a timer and the snapshot carries only the *flag*, so the
      // start is the edge: the first tick it is up. Derived rather than sent,
      // because a second field would be a second thing that can disagree.
      // **The edge is gone with the timer** (T20.08). `shieldSince` existed only
      // to give `shieldRing` a start time for a 20 s window; a held generator has
      // no start, so the boolean is the whole of it.
      this.shieldOn = flag(mine.flags, FLAG.shield)
      // §E13. The snapshot carries the boolean, like the shield above: the
      // client colours a bar off it and never predicts a status.
      this.poisoned = flag(mine.flags, FLAG.poisoned)
      // §T20.07. `FLAG.flashlight` had **no production reader at all** — it was
      // written by the server, exported by `codec.ts` and consumed only by two
      // tests, which is why the flashlight did nothing in a real game.
      this.hasFlashlight = flag(mine.flags, FLAG.flashlight)
      // Authoritative, because smoke is positional: what you can see depends on
      // which cloud you are standing in. This replaced a hardcoded 1, which is
      // why heavy fog changed nothing in the real game for four milestones.
      this.vision = mine.vision
    }
    if (mine && this.predictor) {
      this.predictor.reconcile({
        lastInputSeq: s.lastInputSeq,
        state: {
          x: mine.x,
          y: mine.y,
          vx: mine.vx,
          vy: mine.vy,
          grounded: flag(mine.flags, FLAG.grounded),
          // Dequantised once, in `codec.ts`. This divided by 255 a second time,
          // so the predictor was told a full 5.0 tank held 0.098 — its local
          // body then ran "out of fuel" immediately and stopped predicting
          // thrust while the server kept flying, which is a mispredicted
          // position for the whole of every jetpack burn. §A24: the same wrong
          // expression written in two places, and the second copy is the one
          // that was never looked at.
          fuel: mine.jetpackFuel,
          moveState: 0,
        },
      })
    }
  }

  private dropRemote(id: number): void {
    const r = this.remotes.get(id)
    if (r) {
      r.view.destroy()
      this.remotes.delete(id)
    }
    this.scores.delete(id)
  }

  // ------------------------------------------------------------------- frame

  /**
   * Footsteps, landing and the jetpack.
   *
   * These are the only cues driven by *state* rather than by an event, because
   * there is no `footstep` message and there should not be one — it is the local
   * player's own body and the client already knows it exactly.
   */
  private movementCues(dt: number, body: { vx: number; vy: number; grounded: boolean; moveState: number }): void {
    const jetting = body.moveState === 2
    if (jetting !== this.wasJetting) {
      this.audio.hold('jetpack', jetting, 0.35)
      this.wasJetting = jetting
    }

    if (body.grounded && !this.wasGrounded) {
      // Land, scaled by how hard: a step off a ledge and a fall from a jetpack
      // burn should not sound the same.
      const force = Math.min(1, Math.abs(body.vy) / C().MAX_FALL_SPEED + 0.25)
      this.audio.play('land', { volume: force })
      this.stepAcc = 0
    }
    this.wasGrounded = body.grounded

    const speed = Math.abs(body.vx)
    if (body.grounded && speed > 10) {
      // Stride spacing rather than a fixed interval, so a slowed player (docs/21
      // §3) audibly trudges instead of running on the spot.
      this.stepAcc += (speed * dt) / 26
      if (this.stepAcc >= 1) {
        this.stepAcc = 0
        this.audio.play('walk', { volume: 0.35 * Math.min(1, speed / C().WALK_SPEED) })
      }
    } else {
      this.stepAcc = 0
    }
  }

  /**
   * Load the samples and wire the sink. Deliberately not awaited: audio is the
   * one subsystem whose absence is fully supported (`docs/50` §8), so the scene
   * must not wait on it to start a round.
   */
  private initAudio(): void {
    const c = C()
    this.audio = new Mixer({
      // You hear about as far as you can see in daylight, and pan across the
      // width you can actually see — both are perceptual, so both are stated in
      // screen terms rather than world terms (§A16, §A35).
      falloff: c.FOV_DAY,
      panHalfWidth: c.VIEWPORT_W / c.CAMERA_ZOOM / 2,
    })
    void loadAudio().then(({ cues, sustained, sink }) => {
      this.audio.setCues(cues, sustained)
      if (sink) {
        sink.onEnded = (h) => this.audio.onVoiceEnded(h)
        this.audio.setSink(sink)
        this.unlockAudio = () => sink.unlock()
        // A browser refuses to start an AudioContext without a gesture, so the
        // first real input is the trigger. Both, because a player may click or
        // may press a key first.
        this.input.once('pointerdown', () => this.unlockAudio())
        this.input.keyboard?.once('keydown', () => this.unlockAudio())
      }
    })
  }

  /**
   * One place mapping a wire event to a sound, so adding a cue is an entry here
   * rather than another handler threaded through the scene.
   */
  private cueFor(ev: string, p: Record<string, unknown>): void {
    const x = Number(p['x'] ?? 0)
    const y = Number(p['y'] ?? 0)
    const ear = this.ear()
    switch (ev) {
      case 'projectile_spawn': {
        this.observed.projectileSpawns += 1
        // **Keyed on the weapon, not defaulted to a rocket.**
        //
        // Two bugs met here. The wire carries `weapon` as a numeric id
        // (`events.rs`: `"weapon": weapon.0`), so `String(id) === 'grenade'` was
        // never true and every thrown weapon in the game has always launched
        // with the bazooka's roar. §F1 then made the five guns projectiles, so
        // gunfire joined them and the default became impossible to miss.
        //
        // `WEAPON_KEYS` is the id→key table that is already pinned against the
        // Rust registry by a unit test, so this cannot drift the way §B16's
        // laser-as-a-bazooka did. An id that resolves to nothing gets **no
        // sound** rather than a rocket: a missing cue is a finding, and a
        // plausible wrong one hides it.
        const key = WEAPON_KEYS[Number(p['weapon'] ?? -1)]
        // §F10.2, at the receiving end. `jets` used to count `cone` events; the
        // flamethrower emits no cone any more, so this is what replaced the
        // number rather than the number quietly going to zero. Cumulative, like
        // `projectileSpawns` and for the same reason: a flame's whole life is
        // `FLAME_LIFE` and a live count can miss a burst entirely between polls.
        if (key === 'flame') this.observed.flamesSpawned += 1
        const cue = key === undefined ? undefined : FIRE_CUE[key]
        if (cue) this.audio.spatial(cue, x, y, ear)
        // `undefined` is a weapon nothing has decided about; `null` is one
        // decided to be silent. Only the first is a gap, so only the first is
        // counted — otherwise every meteor inflates the number and it can never
        // be asserted at zero, which is the only assertion it is for.
        else if (cue === undefined) this.observed.unmappedFireCues += 1
        break
      }
      case 'item_pickup':
        // Only your own pickup is a confirmation; someone else's is information
        // you should not get for free.
        if (Number(p['player_id'] ?? -1) === this.me) this.audio.play('pickup')
        break
      case 'crate_spawn':
        this.audio.spatial('crate_land', x, y, ear, 0.8)
        break
      case 'item_spawn':
        if (String(p['source'] ?? '') === 'Crate') this.audio.spatial('crate_land', x, y, ear)
        break
      case 'hazard_spawn': {
        const kind = String(p['kind'] ?? '')
        if (kind.includes('meteor')) this.audio.spatial('meteor', x, y, ear)
        else if (kind.includes('toxic')) this.audio.spatial('toxic', x, y, ear, 0.7)
        else if (kind.includes('lava')) this.audio.spatial('lava', x, y, ear, 0.7)
        break
      }
      case 'effect_start':
        // The telegraph is the point of the three seconds (`docs/13` §2): it has
        // to be audible even when the sky tint is off-screen — and, since §C8,
        // legible: the banner is up for the telegraph as well as the active
        // phase, because a warning nobody can see is not a warning.
        this.audio.play('effect_telegraph', { volume: 0.9 })
        break
      case 'phase_change':
        this.audio.play('phase_change', { volume: 0.7 })
        break
      case 'respawn':
        if (Number(p['id'] ?? -1) === this.me) this.audio.play('pickup', { volume: 0.6 })
        break
      default:
        break
    }
  }

  /** Where the listener is. Cues are mixed relative to the local player. */
  private ear(): { x: number; y: number } {
    return this.predictor?.renderPos ?? this.world?.rig.center ?? { x: 0, y: 0 }
  }

  /**
   * One frame of §F3's automatic fire.
   *
   * The cadence comes from the **registry** — `auto` and `cooldown` travel with
   * `item_registry_json` — so this holds no table of its own. A local copy of
   * five cooldowns would drift the day a constant moved and nothing would go red.
   *
   * The server's `fire_ready_at` remains the authority. This is a rate limit, not
   * a permission: it exists so a 10-shots-a-second weapon sends ten requests a
   * second instead of sixty, and if the two ever disagree the server refuses the
   * shot, which is correct.
   */
  private stepRepeatFire(dt: number): void {
    // Dead players do not fire, and a corpse holding the button must not bank a
    // burst that arrives on respawn. Read from `meAlive` — the **server's** word
    // (§B4) — rather than from whether the overlay happens to be drawn.
    if (!this.meAlive) {
      this.repeatFire.reset()
      return
    }
    const held = this.input.activePointer.leftButtonDown()
    const sel = this.slots[this.selectedSlot] ?? null
    const profile = this.world?.items.fireProfileForKey(sel?.key ?? null) ?? null
    const shots = this.repeatFire.update({
      dt,
      held,
      weapon: profile,
      // An empty stack stops the repeat here as well as at the server, so a
      // player holding the button on a spent weapon is not sending refused
      // requests at the weapon's cadence for as long as they hold it.
      hasAmmo: (sel?.count ?? 0) > 0,
    })
    for (let i = 0; i < shots; i++) this.conn.sendFire()
  }

  override update(_time: number, delta: number): void {
    // §C12's FPS counter, from real frame timestamps and not from Phaser's
    // smoothed average (§A38). Sampled every frame whether or not the mode is on,
    // so switching it on reports the rate you already had rather than starting a
    // fresh window that reads 0 for half a second.
    this.debugMode?.update(_time)
    if (!this.ready) return
    const dt = delta / 1000
    if (!this.ready || !this.world || !this.predictor) return

    // §F3: holding the **left** button empties the clip of an automatic weapon.
    //
    // Sampled here rather than driven from an event, for the reason
    // `localInput.ts`'s header gives about held keys: `pointerdown` fires once,
    // and "still held" is a state no event reports. An event-driven repeat stops
    // the moment nothing changes, which is exactly when a player is holding the
    // button down.
    //
    // **Left only.** The right button opens the backpack (§F4.1) and must not
    // fire — `leftButtonDown()` is the whole guard, and holding right while left
    // is up reads as not held.
    this.stepRepeatFire(Math.min(dt, MAX_FRAME_DT))

    // Fixed timestep. Stepping by the frame delta would make movement depend on
    // the frame rate, and the whole point of shipping game-core to the browser
    // is that it runs the simulation the server runs.
    const step = C().SIM_DT
    this.acc = Math.min(this.acc + dt, MAX_FRAME_DT)
    const batch = []
    while (this.acc >= step) {
      const body = this.core.playerState(this.me)
      const centre = body ? { x: body.x, y: body.y } : this.world.rig.center
      const input = this.localInput.sample(++this.seq, centre, this.cameras.main)
      this.predictor.pushInput(input, step)
      batch.push(input)
      this.acc -= step
    }
    // Redundant sends: the last few inputs go with every packet, so a dropped
    // one costs nothing (`docs/40` §2).
    //
    // Not while the results screen is up. The server freezes the simulation in
    // `Ended` (`docs/41` §3) but keeps accepting input, so a client that carries
    // on sending queues a burst that is applied the moment the next round starts
    // — you would spawn already walking, holding a direction you pressed while
    // reading a scoreboard.
    if (batch.length && !this.results.isUp) {
      this.conn.sendInput(batch.slice(-C().INPUT_REDUNDANCY))
      this.inputsSent++
      this.debugHud?.noteInputs(performance.now(), batch.length)
    }

    // One tiny echo a second is enough to keep the estimate current without
    // adding meaningful traffic.
    this.rttAcc += dt
    if (this.rttAcc >= 1) {
      this.rttAcc = 0
      this.conn.sendRaw('ping_rtt', String(performance.now()))
    }

    this.predictor.updateRender(dt)
    this.roundTime += dt

    const body = this.core.playerState(this.me)
    const rp = this.predictor.renderPos
    if (body && this.localView) {
      const aim = dequantizeAngle(
        this.localInput.sample(this.seq, { x: body.x, y: body.y }, this.cameras.main).aim,
      )
      this.localView.setState(rp.x, rp.y, body.vx, body.vy, aim, {
        alive: true,
        grounded: body.grounded,
        jetpack: body.moveState === 2,
        // **`false` was hardcoded here** (T20.08), so the bubble has never
        // appeared on your own body — the same wired-to-nothing shape T20.07
        // found six of, one layer over. Every remote player has been drawing it
        // from bit 3 all along; the one player who needs to know they are
        // protected was the one who could not see it.
        shield: this.shieldOn,
        // `iframes` is still a literal. Left alone deliberately: the spawn
        // invulnerability has no visual in `PlayerView` beyond this flag, and
        // giving it one is a design decision, not this task's. **Worth booking.**
        iframes: false,
      })
      this.crosshair.update(rp.x, rp.y, aim)
      // `watchPoint` is an e2e affordance, and only that (§C2). A supply crate
      // lands wherever the schedule puts it, which is usually several hundred px
      // off camera — so a screenshot named `crate-falling.png` reliably contained
      // no crate, and a check that cannot photograph its subject cannot tell a
      // parachute that draws from one that does not. Rendering is world-space, so
      // what this frames is exactly what a player standing there would see.
      this.world.rig.follow(this.watchPoint ?? { x: rp.x, y: rp.y })
      this.movementCues(dt, body)
    }
    this.world.rig.update(dt)

    this.renderRemotes(performance.now())

    // Darkness from round time locally, corrected by the server's byte so the
    // two never drift apart (`docs/14` §1).
    const darkness = this.serverDarkness || darknessAt(cycleU(this.roundTime), C().NIGHT_DARKNESS)
    this.sky.update(this.roundTime, darkness)

    this.death.update(
      !this.meAlive,
      this.roundTime,
      (id) => this.scores.get(id)?.name,
      [...this.scores.values()].map((v) => ({ name: v.name, score: v.score })),
    )
    // The mirror has tracked projectiles since T6.08 and nothing drew them
    // (§A39). The server's live list is the authority, so this is a diff rather
    // than a stream of add/remove calls: a missed despawn self-corrects next
    // frame instead of leaving a rocket hanging in the air.
    this.world?.syncProjectiles(this.mirror.projectiles.values())
    // Toxic rain is on while any recorded effect is in its active phase. The
    // lifecycle is already tracked for the e2e; nothing consumed it visually,
    // which is §B21 exactly — the number was right and never reached the screen.
    if (this.world) {
      // **With `dt`.** `WorldView.update(near, dt = 0, weather?)` gates its
      // ordnance and weather work on `dt > 0`, and this scene called it with the
      // camera centre alone — so `WorldView.ordnance.update()` never ran in a
      // real round. That layer is where `syncProjectiles` puts every projectile,
      // and its `Graphics` is only ever drawn inside `update()`, so **no rocket,
      // grenade or meteor has ever been drawn in an actual game** (§C23, and the
      // §C0 shape a third time).
      //
      // `SandboxScene` calls `this.world.ordnance.update(dt)` itself, which is
      // exactly why T13.03's pixel test passed while a player saw nothing: it
      // samples the one scene that does not have the bug.
      //
      // The weather arguments move in here too. Passing them separately was the
      // same workaround one step earlier — this scene reaching past the shared
      // update to poke a sub-layer it could not reach through it.
      // **No `toxicActive`** (T20.05). It was scanned out of `observed.effects`
      // — the effect lifecycle — while the drops that carve and poison came from
      // the projectile stream, so the sheet and the hazard were two rains that did
      // not know about each other. `WorldView.liveToxicDrops` counts the real ones
      // it is already tracking.
      this.world.update(this.world.rig.center, dt, {
        vents: [],
        fallScale: C().MAX_FALL_SPEED,
        fog: this.fog.strength(this.roundTime),
        hasFlashlight: this.hasFlashlight,
      })
    }
    // Mine visibility is distance to the *player*, not to the camera centre —
    // the camera leads the aim, so those are not the same point.
    this.fx.update(dt, this.ear(), performance.now())
    // World items were tracked from T6.08 and drawn by nothing: a medkit on the
    // ground was invisible in the real game.
    this.world?.items.update(dt, [...this.mirror.items.values()], this.ear())
    this.tombstones.update([...this.mirror.tombstones.values()])
    this.birds.update(this.mirror.birds.values(), this.time.now)
    if (this.world) {
      const me = this.core.playerState(this.me)
      const on = me ? padUnderfoot(this.padViews, me.x, me.y) : null
      this.world.pads.update(dt * 1000, on, this.teleportCharge)
    }
    this.feel.update(dt, this.feelFrame())
    // §C3. Phase-driven, not clock-driven: the server owns which phase the round
    // is in, and a client deciding locally would take the controls away a beat
    // early from a player who could still act.
    this.results.update(
      this.phase,
      // Recomputed every frame against the server's clock — `roundTime` is
      // resynced by every snapshot, so this cannot drift (§B4).
      secondsUntil(this.phaseEndsAt, this.roundTime),
      [...this.scores.entries()].map(([id, s], i) => ({
        id,
        name: s.name,
        score: s.score,
        deaths: s.deaths,
        joinOrder: i,
        isLocal: id === this.me,
      })),
    )

    const fov = fovRadius({
      darkness,
      fogMult: this.vision,
      health: C().BASE_HEALTH,
      hasFlashlight: this.hasFlashlight,
    })
    if (this.minimap) {
      const dots = [...this.remotes.entries()].map(([id, r]) => ({
        id,
        x: r.view.container.x,
        y: r.view.container.y,
      }))
      // The *same* fov the lightmap and the renderer cull with — computed once,
      // above, rather than recomputed here. Two copies of this number would let
      // the minimap and the screen disagree about who is visible (§A6).
      this.minimap.update(dt, rp, dots, fov)
    }

    const lights: LightSource[] = [
      // The player's own field of view is a light like any other.
      { x: rp.x, y: rp.y, radius: fov, kind: 'radial', intensity: 1 },
      ...(this.world?.ordnance
        .lights()
        .map((l) => ({ x: l.x, y: l.y, radius: l.r, kind: 'radial' as const, intensity: l.a })) ??
        []),
      // Fire and flame jets emit like every other emitter (§A3). Smoke and
      // mines deliberately do not: a mine that lit itself up at night would
      // defeat the point of hiding it.
      ...this.fx
        .lights()
        .map((l) => ({ x: l.x, y: l.y, radius: l.r, kind: 'radial' as const, intensity: l.a })),
    ]
    this.debugHud.update(performance.now(), {
      rttMs: this.clock.rtt,
      pendingInputs: this.predictor.stats.pending,
      corrections: this.predictor.stats.corrections,
      lastCorrectionPx: this.predictor.stats.lastCorrectionPx,
      maxCorrectionPx: this.predictor.stats.maxCorrectionPx,
      snaps: this.predictor.stats.snaps,
      interpDepth: this.interp.stats.bufferDepth,
      extrapolatingMs: this.interp.stats.extrapolatingMs,
      frozen: this.interp.stats.frozen,
      localPos: rp,
      serverPos: this.serverPos,
      checksums: {
        checked: this.mirror.stats.checksumsChecked,
        mismatched: this.mirror.stats.checksumMismatches,
        resyncs: this.mirror.stats.resyncs,
      },
      tick: Math.round(this.roundTime * C().SIM_HZ),
      serverTick: this.lastServerTick,
      clockOffsetMs: this.clock.offset,
      seed: String(this.core.meta.seed),
      fps: this.game.loop.actualFps,
    })
    this.lightmap.render(this.cameras.main, darkness, lights)
    this.refreshHud()
  }

  /**
   * Build the local body at whatever skin the room says this seat chose.
   *
   * A function rather than three lines at the call site because there are now
   * two callers — the map arriving, and the skin becoming known afterwards — and
   * the depth is the part a second copy would forget.
   */
  /**
   * Open or close the backpack (§C10, §F4.1's right button).
   *
   * A method because there are two callers now: the canvas's `pointerdown`, and
   * the panel itself for the pixels between its tiles (T20.09). It is
   * client-side and sends nothing, and it is **not a pause** — the round runs
   * behind it, exactly as §B4 established for the death screen.
   */
  private toggleBackpack(): void {
    this.invOpen = this.inventory?.toggle() ?? !this.invOpen
    this.audio.play('ui_click', { volume: 0.5 })
    this.refreshHud()
  }

  private buildLocalView(): void {
    this.localView?.destroy()
    this.localView = new PlayerView(this, this.scores.get(this.me)?.skinId ?? 0)
    this.localView.container.setDepth(DEPTH.actors)
  }

  /**
   * Rebuild the local body if the room has just told us it is a different skin.
   *
   * **The local seat has no `player_join` of its own** — that event is broadcast
   * to everybody *except* the player who joined — so `lobby_state` is the only
   * thing that ever names this client's own skin. It normally lands well before
   * `map_init`, and this is what covers the case where it does not, for the same
   * reason the remotes are rebuilt: there is no setter.
   *
   * Cheap: `skin` is the id the view was built with, so this is a comparison and
   * not a rebuild on every message.
   */
  private syncLocalSkin(): void {
    const want = this.scores.get(this.me)?.skinId ?? 0
    if (this.localView && this.localView.skin !== want) this.buildLocalView()
  }

  /**
   * Remote players come from the interpolation buffer, never from
   * `apply_input`: there are no remote inputs to run, and interpolating
   * transmitted positions is both cheaper and more accurate (`docs/42` §4).
   */
  private renderRemotes(now: number): void {
    const sampled = this.interp.sample(now)
    const localPos = this.predictor?.renderPos ?? { x: 0, y: 0 }
    const darkness = this.serverDarkness || darknessAt(cycleU(this.roundTime), C().NIGHT_DARKNESS)
    const fov = fovRadius({
      darkness,
      fogMult: this.vision,
      health: C().BASE_HEALTH,
      hasFlashlight: this.hasFlashlight,
    })

    for (const [id, p] of sampled) {
      let r = this.remotes.get(id)
      // **Read at the construction site, every rebuild.** `:1592` destroys a
      // remote that leaves the sampled set and this rebuilds it on return, so
      // the skin is not read once — it is read from whatever `scores` holds at
      // that moment, which is exactly why the three writers above had to agree.
      const want = this.scores.get(id)?.skinId ?? 0
      // A remote can be drawn a frame before anyone says who it is: the snapshot
      // is binary and `player_join`/`lobby_state` are JSON, so the body can
      // arrive first. The answer to "what happens then" is **not** a default
      // that sticks — `PlayerView` takes its skin in the constructor and has no
      // setter (`playerView.ts:116`), so the only way to change it is to build
      // another one, which is what already happens routinely below.
      if (r && r.view.skin !== want) {
        r.view.destroy()
        this.remotes.delete(id)
        r = undefined
      }
      if (!r) {
        r = { view: new PlayerView(this, want), lastSeen: now }
        r.view.container.setDepth(DEPTH.actors)
        this.remotes.set(id, r)
      }
      r.lastSeen = now
      // Cull outside your field of view (`docs/14` §5): at night you do not see
      // someone standing in the dark, and drawing them anyway is the whole
      // see-in-the-dark hole.
      const d = Math.hypot(p.x - localPos.x, p.y - localPos.y)
      const visible = darkness <= 0.01 || d <= fov
      r.view.container.setVisible(visible && flag(p.flags, FLAG.alive))
      if (!visible) continue
      r.view.setState(p.x, p.y, p.vx, p.vy, p.aim, {
        alive: flag(p.flags, FLAG.alive),
        grounded: flag(p.flags, FLAG.grounded),
        jetpack: flag(p.flags, FLAG.jetpack),
        shield: flag(p.flags, FLAG.shield),
        iframes: flag(p.flags, FLAG.iframes),
      })
    }

    for (const [id, r] of [...this.remotes]) {
      if (!sampled.has(id)) {
        r.view.destroy()
        this.remotes.delete(id)
      }
    }
  }

  // --------------------------------------------------------------------- ui

  private buildHud(): void {
    this.hud = document.createElement('div')
    this.hud.dataset['hud'] = 'root'
    this.hud.id = 'game-hud'
    this.hud.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;padding:6px 10px;font:12px/1.5 monospace;' +
      'color:#fff;text-shadow:0 1px 2px #000;pointer-events:none;z-index:10;' +
      // The strip, the inventory panel and the scoreboard are separate lines.
      // Without this they collapse into one unreadable run of text — the
      // newlines are in `textContent` and HTML simply does not honour them.
      'white-space:pre'
    document.body.appendChild(this.hud)

    // §C26: the jetpack number, in the bottom-left cluster §C8 puts the bars in.
    //
    // Its **own element**, not a field in the HUD's status line, for two
    // reasons: `this.hud.textContent = …` replaces the whole node every frame,
    // and T14.02 builds the bars this is meant to sit beside — it can position
    // this next to the yellow bar without unpicking a string.
    const jet = document.createElement('div')
    jet.id = 'jetpack-readout'
    // Clear of `#game-hud`, which is a full-width strip pinned to `bottom:0`
    // with 6 px of padding around a 12px/1.5 line — about 30 px tall. At
    // `bottom:12px` this landed **on top of** the round clock; the screenshot
    // showed "JET 2.2" overprinting "2:53" (§C2: look at the picture).
    jet.style.cssText =
      'position:fixed;left:10px;bottom:36px;z-index:12;' +
      'font:600 15px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'color:#ffd23f;text-shadow:0 1px 2px rgba(0,0,0,.9);pointer-events:none;'
    document.body.appendChild(jet)
    this.jetReadout = jet

    // §C8. Built here so it shares the HUD's lifetime, torn down in SHUTDOWN
    // with everything else — a DOM element outliving its scene is how the death
    // overlay once stayed on screen through a restart.
    this.topHud = new Hud()
    this.bars = new Bars()
    this.inventory = new InventoryPanel(
      {
        // The drag is **intent**. Nothing moves here; the server answers with an
        // `inventory` event and that is what gets rendered (§C10).
        moveItem: (from, to) => this.conn.sendRaw('move_item', { from, to }),
        // T20.09. Intent, like the drag: the server refuses an empty slot, an
        // out-of-range one and the starting kit, and answers with `inventory`.
        dropItem: (slot) => this.conn.sendRaw('drop_item', { slot }),
        // The panel's own right-click, in its gaps and padding, does what the
        // canvas's does — one action, not a second copy of it.
        toggleBackpack: () => this.toggleBackpack(),
        selectSlot: (slot) => {
          this.selectedSlot = slot
          this.conn.sendSelectSlot(slot)
        },
        // The tile draws what the world draws. `artFor` is the world's own
        // fallback order and `ItemLayer` already registered the procedural
        // textures, so this reads them rather than building a second set —
        // `getBase64` is the only bridge a DOM tile needs into Phaser's
        // texture manager.
        artUrl: (sprite) => {
          const t = this.textures
          const art = artFor(
            sprite,
            (f) => t.exists(ITEM_ATLAS) && t.get(ITEM_ATLAS).has(f),
            (k) => t.exists(k),
          )
          if (!art) return null
          return art.kind === 'atlas' ? t.getBase64(ITEM_ATLAS, art.frame) : t.getBase64(art.key)
        },
      },
      C().QUICK_SLOTS,
      C().BACKPACK_SLOTS,
    )

    // §C13. Quitting **leaves the room** as well as changing scene: a scene
    // change alone keeps the seat, and the room then never reaps (§B14's shape,
    // and the same reason `ResultsScreen.onExit` closes the socket).
    this.escapeMenu = new EscapeMenu({
      onResume: () => this.escapeMenu?.toggle(false),
      onQuit: () => {
        this.conn.sendRaw('leave_room', {})
        this.conn.close()
        this.scene.start('Title')
      },
    })
    // §C12. Built after the crosshair and the overlay, because it turns both off
    // on construction — and **off is the default**, so a normal game shows the
    // crosshair and nothing else.
    // §C17 lists the overlays, the aim ring and the FPS counter among the things
    // a production build does not contain. So debug mode is built only when the
    // dev surface is — and the ring is hidden by the crosshair itself, not by
    // this, so a build without debug mode has no ring rather than a ring nobody
    // can turn off.
    if (devSurface()) {
      this.overlay = new DebugOverlay(this, this.core, false)
      this.debugMode = new DebugMode({
        setAimRing: (on) => this.crosshair.setRingVisible(on),
        setOverlays: (on) => this.overlay?.set(on),
      })
      this.input.keyboard?.on('keydown-F1', (e: KeyboardEvent) => {
        // The browser's own help panel is on F1 in some builds.
        e.preventDefault?.()
        this.debugMode?.toggle()
        this.audio.play('ui_click', { volume: 0.4 })
      })
    }

    this.input.keyboard?.on('keydown-ESC', () => {
      // Innermost overlay first (§C13). The decision is `handleEscape`'s so it
      // can be driven under node; this only carries it out.
      switch (
        handleEscape({
          inventoryOpen: this.inventory?.isOpen ?? false,
          menuOpen: this.escapeMenu?.isOpen ?? false,
        })
      ) {
        case 'closed-inventory':
          this.invOpen = this.inventory?.toggle(false) ?? false
          this.refreshHud()
          break
        case 'closed-menu':
          this.escapeMenu?.toggle(false)
          break
        case 'opened-menu':
          this.escapeMenu?.toggle(true)
          break
      }
      this.audio.play('ui_click', { volume: 0.5 })
    })
  }

  private setStatus(text: string): void {
    if (this.hud) this.hud.dataset['status'] = text
  }

  private hideJoinCodeBanner(): void {
    this.codeBanner?.remove()
    this.codeBanner = null
  }

  /** §A35: `worldView` and the canvas's CSS rect, never the camera transform. */
  private feelFrame(): FeelFrame {
    const cam = this.cameras.main
    const r = this.game.canvas.getBoundingClientRect()
    return {
      view: {
        x: cam.worldView.x,
        y: cam.worldView.y,
        width: cam.worldView.width,
        height: cam.worldView.height,
      },
      canvasRect: { x: r.left, y: r.top, width: r.width, height: r.height },
      canvasW: this.scale.width,
      canvasH: this.scale.height,
    }
  }

  private refreshHud(): void {
    if (!this.hud) return
    const rows = rankScores(
      [...this.scores.entries()].map(([id, s], i) => ({
        id,
        name: s.name,
        score: s.score,
        deaths: s.deaths,
        joinOrder: i,
        isLocal: id === this.me,
      })),
    )
    // §C25: the same deadline the results screen uses. `Warmup` and `Ended` get
    // no periodic `round_state`, so a banner built from `timeLeft` showed
    // "Warmup — 0:10" for the whole warmup and "Round over — 0:20" for the whole
    // vote window. `phaseBanner` ignores the number for `lobby` and returns null
    // for `playing`, so this only changes the two that were frozen.
    const secondsLeft = secondsUntil(this.phaseEndsAt, this.roundTime)
    // §C8. Driven from the same server-anchored deadline the strip's clock uses,
    // not from a local stopwatch: §B4 made the death countdown server-driven
    // because a stopwatch drifts, and a round timer drifts the same way.
    this.topHud?.update(secondsLeft, this.roundTime, C().TIMER_WARN_SECONDS)

    // §C8's cluster. `fuelShown` is last frame's fuel, which is what makes the
    // refill delay derivable from two samples rather than from a flag the client
    // is never sent.
    const c = C()
    const waiting = inRefillDelay(this.fuelShown, this.fuel, c.JETPACK_MAX_FUEL, this.wasJetting)
    this.bars?.update({
      health: healthBar(this.health, c.BASE_HEALTH, c.HEALTH_CAP, this.poisoned),
      energy: energyBar(this.battery, c.BATTERY_MAX),
      jetpack: jetpackBar(this.fuel, c.JETPACK_MAX_FUEL, waiting),
      consumables: {
        heals: this.heals,
        batteries: this.batteries,
        // From the constants, never spelled here: the row's length **is** the
        // cap `bump` enforces, and a HUD holding its own copy would show a
        // fifth socket the game refuses to fill.
        maxHeals: C().MAX_HEALS,
        maxBatteries: C().MAX_BATTERIES,
      },
      // **No `shield` view** (T20.08). `shieldRing` returned a 0..1 fraction of a
      // 20 s window, and there is no window: a generator is held and pays per
      // hit. The two things a player needs are *whether* they are protected and
      // *how much longer* — the first is the bubble on their own body, wired at
      // last (see `localView.setState`), and the second is the energy bar that
      // was already on this cluster. A second widget for the battery would be a
      // second answer that can disagree with it.
    })
    const banner = phaseBanner(this.phase, secondsLeft)
    // Readability matters here: the previous format rendered as
    // "3:56 1= p0 0 1= p1 0 1= cy 0", where the trailing "=" reads as an equals
    // sign and nothing separates a name from a score. Ties now lead with "=",
    // as in chess, the score follows a colon, and entries are visibly separated.
    const board = rows
      .map((r) => {
        const rank = `${r.tied ? '=' : ''}${r.rank}`
        const name = r.isLocal ? `[${r.name}]` : r.name
        return `${rank} ${name}:${r.score}`
      })
      .join('   ·   ')
    const status = this.hud.dataset['status'] ?? ''
    // What is left of the old text strip.
    //
    // It used to carry the health, the held item and the whole inventory as a
    // line of text. §C8 gives health its own bar, §C10 gives the inventory a
    // quick bar and a backpack, and printing all of it twice put a second,
    // worse copy of the HUD across the bottom of the frame — visible in
    // `shots/inventory-open.png`, where the 24-slot list ran off both edges.
    // The join code stays: someone arriving late still needs it, and nothing
    // else shows it once the banner has gone.
    const strip = this.joinCode ? `code ${this.joinCode}` : ''
    const lines = [
      [status, banner ?? formatClock(this.timeLeft), strip].filter((p) => p !== '').join('   │   '),
    ]
    if (this.scoreboardOpen) lines.push(board)
    this.hud.textContent = lines.join('\n')

    // §C26. One decimal, from the snapshot's fuel — see `jetpackReadout-math`
    // for the measured curve this exists to make legible.
    if (this.jetReadout) {
      const trend = fuelTrend(this.fuelShown, this.fuel, C().JETPACK_REFILL, C().SIM_DT)
      this.fuelShown = this.fuel
      const mark = trend === 'draining' ? '▼' : trend === 'refilling' ? '▲' : '·'
      this.jetReadout.dataset['fuel'] = fuelText(this.fuel, C().JETPACK_MAX_FUEL)
      this.jetReadout.dataset['trend'] = trend
      this.jetReadout.textContent = `JET ${fuelText(this.fuel, C().JETPACK_MAX_FUEL)} ${mark}`
    }
  }

  private exposeDebugHandle(): void {
    // Guarded again *inside* the method, and not redundantly: a class method is
    // reachable from the prototype, so the bundler keeps it however the call
    // site is guarded. What it does delete is a block behind a `false` literal —
    // which is what takes the word `__game` out of the artifact, and that is
    // what `no-dev-surface` greps for.
    if (!devSurface()) return
    const self = this
    ;(window as unknown as { __game: unknown }).__game = {
      /**
       * Start now with bots — the manual form of §E2's timeout.
       *
       * Was `#lobby-start`, a button on a panel this scene no longer draws
       * (§E1). The `?game=1` path bypasses the menu entirely, so on that path
       * there is no lobby screen to press either — this is the surface a check
       * has left, and it emits the same verb the button did.
       */
      startWithBots: () => self.conn.sendRaw('start_with_bots', {}),
      /**
       * The depths the shared world stack actually produced, deduped and sorted.
       *
       * Asserted between the two scenes (§C1). Not "both call WorldView" — a scene
       * that adds a world layer inline still shows up here, which is the drift the
       * whole task exists to end.
       */
      sceneDepths() {
        const seen = new Set<number>()
        for (const o of self.children.list) {
          const d = (o as unknown as { depth?: number }).depth
          // World layers only: the sandbox panel and the HUD are DOM or per-scene
          // furniture, and comparing them would report a difference that is not one.
          if (typeof d === 'number' && d <= DEPTH.lightmap) seen.add(d)
        }
        return [...seen].sort((a, b) => a - b)
      },
      /**
       * e2e only: stop the scene so a position read and a screenshot describe
       * the same instant.
       *
       * A crate falls at several hundred px/s and the camera is at zoom 2, so
       * the ~100 ms between "where is it" and "take the picture" moves it a
       * couple of hundred pixels on screen. A patch computed from the first
       * number and sampled from the second measured the parachute on one run
       * (117) and empty sky on the next (15) — the same code, the same seed.
       */
      /**
       * e2e only (§C2): hide the bird layer so a check can diff one frozen frame
       * against itself.
       *
       * The alternative — photograph a bird, wait for it to fly off, photograph
       * again — compares two instants, and every coordinate in the first is a
       * scene-graph value while the picture is a rendered frame. Under load
       * those diverge and the patch lands where the bird is not: measured, the
       * rect changed 15.5 standalone and 0.0 under load while 31,058 px of the
       * frame changed elsewhere. Toggling the layer inside one frozen frame has
       * no second instant to disagree with, which is how `living-sky` measures
       * the parallax band.
       */
      setBirdsVisible(on: boolean) {
        self.birds?.setVisible(on)
      },
      /**
       * e2e only (§C2): hide every player body, so a check can photograph the
       * ground they are standing on **through the same rect** it photographed
       * them in.
       *
       * `setBirdsVisible`'s shape and its reason. Without it, comparing two
       * players' pixels compares two hillsides as well: measured, two bodies on
       * the *same* skin standing 1500 px apart differ by 74 in a rect that is
       * mostly sprite, because a character sprite is transparent around its
       * outline and the terrain shows through. With the bodies hidden the same
       * rect gives that background alone, and the difference between the two
       * readings is the part the skin is responsible for.
       *
       * **Only holds while the scene is frozen.** `renderRemotes` writes
       * `setVisible` on every remote every frame, so a caller must `freeze(true)`
       * first — which is what makes this one frame diffed against itself rather
       * than two instants of a moving world.
       */
      setActorsVisible(on: boolean) {
        self.localView?.container.setVisible(on)
        for (const [, r] of self.remotes) r.view.container.setVisible(on)
      },
      freeze(on: boolean) {
        if (on) self.scene.pause()
        else self.scene.resume()
      },
      /** e2e only (§C2): frame a world point so a check can photograph it. */
      watch(x: number | null, y = 0) {
        self.watchPoint = x === null ? null : { x, y }
        // Snap, do not lerp. A crate falls faster than the rig follows, so a
        // lerped move left the crate off the bottom of the frame by the time
        // the camera arrived — the check then reported "never framed in flight"
        // for a crate that was on screen a moment earlier.
        if (self.watchPoint) self.world?.rig.snapTo(self.watchPoint)
      },
      debug() {
        const body = self.core.playerState(self.me)
        return {
          ready: self.ready,
          me: self.me,
          // §F9, at both ends (§A39): the strength the scene walked from the
          // effect's start time, and the alpha the shared layer actually filled
          // with. The pair is what tells a reader whether a fogless-looking
          // frame is a dead effect or a dead renderer.
          fogStrength: self.fog.strength(self.roundTime),
          fogAlpha: self.world?.weather.fogAlpha ?? 0,
          // §B4. The overlay's own numbers, so the check reads what the player
          // sees rather than inferring it from health.
          death: {
            visible: self.death.isUp,
            text:
              document.querySelector('.death-count')?.textContent ?? '',
            cause: document.querySelector('.death-cause')?.textContent ?? '',
            // The overlay needs **both** of these (`shouldShow`), and they come
            // from different places: `meAlive` from the snapshot's alive flag
            // *and* the death event, `info` from the death event alone. When the
            // overlay does not come up, which of the two is missing is the whole
            // diagnosis — without them a check can only report that it is down.
            meAlive: self.meAlive,
            hasInfo: self.death.hasInfo,
          },
          /**
           * **Always `''` since T17.07, and deliberately not deleted.**
           *
           * This read `#join-code b` — a banner this scene no longer draws,
           * because the code belongs in the lobby, which is where a player is
           * when there is anyone to invite (§E1). The surface it observed is
           * gone, so the honest answer is "nothing is visible here".
           *
           * The fallback it used to carry is the reason this is spelled out
           * rather than removed: it asked whether the HUD text *contained* the
           * code, so with the banner gone the field would have kept answering
           * from a different surface than the one it was written to observe —
           * passing or failing for reasons unrelated to what a host can see.
           * `m10-checkpoint` reads `__menu.visibleCode()` now, which is the
           * lobby's own DOM.
           */
          visibleCode: '',
          mapW: self.core.width,
          mapH: self.core.height,
          /**
           * **The local core's seed, which is not the round's.** Kept because
           * `m9-checkpoint` and `sandbox` run where the client really does
           * generate the map, and there it is the right number. Anything about
           * the *round* wants `roundSeed` below.
           */
          seed: self.core.meta.seed,
          /** The seed `welcome` carried — the one the server generated from. */
          roundSeed: self.roundSeed,
          phase: self.phase,
          players: [...self.mirror.players.keys()],
          /**
           * §B9 at both ends (§A39): the id each **drawn** body was built with,
           * keyed by seat.
           *
           * `PlayerView.skinId` is read off the views, not off `scores` — the
           * whole T20.04 bug was that `scores` knew and the views did not, so a
           * field reporting `scores` would have been green throughout it. It is
           * a control for the pixel check and never its assertion: an id that
           * arrived and was not drawn is exactly this bug.
           */
          /**
           * Where each body is **drawn**, as the body's centre in world
           * coordinates — §C7, the same distinction `birdsDrawnAt` and
           * `drawnItems` already make.
           *
           * A remote is drawn from the **interpolation buffer**, which lags that
           * client's own predicted position by design. A check that framed a
           * remote using the position its *own* page reports lands off the
           * sprite: measured, a rect built that way caught 36 % as much of the
           * body as one on the local player, and the check then compared a
           * sprite with a hillside and called the difference a skin.
           *
           * The container sits at the feet (`setState` adds `PLAYER_H / 2`), so
           * the centre is what comes back — the caller wants the body, not the
           * anchor.
           */
          drawnPlayers: [
            ...(self.localView
              ? [
                  {
                    id: self.me,
                    x: self.localView.container.x,
                    y: self.localView.container.y - C().PLAYER_H / 2,
                  },
                ]
              : []),
            ...[...self.remotes].map(([id, r]) => ({
              id,
              x: r.view.container.x,
              y: r.view.container.y - C().PLAYER_H / 2,
            })),
          ],
          drawnSkins: Object.fromEntries([
            ...(self.localView ? [[self.me, self.localView.skin] as const] : []),
            ...[...self.remotes].map(([id, r]) => [id, r.view.skin] as const),
          ]),
          // Items the server says exist, and items actually on screen. Two
          // numbers rather than one, because they were silently different for
          // three milestones: the mirror tracked them and nothing drew them.
          worldItems: self.mirror.items.size,
          itemsDrawn: self.world?.items.count ?? 0,
          // Where they are drawn, read back off the sprites — §C7 was a bug in
          // which every position the client held was wrong, so a check needs the
          // drawn positions and the server's, not one number twice.
          drawnItems: self.world?.items.drawn ?? [],
          chutesDrawn: self.world?.items.chutesDrawn ?? 0,
          mirrorItems: [...self.mirror.items.values()].map((i) => ({
            id: i.id,
            item: i.item,
            x: i.x,
            y: i.y,
            source: i.source,
            grounded: i.grounded,
          })),
          // Two numbers, not one (§A39): the server's graveyard against the
          // graves actually on screen.
          tombstones: self.mirror.tombstones.size,
          tombstonesDrawn: self.tombstones?.count ?? 0,
          // Both ends (§A39): what the server said, and what is on screen. A
          // bird nobody can see is a supply line nobody can open.
          birds: self.mirror.birds.size,
          birdsDrawn: self.birds?.count ?? 0,
          // The DRAWN positions, for a check that photographs a bird. The
          // mirror's coordinates below describe a different instant whenever the
          // renderer is behind, which under load it is.
          birdsDrawnAt: self.birds?.drawn ?? [],
          birdKinds: [...self.mirror.birds.values()].map((b) => b.kind),
          // §C5, both ends again: what the wire said, and what is on screen.
          // `pads` alone would pass for a scene that decoded them and drew
          // nothing, which is the §A39 shape this list exists to catch.
          pads: self.padViews.length,
          padsDrawn: self.world?.pads.count ?? 0,
          // §D6, both ends again: what `map_init` carried, and what the index
          // the bake reads actually holds. `objects` alone would pass for a
          // scene that decoded them and never called `setObjects` — which is
          // exactly the "renderer never told the map had changed" shape.
          objects: self.mapObjects.length,
          objectsIndexed: self.world?.terrain.objectIndex?.count ?? 0,
          objectChunks: self.world?.terrain.stats.objectChunks ?? 0,
          objectPositions: self.mapObjects.map((o) => ({
            id: o.id,
            x: o.x,
            y: o.y,
            w: o.w,
            h: o.h,
            flip: o.flip,
          })),
          // `docs/60` §6's rebake budget, read from the renderer's own
          // instrument rather than a stopwatch the check starts itself.
          lastBakeMs: self.world?.terrain.stats.lastBakeMs ?? 0,
          padPositions: self.padViews.map((p) => ({ id: p.id, x: p.x, y: p.y })),
          // The local player's charge as the client has it, so a check can watch
          // it fill rather than sleeping for two seconds and hoping.
          teleportCharge: self.teleportCharge,
          onPad: (() => {
            const me = self.core.playerState(self.me)
            return me ? padUnderfoot(self.padViews, me.x, me.y) : null
          })(),
          // Count at both ends (§A39). These two numbers were silently
          // different for world items for three milestones; asserting only
          // that the server placed a mine would have passed the whole time.
          // The inventory as the player sees it, so a check can select a weapon
          // by NAME instead of by a hotkey number it worked out once.
          //
          // §C24 collapsed the dev loadout's duplicate bazooka into one slot and
          // every index after the smg shifted by one. `ordnance` pressed Digit5
          // for the axe and got the flamethrower: the melee assertion timed out
          // "waiting for a swing", the cone assertion passed on the jet that
          // stray press produced, and nothing said the word "slot" anywhere.
          slots: self.slots.map((sl, i) => ({
            slot: i,
            key: sl?.key ?? null,
            count: sl?.count ?? 0,
            selected: i === self.selectedSlot,
          })),
          // §C11 asserts the selection is *unchanged*, which needs the index
          // and not only the per-slot flag.
          selectedSlot: self.selectedSlot,
          // §C13 / §C10, for the browser check: which overlays are up.
          overlays: {
            inventory: self.inventory?.isOpen ?? false,
            escapeMenu: self.escapeMenu?.isOpen ?? false,
          },
          // §C12, for the browser check: the mode, and the number it shows.
          debugMode: {
            on: self.debugMode?.enabled ?? false,
            fps: self.debugMode?.fpsMeter.fps() ?? 0,
            overlays: self.overlay?.enabled ?? false,
          },
          minesPlaced: self.observed.minesPlaced,
          minesEnded: self.observed.minesEnded,
          swings: self.observed.swings,
          jets: self.observed.jets,
          flamesSpawned: self.observed.flamesSpawned,
          minesDrawn: self.fx?.mineCount ?? 0,
          // Positions too, so a check can aim at a mine rather than guess a
          // screen point. A hardcoded screen coordinate is a test that expires
          // the moment the camera, the zoom or the spawn moves.
          mines: [...(self.fx?.state.mines.values() ?? [])].map((m) => ({
            id: m.id,
            x: m.x,
            y: m.y,
          })),
          /** Every bird the mirror holds, so a check can aim at one. */
          birdViews: [...self.mirror.birds.values()].map((b) => ({
            id: b.id,
            kind: b.kind,
            x: b.x,
            y: b.y,
          })),
          camera: { x: self.cameras.main.scrollX, y: self.cameras.main.scrollY },
          zoom: self.cameras.main.zoom,
          // The camera's top-left in world coordinates, exactly as the sandbox
          // reports it. Absent until T13.05, which meant a check converting a
          // world position to a screen one here read `undefined` and silently
          // concluded the subject was off camera — an assertion that could not
          // succeed rather than one that could not fail (§B15).
          worldView: {
            x: self.cameras.main.worldView.x,
            y: self.cameras.main.worldView.y,
            width: self.cameras.main.worldView.width,
            height: self.cameras.main.worldView.height,
          },
          hazardsDrawn: self.fx?.hazardCount ?? 0,
          // Both ends, per delivery kind (§A39/§C23). A gun and a rocket take
          // different paths and only one of them was ever counted.
          //
          // `projectilesLive` is the mirror — what the server says is in the
          // air; `projectilesDrawn` is the layer's own map, asked of the layer
          // rather than of the set this scene fills, so it reports effect and
          // not intent (§A15).
          projectilesLive: self.mirror.projectiles.size,
          // **Weather at both ends, in the scene a player is in** (T20.05).
          // Every weather assertion in the tree was a `?sandbox=1` check, and
          // this is the §C0 shape that keeps costing this project a milestone:
          // the sandbox pokes the sub-layers by hand, so a rain wired only there
          // is a rain nobody plays. `toxicDrops` is what the server put in the
          // air, `rainDrops` is what the emitter drew from it.
          // T20.07, and both ends again: what the *server* says is in the bag
          // (snapshot bit 4, derived from the inventory) and what the veil was
          // actually filled with. `fogAlpha` below is the second half.
          hasFlashlight: self.hasFlashlight,
          toxicDrops: self.world?.liveToxicDrops ?? 0,
          rainDrops: self.world?.weather.rainDrops ?? 0,
          rainPool: self.world?.weather.rainPool ?? 0,
          toxicDensityAsked: self.world?.weather.toxicDensityAsked ?? 0,
          toxicIntensity: self.world?.weather.toxicIntensity ?? 0,
          // Positions too, so a check can aim a patch at a projectile rather
          // than guess a screen point — a hardcoded coordinate is a test that
          // expires the moment the camera, the zoom or the spawn moves.
          mirrorProjectiles: [...self.mirror.projectiles.values()].map((p) => ({
            id: p.id,
            x: p.x,
            y: p.y,
          })),
          projectilesDrawn: self.world?.drawnProjectiles ?? 0,
          // How many times the ordnance layer has actually redrawn, and what
          // the LAST redraw put on the canvas. `projectilesDrawn` above counts
          // the state map — the counter that read 1 live / 1 drawn throughout
          // the period when no rocket had ever been drawn in a real game. A
          // check that freezes the scene to photograph a projectile needs to
          // know the frame on screen was rendered after the projectile arrived,
          // and nothing else can tell it that.
          ordnanceRedraws: self.world?.ordnance.redraws ?? 0,
          // Where the layer is DRAWING them, read back off its own state —
          // §C7's lesson for projectiles. The mirror's position and the drawn
          // position are not the same number: `projectile_move` arrives at
          // SNAPSHOT_HZ and the layer tracks between those, so at
          // `BAZOOKA_SPEED` the two are tens of pixels apart. A check that
          // aimed a 70 px patch at the mirror's position photographed empty sky
          // and read 1.2 against a floor of 4.0 — identical on every run,
          // because it is not noise, it is the wrong place.
          drawnProjectiles: [...(self.world?.ordnance.state.projectiles.values() ?? [])].map(
            (p) => ({ id: p.id, kind: p.kind, x: p.x, y: p.y }),
          ),
          projectilesLastFrame: self.world?.ordnance.drawnProjectilesLastFrame ?? 0,
          // Tracers are not "live" in the same sense — a hitscan shot is an
          // instant, and the tracer is a decaying record of it — so this is how
          // many the layer is currently drawing, against `observed.hitscans`
          // for how many the server has narrated.
          tracersDrawn: self.world?.ordnance.state.tracers.length ?? 0,
          // The snapshot roster includes the local player, so this is the
          // total — not remotes plus one.
          playerCount: self.mirror.players.size,
          player: body,
          renderPos: self.predictor?.renderPos ?? null,
          // §A39, both ends for the local player. `player` above is the *local
          // core's* prediction; this is the position the last snapshot carried,
          // which is the one `World::resolve_pickups` measures a pickup from.
          // A check whose whole claim is a distance — "I am standing on the
          // crate" — could otherwise only ever see one end of it (T19.17).
          serverPlayer: self.serverPos,
          inputsSent: self.inputsSent,
          pendingInputs: self.predictor?.stats.pending ?? 0,
          corrections: self.predictor?.stats.corrections ?? 0,
          lastServerTick: self.lastServerTick,
          rtt: self.clock.rtt,
          rttMeasured: self.rttSamples > 0,
          maskChecksum: hex(self.core.maskHash()),
          solid: self.core.countSolid(),
          pendingCarves: self.mirror.pendingCarves,
          carvesApplied: self.mirror.stats.carvesApplied,
          resyncs: self.mirror.stats.resyncs,
          interp: self.interp.stats,
          // §C25. The results countdown as the **player sees it** (the DOM text)
          // beside the number it was computed from, so a check can assert the
          // rendered thing rather than an internal field — §C2, and the reason
          // the death overlay reports `.death-count` the same way.
          //
          // `timeLeft` below is deliberately still the raw `round_state` value:
          // it is the thing that was frozen, so a check comparing the two can
          // tell a live countdown from the bug.
          results: {
            visible: self.results.isUp,
            text: document.querySelector('.results-count')?.textContent ?? '',
            secondsLeft: secondsUntil(self.phaseEndsAt, self.roundTime),
          },
          banner: self.hud?.textContent?.includes('Round over')
            ? (/Round over — ([0-9:]+)/.exec(self.hud.textContent)?.[1] ?? '')
            : '',
          // §C26. The readout as the player sees it (the DOM text) beside the
          // snapshot value it was built from, so a check can assert the two
          // against each other — one number alone would pass for a readout
          // wired to nothing (§A39).
          jetpack: {
            text: document.querySelector('#jetpack-readout')?.textContent ?? '',
            shown: Number(
              (document.querySelector('#jetpack-readout') as HTMLElement | null)?.dataset[
                'fuel'
              ] ?? NaN,
            ),
            trend:
              (document.querySelector('#jetpack-readout') as HTMLElement | null)?.dataset[
                'trend'
              ] ?? '',
            fuel: self.fuel,
          },
          // Round state, for a check that has to watch a whole round rather
          // than a moment of one.
          roundTime: self.roundTime,
          // The server's own number, unextrapolated — see `serverRoundTime`.
          // "Is anything being stepped" has to be asked of the server, and
          // `lastServerTick` cannot answer it since `World::tick_idle` made the
          // clock run in a lobby too.
          serverRoundTime: self.serverRoundTime,
          timeLeft: self.timeLeft,
          // §C8, both ends (§A39): what the timer *says* and whether it has gone
          // red, beside the number it was computed from. A pixel check reads the
          // colour off the frame; this is what it is checked against.
          hudTimer: {
            text: self.topHud?.timer.textContent ?? '',
            warn: self.topHud?.timer.dataset['warn'] === '1',
          },
          // §C8's cluster, both ends (§A39): what each bar is told to draw,
          // beside the snapshot fields it was computed from.
          hudBars: {
            health: healthBar(self.health, C().BASE_HEALTH, C().HEALTH_CAP, self.poisoned),
            energy: energyBar(self.battery, C().BATTERY_MAX),
            jetpack: jetpackBar(self.fuel, C().JETPACK_MAX_FUEL, false),
            shieldOn: self.shieldOn,
            // Both ends (§A39): the flag off the wire beside the colour it
            // produced, so a green bar with `poisoned` false is visible as a
            // disagreement rather than as a colour nobody can explain.
            poisoned: self.poisoned,
            battery: self.battery,
            heals: self.heals,
            batteries: self.batteries,
          },
          hudBanner: {
            text: self.topHud?.banner.textContent ?? '',
            shown: (self.topHud?.banner.style.display ?? 'none') !== 'none',
            effects: self.topHud?.effects() ?? [],
          },
          darkness: self.serverDarkness,
          health: self.health,
          scores: [...self.scores.entries()].map(([id, s]) => ({
            id,
            name: s.name,
            score: s.score,
          })),
          // Accumulated events (see `observed`). Sets and Maps do not survive
          // `page.evaluate`'s structured clone as anything useful, so they are
          // flattened here rather than in the check.
          observed: {
            phases: [...self.observed.phases],
            dayPhases: [...self.observed.dayPhases],
            effects: [...self.observed.effects.entries()].map(([id, e]) => ({
              id,
              kind: e.kind,
              phases: [...e.phases],
            })),
            hazards: self.observed.hazards,
            lastHazard: self.observed.lastHazard,
            deaths: self.observed.deaths,
            respawns: self.observed.respawns,
            itemSpawns: self.observed.itemSpawns,
            itemPickups: self.observed.itemPickups,
            hitscans: self.observed.hitscans,
            projectileSpawns: self.observed.projectileSpawns,
            unmappedFireCues: self.observed.unmappedFireCues,
            darknessMin: self.observed.darknessMin,
            darknessMax: self.observed.darknessMax,
            maxTickLag: self.observed.maxTickLag,
          },
        }
      },
      fire() {
        self.conn.sendFire()
      },
      /**
       * Aim at your own feet and fire until you die.
       *
       * Self-damage is full (`docs/31` §2 — `SELF_DAMAGE_MULT` 1.0), so this is
       * the shortest reliable route to a death without needing a second player
       * to cooperate. It goes through the real fire path, so it is a real death
       * with real attribution, not a debug hook that sets health to zero.
       */
      /**
       * Feed the client a `death` payload as the server would send it.
       *
       * The overlay is what T10.06 owns; producing the damage that causes a
       * death is combat, exercised by `full-round`. This drives the exact
       * handler the socket drives, so the countdown, the attribution and the
       * clearing are all the real code paths.
       */
      debugDeath(payload: Record<string, unknown>) {
        self.conn.emitLocal?.('death', payload)
      },
      debugRespawn() {
        self.conn.emitLocal?.('respawn', { id: self.me })
      },
      /**
       * The simulation's own tunables, as the client already has them.
       *
       * e2e only. A browser check that carries its own copy of a number stays
       * green against a drifted implementation (§A19) — `crates` asserted
       * against a hardcoded `PICKUP_RADIUS` of 20 in a comment for two
       * milestones.
       */
      constants() {
        // **Strict** (T20.15): the browser checks are untyped `.mjs`, so a read of
        // a constant that is not in `constants_json` came back `undefined` and any
        // arithmetic on it `NaN` — which is how `lobby-start` built a
        // `waitForFunction` with no deadline. This throws instead.
        return strictConstants()
      },
      debugHud() {
        return self.debugHud.stats()
      },
      minimap() {
        return self.minimap?.stats() ?? null
      },
      feel() {
        return self.feel.stats()
      },
      core: self.core,
    }
  }
}
