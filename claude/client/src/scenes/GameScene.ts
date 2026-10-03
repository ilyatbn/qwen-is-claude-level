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
import { imagePortal, loadAssetManifest, runLoader } from '../render/assets'
import { DeathOverlay } from '../ui/deathOverlay'
import { TombstoneLayer } from '../render/tombstones'
import { RoundReset } from '../net/roundReset'
import { LoadCover } from '../ui/loadCover'
import { AnimalLayer } from '../render/animals'
import { BirdLayer } from '../render/birds'
import { LANDING_VOLUME_FLOOR, LandingLatch, landingVolume } from '../render/feel-math'
import { GATE_KEY, padUnderfoot, type PadView } from '../render/pads'
import { occupiedPlatforms, platformUnderfoot } from '../render/platforms'
import type { MapObject } from '../net/codec'
import { C, Core, MapGenerator, dequantizeAngle, strictConstants, type FlareQuery, type VentSpec } from '../core'
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
import { ClockSync, RemoteInterpolator, type InterpolatedPlayer } from '../net/interpolation'
import { SPECTATE_SCORES_KEY, WatchState, type WatchCandidate } from '../net/spectate'
import { WorldView } from '../render/worldView'
import { loadWorldRenderer } from '../look/loadWorldRenderer'
import type { GameMap, GameWorld } from '../look/worldRenderer'
import { adoptWorldLook, worldLookByte, worldLookOfMeta } from '../look/worldLookId'
import { EffectLights, MUZZLE_FRAMES, gateLights, jetFlames, viewRect, type EffectSources } from '../look/effectLights'
import { fxFeed } from '../look/fx/feed'
import { TerrainFields } from '../look/terrainFields'
import { DEPTH } from '../render/backdrop'
import { PlayerView, SCARF_COLOURS } from '../render/playerView'
import { HUD_SERIF } from '../ui/hudStyle'
import { setGroundProbe } from '../look/actors/cast'
import { standTarget, trackTilt, type TiltTrack } from '../render/standTilt-math'
import { Crosshair, LocalInput } from '../input/localInput'
import { MAX_FRAME_DT, RepeatFire, repeatSource } from '../input/autoFire'
import { firstSeqAfter, roundClockOnSnapshot } from '../net/seqClock'
import { SpaceSky } from '../render/spaceSky'
import { fovRadius, nightView } from '../render/lightmap-math'
import { NIGHT_CIRCLES, seenAt, sightLights } from '../look/worldRenderer-math'
import { OrdnanceFxLayer } from '../render/ordnanceFx'
import { RoundWatch } from '../render/ordnanceWatch'
import { PendingUses, RttFilter, swings as swingsKey } from '../look/actors/pendingUses'
import { crystalLights, joinCrystals } from '../look/actors/furniture'
import { hazardKind } from '../render/ordnanceFx-math'
import { cycleU, sceneDarkness } from '../render/sky-math'
import { nightShare } from '../look/daylight'
import { phaseBanner, rankScores, type Phase } from '../ui/scoreboard'
import { ResultsScreen } from '../ui/results'
import { parseVoteTally, phaseDeadline, secondsUntil } from '../ui/results-math'
import { fuelText, fuelTrend, jetReadoutText } from '../ui/jetpackReadout-math'
import { FLAG, MOVE_MOD, flag, inputPackets } from '../net/codec'
import { FeelLayer, type FeelFrame } from '../ui/feelLayer'
import { feedCause } from '../ui/killfeed-state'
import { RadiationFx } from '../render/radiationFx'
import { Minimap } from '../ui/minimap'
import { beaconCrates } from '../ui/minimap-math'
import { Hud, type EffectPhase } from '../ui/hud'
import { Bars } from '../ui/bars'
import { InventoryPanel } from '../ui/inventory'
import { EscapeMenu, handleEscape } from '../ui/escapeMenu'
import { OptionsPanel } from '../ui/optionsPanel'
import { hasWebGL } from '../render/shaders'
import { DebugMode, FpsMeter } from '../ui/debugMode'
import { isFpsCounter, isHighQuality, onFpsCounterChange, setHighQuality } from '../ui/settings'
import { devSurface } from '../dev'
import { DebugOverlay } from '../render/debugOverlay'
import { energyBar, healthBar, inRefillDelay, jetpackBar } from '../ui/bars-math'
import { DebugHud } from '../ui/debugHud'
import { ITEM_ATLAS } from '../render/itemSprites'
import { artFor } from '../render/itemSprites-math'
import { gunAt, muzzleDir, type Pt } from '../render/muzzle-math'
import { shakeOrigin, traumaFromExplosion } from '../render/cameraRig-math'
import { Mixer } from '../audio/mixer'
import { loadAudio } from '../audio/sfx'
import { FlareClock, FogClock, LavaClock, ServerClock } from '../render/weather-math'
import { FlareFx, type FlareBody } from '../render/flareFx'
import { VortexFx } from '../render/vortexFx'
import { BlackHoleFx } from '../render/blackHoleFx'
import { DEFAULT_GRAVITY, SPACE_GRAVITY } from './sceneParams'
import { PushEstimate } from '../look/actors/push'

/** T23.14D F4: the pull handed to a remote's push estimate while it is not jetting (unread then). */
const NO_PULL = [0, 0] as const

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
    /** T23.27: Tab / Shift+Tab presses in spectate. */
    watchSteps: 0,
    /** T23.14E: uses sent (`useNow`), and the last one's predicted answer (`key` null: refused). */
    uses: 0,
    /** T23.14E F4: frames held by `slowFrames`. */
    slowFrames: 0,
    /** T23.14E F7: landings a correction's replay found (`Core.landingSince`). */
    replayLandings: 0,
    /** T23.14E F7: the volume each `land` cue was played at, newest last (the last 8). */
    landVolumes: [] as number[],
    lastUse: null as { quick: boolean; key: string | null } | null,
    /** T23.14F F2: your figure's swings and throws — each predicted one and each late one (`PendingUses`). */
    localSwings: 0,
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
    /** T21.18: `explosion` events received, cumulative — the server's end of a blast. */
    explosions: 0,
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
     * Projectiles **this client's own player** launched (T21.14).
     *
     * `projectileSpawns` counts every `projectile_spawn` the client observes —
     * any player, any bot, and the weather, whose toxic drops and meteor
     * fragments are projectiles too. That is the right number for "is anything
     * flying", and the wrong one for "did my four trigger pulls produce four
     * rockets": `e2e-two-clients` asked the second question with the first
     * number and flaked at about one run in six, reporting 7 spawns for 4
     * shots. Added beside it rather than changing it, because five checks read
     * the broad count and mean it.
     */
    ownProjectileSpawns: 0,
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
    /**
     * T22.10B: relocations the server announced — `vortex_trip`s and pad
     * `teleport`s, both through `onRelocated` — and the ones that were ours.
     */
    vortexTrips: 0,
    teleports: 0,
    /** T22.12D F3: dev placements (`relocate`), a relocation of the third source. */
    relocations: 0,
    /**
     * T22.03D F4: the tick of the last dev placement of **this** player — the
     * snapshot a check may leave out as the placement's is the first at/after it.
     */
    myRelocateTick: null as number | null,
    myTrips: [] as Array<{ x: number; y: number; snapped: boolean }>,
    /** e2e only (`DEV_PROBE=1`): the server's answer to the last `debug_breach`. */
    lastBreach: null as unknown,
    /** e2e only (`DEV_PROBE=1`, T22.12B): the server's answer to the last `debug_black_hole`. */
    lastBlackHole: null as unknown,
    /** e2e only (`DEV_PROBE=1`, T22.19): the server's answer to the last `debug_place`. */
    lastPlace: null as unknown,
  }
}

/**
 * How often the optional FPS readout rewrites its text, in seconds (T21.24).
 *
 * **Not every frame.** Sixty DOM writes a second to say a number that has barely
 * moved is itself a cost the instrument is supposed to be measuring, and a
 * figure flickering through three digits cannot be read at all. Four updates a
 * second is fast enough to show a stall and slow enough to sit still.
 */
const FPS_READOUT_INTERVAL = 0.25

export class GameScene extends Phaser.Scene {
  private core!: Core
  private conn!: Connection
  private mirror!: WorldMirror
  private predictor: Predictor | null = null
  private interp!: RemoteInterpolator
  private clock!: ClockSync

  private world: WorldView | null = null
  /**
   * T23.03 (R1): three.js draws the world under this scene's transparent canvas — the sky since
   * T23.04; the layers Phaser draws move across task by task. Destroyed on shutdown by
   * `createWorldRenderer` itself. `null` until its chunk has loaded (T23.03B, F10).
   */
  private worldRenderer: GameWorld | null = null
  /** T23.06: this map's terrain fields (worker full pass, carve updates, blasts) for the world renderer. */
  private terrainFields: TerrainFields | null = null
  /** T22.06's space backdrop, shown only on a space map (T23.04: `SkyLayer`, which owned it, is retired). */
  private spaceSky!: SpaceSky
  /** The map seed from `welcome` (its low 32 bits): the skies' seed, so every client of a round agrees. */
  private mapSeed = 0
  /** T23.04: `map_init` said a space map (its generator) — no ground sky; the space backdrop instead. */
  private onSpaceMap = false
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
  private fx!: OrdnanceFxLayer
  /** e2e only: point the camera here instead of at the player. */
  private watchPoint: { x: number; y: number } | null = null
  /** T99.04 (promo, `__game.setShakeScale`): explosion trauma's multiplier — 1 in every real round. */
  private shakeScale = 1
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
  /** T21.16's options panel. Opened from the escape menu, closed back to it. */
  private optionsPanel: OptionsPanel | null = null
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
   * T22.09B: is space's radiation getting through my suit? Snapshot bit 7
   * (`PlayerState::irradiated`), never derived here — the battery beside it is
   * quantised, and "flat" is the server's call.
   */
  private irradiated = false
  private radiation!: RadiationFx
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
  /** T21.02, from the snapshot's move-mod byte. Drawn, and nothing else. */
  private hasBoots = false
  /** T21.34. Off `MOVE_MOD.wings` in the snapshot — see where it is set. */
  private hasWings = false
  /**
   * T22.19 (R107): the local figure's drawn rotation, and each remote's — smoothed per
   * frame by `standTilt-math.ts::trackTilt` toward the pull `Core.standPullAt` reports at
   * the position drawn (the local's render position, a remote's interpolated one), with
   * where it was drawn, so a relocation snaps the tilt rather than turning it (T22.19B F5).
   * `null` / absent: not drawn yet this round — the first frame snaps.
   */
  private localTrack: TiltTrack | null = null
  private readonly remoteTilts = new Map<number, TiltTrack>()
  /** T23.09C F2: each live round's `projectile_spawn` point — where it left the gun — by id. */
  private readonly roundOrigins = new Map<number, { x: number; y: number }>()
  /** T23.35: fresh rounds that left a gun — owner and direction — kept on the drawn gun for their flash (`anchorMuzzles`). */
  private readonly gunRounds = new Map<number, { owner: number; dir: Pt; frames: number }>()
  /** T23.14D F4: each remote's jet push, estimated from its motion (its input is not on the wire). */
  private readonly remotePushes = new Map<number, PushEstimate>()
  private get localTilt(): number {
    return this.localTrack?.theta ?? 0
  }
  /** The last frame's `dt`, s — the remotes' tilt steps by it too. */
  private frameDt = 0
  /** T23.14E F4, e2e (`slowFrames`): ms every frame busy-waits — a slow frame on demand, as a loaded box has. */
  private slowFrameMs = 0
  /** T23.14F F2: your predicted swings, each waiting for the server's echo of it (`look/actors/pendingUses.ts`). */
  /** T23.19D F4: the round trip, filtered — what the pending uses' bound reads (one slow sample does not move it). */
  private readonly rtt = new RttFilter()
  private readonly pendingUses = new PendingUses(() => this.rtt.value)
  /** T23.14E F4, e2e (`watchRounds`): each round's pixels on the canvas (`render/ordnanceWatch.ts`). */
  private roundWatch: RoundWatch | null = null
  /**
   * T22.04: the match's gravity spelling, off `lobby_state` — the same value the
   * mirror is handed there. Drawn with, and nothing else: the helmet, the space pose and its
   * turned flame (`look/actors/pose.ts`).
   */
  private gravity = DEFAULT_GRAVITY
  private jetReadout: HTMLDivElement | null = null
  /**
   * T21.24's optional FPS readout, and the meter behind it.
   *
   * **`FpsMeter`, not `game.loop.actualFps`.** The task named Phaser's figure;
   * this repository has already paid for it once. `FpsMeter`'s own header
   * records the diagnosis: `actualFps` is a smoothed average that under-reports
   * for seconds after a stall, and a "performance regression" investigated under
   * §A38 turned out to be the counter lying rather than the game being slow —
   * `perf.mjs` deliberately refuses to assert on it for the same reason. This
   * counter exists so a player can judge what an effect costs on their machine,
   * which is precisely the judgement a smoothed average gets wrong, so it reads
   * the median of real frame deltas like the debug one does. Reported to the
   * coordinator with the task; one import reverses it.
   */
  private fpsCounter: HTMLDivElement | null = null
  private readonly playerFps = new FpsMeter()
  private unsubFpsCounter: (() => void) | null = null
  /** Seconds until the readout is allowed to rewrite itself. */
  private fpsTextDue = 0
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
  /** T23.09D: the frame's landing, observed after every predicted step (`LandingLatch`). */
  private readonly landing = new LandingLatch()
  private wasJetting = false
  private serverPos: { x: number; y: number } | null = null
  private lastRtt = 0
  private invOpen = false
  private scoreboardOpen = false
  /**
   * T23.27 (`docs/78` §A1): joined as a spectator (`?spectate=1`) — a seat with **no body**: no local player in the
   * core, no predictor, no input sent. The camera, the night view, the minimap and the HUD follow `watch.watching`.
   */
  private spectating = false
  private readonly watch = new WatchState()
  /**
   * T23.27: **the viewpoint this frame** — the local body's drawn place, or in spectate the watched player's
   * interpolated one (`viewer`). The one input every "where am I looking from" site reads: the camera, the seeing rule
   * (`renderRemotes`, T23.10B F1's circles), the night view, the minimap and the ear.
   */
  private viewAt: { x: number; y: number } | null = null
  /** T23.27: "SPECTATING <name> — Tab to switch", over the HUD. */
  private spectateLine: HTMLDivElement | null = null
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
  private slots: Array<{ item: number; key: string; count: number } | null> = []
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
  /** T19.24: which server-announced lava burst is running, and its seed. */
  private readonly lava = new LavaClock()
  /** T22.08B: the running solar flare's seed and origin (`R80`: derived, not sent). */
  private readonly flareClock = new FlareClock()
  /**
   * T22.08D F2: the server's tick clock, smoothed — what the flare is drawn at. Sampled
   * off every snapshot's exact tick (its round time was truncated to 0.1 s until
   * T22.14C), so the ribbon only ever moves forward.
   */
  private readonly serverClock = new ServerClock()
  /** The crosshair mark's world position, last frame — `debug().crosshair`. */
  private crosshairAt: { x: number; y: number } | null = null
  /** T22.08D F3: each remote's health in the last snapshot — a drop during a flare confirms its burn. */
  private readonly remoteHealth = new Map<number, number>()
  /** The query the last frame drew the flare at — `debug().flareQuery`, frozen with the scene. */
  private lastFlareQuery: FlareQuery | null = null
  /** e2e only (T22.08D F1): callers waiting on the server's `debug_effects` answer. */
  private readonly probeWaiters: ((p: unknown) => void)[] = []
  private flareFx!: FlareFx
  /** T22.10B: the breach vortices, drawn from `mirror.vortices`. */
  private vortexFx!: VortexFx
  /** T22.12B: the black hole, drawn from `mirror.blackHole`. */
  private blackHoleFx!: BlackHoleFx
  /**
   * T22.12C F5: the last `Playing` `round_state`'s `ends_tick` (T22.12D, R94) —
   * the last tick stepped in `Playing`, so where the bell falls. Each snapshot
   * turns it into an input seq for the core (`Core.setBell`), which stops
   * predicting the hole's pull from there.
   */
  private bellEndsTick: number | null = null
  /**
   * T22.14C MED-2: the bell's input seq as last told to the core (`firstSeqAfter` of
   * `bellEndsTick` against the newest snapshot) — from it on the prediction steps as
   * the server's `Ended`, before `ended` is heard. Debug only: `thrusters-match`'s
   * "last frame before the bell" is the last one predicted before it.
   */
  private bellSeq: number | null = null
  /**
   * T22.12E F2: the tick of the `round_state` that said `ended` — the tick the
   * server rang the bell on (`World::step` sets `Ended` last), so `bellEndsTick`
   * must equal it exactly. Debug only: the `black-hole` check compares the two.
   */
  private endedAtTick: number | null = null
  /** Bodies drawn this frame, for the flare's contact test — filled by `renderRemotes`. */
  private readonly flareBodies: FlareBody[] = []
  /** This frame's vents, derived once and read by both the layer and the lights. */
  private vents: VentSpec[] = []
  /** T23.09: the per-frame effect-light list (`effectLights.ts`), handed to the world renderer. */
  private effectLights = new EffectLights()
  /** T23.28: the one per-round reset — every holder registers here as `create` builds it; `new_round` runs them all. */
  private roundReset!: RoundReset
  /** T23.28: the cover over a map still being painted, or a round not yet started (`coverWanted`). */
  private loadCover: LoadCover | null = null
  /** T23.28: `ready` has gone out for the map in force — sent once it is painted (`trySendReady`), not on decode. */
  private readySent = false
  /** T23.28: this map's round has not been announced yet — a restart's (`new_round`) or a first round's (`lobby`). */
  private awaitingRound = false
  /** T23.28: the world renderer's chunk has loaded (or failed to) — until then "the terrain is painted" is unknown. */
  private rendererSettled = false
  private seq = 0
  private acc = 0
  /** `performance.now()` at the last fixed-step update — see `update`'s clock (T22.10F). */
  private stepClockAt: number | null = null
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
  /** T20.10, beside the birds and for the same reasons. */
  private animals!: AnimalLayer
  /** §C5's pads, as `map_init` gave them. The layer lives in `WorldView` (§C1). */
  private padViews: PadView[] = []
  /** T21.14: the platforms drawn this round, for the occupied lamp. */
  private platformViews: Array<{ id: number; x: number; y: number }> = []
  /** §D6's scenery, straight off the wire — the count the index is checked against. */
  private mapObjects: MapObject[] = []
  /** T23.19: takes this map's crystals out of the cast (`furniture.ts::joinCrystals`). */
  private leaveCrystals: () => void = () => {}
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
  /** T23.10: the sight radius the last frame's night view was drawn with (`debug().sight`). */
  private sightFov = 0
  private readonly sightSeen = new Map<number, { x: number; y: number; visible: boolean }>()
  /**
   * T23.10B F1: the circles this frame's remotes were judged against (`renderRemotes`) — the player's sight, then the
   * lights they see in (`sightLights`) — handed on unchanged to the night view and the minimap, so neither can draw a
   * pool or a dot the rule did not.
   */
  private sight: { x: number; y: number; r: number }[] = []
  private sightLit: { x: number; y: number; r: number }[] = []
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
   * Who is in the room, as the JSON events describe them: name, score, deaths. T23.15 (R8): no appearance — the
   * events still carry `skin_id`/`hat_id`/`glasses_id` (the wire is unchanged) and this client reads none of them.
   */
  private scores = new Map<number, { name: string; score: number; deaths: number }>()
  private ready = false
  private lastServerTick = 0
  private serverDarkness = 0
  /** T22.06: the darkness the last frame was drawn with — `sceneDarkness`'s answer, not the byte. */
  private drawnDarkness = 0

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
    // `update`'s three guards, and the view they drive. (`ready` is the round's too: `resetRound` below.)
    this.world = null
    // T23.06: last map's fields; a late worker result must not install into this round's core.
    this.terrainFields?.dispose()
    this.terrainFields = null
    this.predictor = null
    this.localView = null
    // T23.14: re-read from the next round's core (the same build's registry, but the core is the round's).
    this.itemKeysMap = null
    // T23.28: the cover and the load handshake. `rendererSettled` is per scene: the world renderer's chunk is
    // loaded again by every `create()`.
    this.loadCover?.destroy()
    this.loadCover = null
    this.rendererSettled = false

    // Who is in the room.
    this.scores.clear()
    this.me = -1
    // T23.27: the new round's players are not the last one's; the first living one is watched again. Spectating is the
    // page's choice (`?spectate=1`), read again by `create` right after this.
    this.spectating = false
    this.watch.reset()
    this.viewAt = null

    // The round's identity.
    this.mapSeed = 0
    this.onSpaceMap = false
    this.roundSeed = ''
    this.phase = 'lobby'
    this.observed = freshObserved()
    // T23.14E F4: the e2e hooks' state is the round's too.
    this.slowFrameMs = 0
    this.roundWatch?.stop()
    this.roundWatch = null

    // Input bookkeeping and the send clock. **Not** `resetRound`'s: a restart keeps the seat, and the server drops
    // any input whose seq is not above the last it accepted from it.
    this.seq = 0
    this.acc = 0
    this.stepClockAt = null
    this.stepAcc = 0
    this.inputsSent = 0
    this.lastRtt = 0
    this.rtt.reset()
    this.rttSamples = 0
    this.rttAcc = 0
    this.landing.reset()
    this.wasJetting = false

    // UI that `create()` rebuilds and `SHUTDOWN` destroys. Nulled here too so the
    // two paths cannot disagree about which of them owns the field.
    this.topHud = null
    this.bars = null
    this.inventory = null
    this.escapeMenu = null
    // T21.16: the panel is rebuilt with the menu that opens it, so it is
    // cleared with it — a stale panel from the previous round would be an
    // orphaned DOM node listening for clicks.
    this.optionsPanel = null
    this.debugMode = null
    this.overlay = null
    this.jetReadout = null
    this.spectateLine = null
    // T21.24. The element is removed and the subscription dropped in SHUTDOWN;
    // these two lines are the other half of that, so a rebuilt scene cannot find
    // a handle to a node that is no longer in the document.
    this.fpsCounter = null
    this.unsubFpsCounter = null
    this.fpsTextDue = 0
    // The meter outlives the scene object, so it has to be told the round ended:
    // its window is a median of *consecutive* frame deltas, and the gap across a
    // restart is a single enormous delta that would sit in the window reporting
    // a few frames a second for the first half-second of the next round.
    this.playerFps.reset()
    this.minimap = null
    this.codeBanner = null
    this.joinCode = null
    this.invOpen = false
    this.scoreboardOpen = false

    // Map payload. Reassigned by `onMapInit`, but not before `update` can read
    // them, and last round's scenery is not this round's.
    this.padViews = []
    // T21.14: last round's platforms are at last round's coordinates, and this
    // list decides which one lights up under a rider.
    this.platformViews = []
    this.mapObjects = []
    this.leaveCrystals()
    this.leaveCrystals = () => {}

    // T22.10B/T22.12/T22.16: last round's holes, black hole and dead cores — the core outlives the scene, so the pull
    // goes too, not only the drawing. (A restart resets the whole mirror: its `RoundReset` entry.)
    this.mirror?.clearVortices()
    this.mirror?.clearBlackHole()
    this.mirror?.clearCores()
    // A pending probe resolves on its own timeout; the answer would be the old round's.
    this.probeWaiters.length = 0

    this.resetRound()
  }

  /**
   * T23.28: **what one round leaves behind, and a new round on the same scene must drop** — the scene's own share of
   * the `RoundReset` (`create` registers it beside the mirror's, the interpolator's and the ordnance layer's). Run on a
   * restart's `new_round`, and by `resetForNewRound` above for a scene that is re-entered: one list, two callers.
   *
   * Kept out of it on purpose: the seat (`me`, `scores`, the input seq — a restart keeps the seat), the HUD, the map
   * payload (`onMapInit` replaces it) and the world view (`onMapInit` destroys and rebuilds it).
   */
  private resetRound(): void {
    // `update` stops until the new map is in (`onMapInit` sets it), and the handshake for that map starts again.
    this.ready = false
    this.readySent = false
    this.awaitingRound = false
    // T23.09: last round's gates and muzzle bookkeeping; this map's gates arrive with `map_init`.
    this.effectLights = new EffectLights()

    // Who was in the last world. `remotes` holds `PlayerView`s, so it is emptied rather than dropped — the next
    // snapshot builds this round's.
    for (const r of this.remotes.values()) r.view.destroy()
    this.remotes.clear()

    // The round's clocks.
    this.roundTime = 0
    this.serverRoundTime = 0
    this.timeLeft = 0
    this.phaseEndsAt = 0
    this.lastServerTick = 0
    this.serverDarkness = 0
    this.drawnDarkness = 0
    this.vision = 1
    this.pendingSnapshot = null

    // The local body, as the snapshot will describe it. `BASE_HEALTH` rather
    // than a literal 100 — the field's own initializer is 0 for this reason.
    this.health = C().BASE_HEALTH
    this.meAlive = true
    this.sightFov = 0
    this.sightSeen.clear()
    this.sight = []
    this.sightLit = []
    this.battery = 0
    this.heals = 0
    this.batteries = 0
    this.shieldOn = false
    this.poisoned = false
    this.irradiated = false
    this.hasFlashlight = false
    this.hasBoots = false
    this.hasWings = false
    // T22.19: a new round's figures start upright.
    this.localTrack = null
    this.remoteTilts.clear()
    this.remotePushes.clear()
    this.roundOrigins.clear()
    this.gunRounds.clear()
    this.frameDt = 0
    this.pendingUses.clear()
    this.fuel = 0
    this.fuelShown = 0
    this.teleportCharge = 0
    // The new round's bag arrives as `inventory`, after its `map_init`.
    this.slots = []
    this.selectedSlot = 0
    this.serverPos = null
    this.watchPoint = null
    // T99.04: a promo's shake multiplier is for the shot that set it; a new round shakes as the game does.
    this.shakeScale = 1

    // The helpers that carry state of their own.
    //
    // `lava` for the reason `fog` is here (T20.13): a burst left running does not
    // stop at the round boundary, and the next match would open vents the server
    // never announced — fire drawn where there is none, which is the exact
    // failure T19.24's determinism cross-check exists to prevent.
    this.fog.clear()
    this.lava.clear()
    this.flareClock.clear()
    this.flareFx?.clear()
    this.bellEndsTick = null
    this.bellSeq = null
    this.endedAtTick = null
    this.core?.setBell(null)
    this.vortexFx?.clear()
    this.blackHoleFx?.clear()
    this.flareBodies.length = 0
    this.serverClock.reset()
    this.crosshairAt = null
    this.remoteHealth.clear()
    this.lastFlareQuery = null
    this.vents = []
    this.death.cleared()
  }

  async create(): Promise<void> {
    // **First, and before the first `await`.** See `resetForNewRound`: Phaser
    // does not await `create`, so `update` runs against these fields while the
    // two loads below are still pending.
    this.resetForNewRound()
    // T23.28: up from the first frame — nothing is painted yet — and lowered by `update` (`coverWanted`).
    this.loadCover = new LoadCover()
    this.loadCover.set(true)

    await loadAssetManifest(this)
    await runLoader(this)

    this.core = this.registry.get('core') as Core
    // T23.14: the ground the stick figures plant their feet on (`look/actors/cast.ts`).
    setGroundProbe(this, (x, y) => this.core.solidAt(x, y))
    const params = new URLSearchParams(location.search)
    // T23.27: `?spectate=1` joins with no body (`docs/78` §A1; `make watch`).
    this.spectating = params.get('spectate') === '1'

    this.mirror = new WorldMirror(this.core)
    this.interp = new RemoteInterpolator()
    // T23.28: every holder of per-round state, in one list (`net/roundReset.ts`); `new_round` runs it.
    this.roundReset = new RoundReset()
    this.roundReset.register('mirror', () => this.mirror.resetRound())
    this.roundReset.register('interp', () => this.interp.reset())
    this.roundReset.register('scene', () => this.resetRound())
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

    this.spaceSky = new SpaceSky(this)
    // T23.03: the world renderer, under Phaser's canvas, loaded on demand (F10). Described from
    // the map as it stands **when it arrives** — `map_init` may have landed first — and
    // re-described by `onMapInit` after. `loadWorldRenderer` drops it if this scene has shut down meanwhile.
    this.worldRenderer = null
    void loadWorldRenderer(this).then((m) => {
      if (m) this.worldRenderer = m.createGameWorld(this, this.gameMap())
      this.worldRenderer?.setTerrain(this.terrainFields)
      // T23.28: loaded or not, it is known now whether a lit terrain has to be painted before `ready`.
      this.rendererSettled = true
    })
    // §A39 #10: the server has narrated melee, cones, mines and hazards since
    // T11.05 and nothing subscribed. This is the other half.
    this.fx = new OrdnanceFxLayer(this, C().MINE_ARM_TIME)
    // T23.28: last round's mines and clouds are not this round's.
    this.roundReset.register('ordnance', () => {
      const st = this.fx.state
      st.swings.length = 0
      st.jets.length = 0
      st.mines.clear()
      st.hazards.clear()
    })
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
    this.animals = new AnimalLayer(this)
    this.results = new ResultsScreen({
      onPlayAgain: () => this.conn.sendVoteRestart(true),
      // Close the socket, do not merely change scene: the seat stays occupied
      // otherwise and the room never reaps (§B14's shape — quitting that does
      // not quit). A disconnect is how the server already frees a seat
      // (`docs/40` §6); the explicit `leave_room` of §B9 has no client method
      // yet and belongs with T14.06, which owns the quit path and `connection.ts`.
      onExit: () => this.exitToTitle(),
    })
    this.localInput = new LocalInput(this)
    this.crosshair = new Crosshair(this, DEPTH.hud)
    this.buildHud()
    this.feel = new FeelLayer()
    this.radiation = new RadiationFx()
    this.flareFx = new FlareFx(this, hasWebGL(this))
    this.flareFx.setRtt(this.lastRtt)
    this.vortexFx = new VortexFx(this, hasWebGL(this))
    this.blackHoleFx = new BlackHoleFx(this, hasWebGL(this))
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
      // **T22.02: the mirror is told which gravity the match is under, here.**
      // `lobby_state` and not `welcome`: §E6 moved `scale` off `welcome`
      // precisely because a host can still change it, and gravity is the same
      // kind of value. This event reaches a seated player on join whatever the
      // phase, and again on every change, so a mid-match joiner is told too.
      //
      // Without it `apply_input` predicts a low-gravity match at standard
      // gravity and the local body rubber-bands on the first jump — the same
      // class of bug T20.19 and T21.02 each fixed once.
      this.core.setGravity(st.gravity)
      this.gravity = st.gravity
      for (const p of st.players) {
        const had = this.scores.get(p.seat)
        this.scores.set(p.seat, {
          name: p.name || `p${p.seat}`,
          score: had?.score ?? 0,
          deaths: had?.deaths ?? 0,
        })
      }
    })
    this.conn.on('map_init', (p) => this.onMapInit(typeof p === 'string' ? p : ''))
    // T23.28: a restart — the server built a new world and its `map_init` follows. Drop every round's holdings now,
    // before anything of the new round's arrives, and raise the cover until the new map is painted and the round has
    // started (`coverWanted`).
    this.conn.on('new_round', () => {
      this.roundReset.run()
      this.awaitingRound = true
      this.loadCover?.set(true)
    })
    // T23.28: a page hidden while it loads draws no frames, so it would never paint and never say `ready` — and
    // would hold every other player's round until the ready timeout dropped it. Hidden, it has nothing to cover.
    const onVisibility = (): void => this.trySendReady()
    document.addEventListener('visibilitychange', onVisibility)
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => document.removeEventListener('visibilitychange', onVisibility))
    this.conn.on('snapshot', (p) => this.onSnapshot(typeof p === 'string' ? p : ''))
    // T21.32 item 1: the server's answer to "Play again". Only this makes the
    // button read "Voted".
    this.conn.on('vote_counted', (raw) => {
      this.results.voteCounted(asRecord(raw)['counted'] === true)
    })
    this.conn.on('round_state', (raw) => {
      const p = asRecord(raw)
      const before = this.phase
      this.phase = String(p['phase'] ?? 'lobby') as Phase
      // T23.28: the round this map belongs to has started — the cover may lift (once the map is painted).
      if (this.phase === 'warmup' || this.phase === 'playing') this.awaitingRound = false
      // T21.30: the mirror applies the server's input rule for this phase.
      this.core.setPhase(this.phase)
      // **Back to the lobby means back to the title** (T21.32 item 1, `docs/72` §C3:
      // "If it does not [carry], the client returns to the title"). The server
      // said nothing here until T21.32, so this scene held "Round over" forever.
      //
      // Only from a phase a match has. The lobby `round_state` a player is seated
      // with can reach this handler through the latch after `welcome` already
      // said `lobby`, and that one is a handover, not a round ending.
      if (this.phase === 'lobby' && before !== 'lobby') {
        this.exitToTitle()
        return
      }
      // T21.38: how many humans want a rematch, re-announced by the server on
      // every change during `Ended`. Absent in every other phase, which reads null.
      this.results.setTally(parseVoteTally(p['votes']))
      this.timeLeft = Number(p['time_left'] ?? 0)
      const stateTick = Number(p['tick'] ?? this.lastServerTick)
      // T22.12C F5: the bell, off the `Playing` round clock — the core stops the
      // hole's pull on the input seq the server steps in `Ended`, which it learns
      // from the next snapshot (`onSnapshot`). Only `Playing`'s clock ends at the
      // bell; `Ended` keeps the last one (the phase gate already holds there).
      const endsTick = p['ends_tick']
      if (this.phase === 'ended' && before === 'playing') this.endedAtTick = stateTick
      if (this.phase === 'playing' && typeof endsTick === 'number') this.bellEndsTick = endsTick
      else if (this.phase !== 'ended') {
        this.bellEndsTick = null
        this.bellSeq = null
        this.core.setBell(null)
      }
      // A restart hands us a brand-new `World`, so the server's tick and round
      // time both go back to 0 (`Room::restart`). Every clock the client holds
      // is now an anchor to a world that is gone; the next snapshot re-anchors
      // them, but the deadline below is computed *before* it arrives.
      if (stateTick < this.lastServerTick) {
        this.lastServerTick = stateTick
        if (this.phase !== 'playing') {
          this.bellEndsTick = null
          this.bellSeq = null
          this.core.setBell(null)
        }
        // T22.10B: a new world has no holes; the core must stop pulling toward
        // the old ones before the new round's first predicted tick.
        this.mirror.clearVortices()
        this.mirror.clearBlackHole()
        this.mirror.clearCores()
        this.roundTime = 0
        this.serverRoundTime = 0
        this.serverClock.reset()
      }
      // §C25. Converted to a deadline on the server's own clock the moment the
      // phase is announced, because no further `round_state` is coming: the
      // `Ended` branch of `round.rs` emits none.
      // T22.12E F4: from `ends_tick`, the integer the bell reads (one rule).
      this.phaseEndsAt = phaseDeadline(
        this.serverRoundTime,
        this.lastServerTick,
        stateTick,
        typeof endsTick === 'number' ? endsTick : null,
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
        return { item: Number(r['item'] ?? 0), key: String(r['key'] ?? '?'), count: Number(r['count'] ?? 0) }
      })
      const sel = p['selected']
      if (typeof sel === 'number') this.selectedSlot = sel
      this.pushBag()
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
        this.rtt.sample(this.lastRtt)
        this.flareFx?.setRtt(this.lastRtt)
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
        })
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
      // T20.10, same shape a third time. `subscription.test.ts` walks this list
      // against the mirror's handlers, so an omission here is a red test rather
      // than an empty hillside.
      'animal_spawn', 'animal_move', 'animal_despawn',
      'projectile_despawn', 'mask_checksum',
      // §B8. The mirror handles these; this list is what actually subscribes,
      // and a handler with no subscription is the §A39 shape one layer down.
      'tombstone_spawn', 'tombstone_despawn',
      // T22.10B: the vortex list — the mirror keeps it in opening order and tells
      // the core, which sums the pull from it. Unsubscribed, a client predicts no
      // pull near a vortex while the server pulls: a rubber-band.
      'vortex_open', 'vortex_close',
      // T22.12: the black hole — the mirror tells the core, which chains its pull
      // after the vortices; unsubscribed, a client rubber-bands near it. And its
      // telegraph (T22.12C, R93), which only draws.
      'black_hole', 'black_hole_warn',
      // T22.16: a rock's core destroyed — the mirror tells the core, which stops
      // summing that well from the server's seq; unsubscribed, a client keeps
      // predicting a well the server switched off.
      'core_destroyed']) {
      this.conn.on(ev, (raw) => {
        const p = asRecord(raw)
        this.mirror.applyEvent(ev, p, performance.now())
        // T23.14D F8: a thrown weapon leaving a hand throws its figure — the server's word, anyone's.
        if (ev === 'projectile_spawn') this.swingOf(p['owner'], p['weapon'], p['use_seq'])
        // T23.09C F2: where each round left the gun, for its muzzle flash (`WorldView.syncProjectiles`'s `origin`).
        // T23.35: at the gun of the body this client **draws** — the server's point is at its own body, which a moving
        // shooter is drawn up to ~87 px from (`render/muzzle-math.ts::gunOrigin`).
        if (ev === 'projectile_spawn') this.roundOrigins.set(Number(p['id'] ?? -1), this.spawnOrigin(p))
        // T23.14E F4: **the round goes into the ordnance layer as it spawns**, as the sandbox's `noteOrigin` does — not at
        // the next frame's sync. A round that spawns and despawns between two frames (an smg round into rock ~3 ticks;
        // a slow frame holds more) was in the mirror at no sync and never drawn; added now, the layer keeps it for one
        // draw (`OrdnanceState.removeProjectile`).
        // T23.14F F6: the one round this event names, not an O(n) re-sync of every live one.
        if (ev === 'projectile_spawn') {
          const r = this.mirror.projectiles.get(Number(p['id'] ?? -1))
          if (r) this.world?.addRound({ id: r.id, x: r.x, y: r.y, weapon: r.weapon, origin: this.roundOrigins.get(r.id) ?? null })
        }
        if (ev === 'projectile_despawn') this.roundOrigins.delete(Number(p['id'] ?? -1))
        if (ev === 'carve' || ev === 'carve_capsule') {
          this.minimap?.setTerrainDirty()
          // The terrain re-bake needs nothing here: `WorldView.update()` drains the core's dirty set
          // every frame, so it does not matter who carved (the props this once removed retired, T23.07).
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
        // The server's round time on the event's own tick: the last snapshot's,
        // corrected by the tick difference. A live event is a tick or two off the
        // snapshot; one re-sent to a joiner (T22.08D F4, `catch_up_effects`) can be
        // seconds old, and this is what starts it where it really is.
        const evTick = Number(p['tick'] ?? this.lastServerTick)
        const evAt = this.serverRoundTime + (evTick - this.lastServerTick) * C().SIM_DT
        if (ev === 'effect_start') {
          this.topHud?.startEffect(id, String(p['kind'] ?? ''), evAt, Number(p['duration'] ?? 0))
          // §F9. The server calls `HeavyFog::new(now)` on the same tick it emits
          // this, so the round time carried by the last snapshot is the ramp's
          // origin to within one snapshot interval — and the ramp is `FOG_RAMP`
          // (2 s) long, so that lag is invisible.
          this.fog.start(id, rec.kind, this.serverRoundTime)
          // T19.24: same three events, same origin. Lava differs from fog in
          // needing the *seed* as well as the clock — its presentation is a set
          // of places, and the server derived them from this number.
          this.lava.start(id, rec.kind, String(p['seed'] ?? '0'))
          // T22.08B: the flare's ribbon is measured from the tick it was
          // installed on, which is this event's tick — and T22.08D F2: on the
          // **tick clock**, `tick × SIM_DT`, the one `serverClock` estimates. Not
          // `evAt`: that is built on the snapshot's round time (truncated to 0.1 s
          // until T22.14C MED-3; a round clock, not the tick clock, either way).
          this.flareClock.start(id, rec.kind, String(p['seed'] ?? '0'), evTick * C().SIM_DT)
        } else if (ev === 'effect_phase') {
          // T22.14C: anchored on the activation's own tick, and a shower's dropping
          // window (`METEOR_DURATION`, Rust's) so the banner can say when it is clearing.
          const dropFor = rec.kind === 'MeteorShower' ? C().METEOR_DURATION : null
          this.topHud?.setEffectPhase(id, String(p['phase'] ?? 'active') as EffectPhase, evAt, dropFor)
          // T19.24: the vents open here, not at `effect_start`. `lava.rs`
          // re-bases every `jet_until` to the moment it goes active, so this is
          // the only event that names the origin the server is using.
          this.lava.activate(id, String(p['phase'] ?? ''), evAt)
        } else {
          this.topHud?.endEffect(id)
          // Only *this* fog's end clears it — `FogClock` owns that rule.
          this.fog.end(id)
          this.lava.end(id)
          this.flareClock.end(id)
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
      this.swingOf(p['owner'], p['weapon'], p['use_seq'])
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
      // T23.14F: a mine is thrown down — anyone's figure throws it (your own reconciled, `swingOf`).
      this.swingOf(p['owner'], p['weapon'], p['use_seq'])
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
    // T22.10B: one handler for both ways the server moves a player — a pad and a
    // vortex. Before this, neither was handled: a pad trip reached the local body
    // only as a large reconcile error, and a remote glided across the map.
    this.conn.on('teleport', (raw) => this.onRelocated(raw, 'teleport'))
    this.conn.on('vortex_trip', (raw) => this.onRelocated(raw, 'vortex_trip'))
    // T22.12D F3: a dev hook's placement (`DEV_PROBE=1` only) is a relocation too.
    this.conn.on('relocate', (raw) => this.onRelocated(raw, 'relocate'))
    this.conn.on('debug_breach', (raw) => {
      this.observed.lastBreach = raw
    })
    this.conn.on('debug_black_hole', (raw) => {
      this.observed.lastBlackHole = raw
    })
    this.conn.on('debug_place', (raw) => {
      this.observed.lastPlace = raw
    })
    this.conn.on('respawn', (raw) => {
      this.observed.respawns++
      if (Number(asRecord(raw)['id'] ?? -1) === this.me) {
        this.meAlive = true
        this.death.cleared()
        // T23.19D F4: a new body — nothing the old one predicted is waiting.
        this.pendingUses.clear()
      }
    })
    this.conn.on('item_spawn', () => this.observed.itemSpawns++)
    this.conn.on('item_pickup', () => this.observed.itemPickups++)
    this.conn.on('explosion', (raw) => {
      const p = asRecord(raw)
      const x = Number(p['x'] ?? 0)
      const y = Number(p['y'] ?? 0)
      const r = Number(p['r'] ?? 0)
      this.observed.explosions++
      this.world?.ordnance.addImpact(x, y, r, 'blast')
      this.terrainFields?.blast(x, y, r)
      // A meteor is a different, heavier sound from a rocket: the kind is on the
      // event already (`docs/40` §3), so nothing new has to be sent for it.
      const kind = String(p['kind'] ?? '')
      this.audio.spatial(kind === 'meteor' ? 'meteor' : 'explode', x, y, this.ear())
      // Distance-scaled trauma, from the layer that owns trauma (§A24).
      // T99.04: from the view when there is no body (a spectator).
      const me = this.predictor?.state ?? null
      const view = this.world?.rig.center ?? { x, y }
      const at = shakeOrigin(me, view)
      this.world?.rig.shake(traumaFromExplosion(Math.hypot(at.x - x, at.y - y), r) * this.shakeScale)
    })
    // `damage` is scoped to victim and attacker only (docs/40 §3), so receiving
    // one already means it concerns me — no filtering needed here.
    // e2e only (T22.08D F1): the server's own flare clock, on a `DEV_PROBE=1` server.
    this.conn.on('debug_effects', (raw) => {
      for (const f of this.probeWaiters.splice(0)) f(raw)
    })
    this.conn.on('damage', (raw) => {
      const p = asRecord(raw)
      const victim = Number(p['victim'] ?? -1)
      const amount = Number(p['amount'] ?? 0)
      const at = this.predictor?.renderPos ?? { x: 0, y: 0 }
      const x = Number(p['x'] ?? at.x)
      const y = Number(p['y'] ?? at.y)
      if (victim === this.me) this.feel.damageTaken(x, y, amount)
      else this.feel.damageDealt(x, y, amount, false)
      // T23.14: the hit reaction, on whoever was hit (F7 'hit').
      ;(victim === this.me ? this.localView : this.remotes.get(victim)?.view)?.act('hit')
      // T22.08D F3: the server's word that you are burning — scoped to you, so it is
      // yours. During a flare it confirms your flames, or lights them when your own
      // contact test missed. **The flare's own word** (T22.08E F9): a meteor fragment
      // is `cause: weather` too, and during a flare it lit flames on you.
      if (victim === this.me && String(p['effect'] ?? '') === 'SolarFlare') {
        const at = this.serverClock.now(performance.now() / 1000)
        if (at !== null && this.flareClock.query(at) !== null) this.flareFx?.confirm(this.me, at, true)
      }
      this.audio.spatial('hit', x, y, this.ear())
    })
    this.conn.on('death', (raw) => {
      const p = asRecord(raw)
      const victim = Number(p['victim'] ?? -1)
      const attacker = p['attacker'] === null ? undefined : Number(p['attacker'])
      const cause = String(p['cause'] ?? 'player')
      // T23.14F F3: dead from this event, not from the snapshot after it — a use in between swings nothing.
      if (victim === this.me) this.core?.noteDeath(this.me)
      this.observed.deaths.push({
        victim,
        attacker: attacker === undefined ? null : attacker,
        cause,
      })
      const nameOf = (id: number) => this.scores.get(id)?.name ?? `p${id}`
      this.feel.kill({
        victim: nameOf(victim),
        killer: attacker === undefined ? undefined : nameOf(attacker),
        // The allowlist, tested in `killfeed-state.test.ts` (R20): an unlisted
        // cause becomes 'player', which is how `"radiation"` would have read
        // "? → ana (radiation)".
        cause: feedCause(cause, attacker, victim),
        by: String(p['by'] ?? cause),
        involvesYou: victim === this.me || attacker === this.me,
      })
      this.audio.play('death', { volume: victim === this.me ? 1 : 0.5 })

      // §B4. The countdown targets the server's `respawn_at` and is recomputed
      // against the round time in every snapshot, so it cannot drift by the
      // latency of this very event.
      if (victim === this.me) {
        this.meAlive = false
        // T23.19D F4: a dead figure swings nothing more; what it predicted is not waited for.
        this.pendingUses.clear()
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

    // T23.27: a spectator has no body — no fire, no backpack, no slots, no uses (`docs/78` §A1: its commands do nothing,
    // so nothing is sent for them either).
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (this.spectating) return
      if (p.rightButtonDown()) {
        this.toggleBackpack()
        return
      }
      this.useNow(false)
    })
    this.input.keyboard?.on('keydown-F', () => {
      if (!this.spectating) this.useNow(false)
    })

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
        if (this.spectating) return
        this.selectLocal(i)
        this.audio.play('ui_click', { volume: 0.4 })
        this.refreshHud()
      })
    }
    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      if (this.spectating) return
      const n = C().QUICK_SLOTS
      this.selectLocal((this.selectedSlot + (dy > 0 ? 1 : n - 1)) % n)
      this.refreshHud()
    })
    // §C11: `E` is quick-throw now. `use_item` on the selection moves to `G`.
    //
    // Not a doc'd binding — §C10 gives the quick bar `1`-`8` and the wheel and
    // says firing and using act on the selection, without naming a use key, and
    // §C11 takes `E`. Something still has to use a shield generator: heals and
    // batteries left the inventory with §C9, so `use_item` now has exactly one
    // remaining target and no key. `G` is next to it and unbound.
    this.input.keyboard?.on('keydown-G', () => {
      if (!this.spectating) this.conn.sendUseItem(this.selectedSlot)
    })
    // T23.14E F1: through the same predicted path as a fire, so your own throw animates on the frame you press.
    this.input.keyboard?.on('keydown-E', () => {
      if (!this.spectating) this.useNow(true)
    })
    // §C9: `Q` heals, `R` charges. Both slotless and both refused server-side at
    // zero, so the client sends unconditionally — a client-side "do you have
    // one?" would be a second copy of a rule the server already owns, and the
    // two would disagree the first time a pickup was in flight.
    this.input.keyboard?.on('keydown-Q', () => {
      if (!this.spectating) this.conn.sendUseHeal()
    })
    this.input.keyboard?.on('keydown-R', () => {
      if (!this.spectating) this.conn.sendUseBattery()
    })
    // T23.27 (`docs/78` §A1): in spectate, **Tab / Shift+Tab step through the living players** and the scoreboard moves
    // to a held key (`SPECTATE_SCORES_KEY`, named on the spectate line). In a match Tab keeps the scoreboard.
    this.input.keyboard?.on('keydown-TAB', (e: KeyboardEvent) => {
      e.preventDefault()
      if (this.spectating) {
        this.watch.step(this.watchCandidates(), e.shiftKey ? -1 : 1)
        this.observed.watchSteps += 1
      } else {
        this.scoreboardOpen = !this.scoreboardOpen
      }
      this.refreshHud()
    })
    this.input.keyboard?.on(`keydown-${SPECTATE_SCORES_KEY}`, () => {
      if (!this.spectating) return
      this.scoreboardOpen = true
      this.refreshHud()
    })
    this.input.keyboard?.on(`keyup-${SPECTATE_SCORES_KEY}`, () => {
      if (!this.spectating) return
      this.scoreboardOpen = false
      this.refreshHud()
    })

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.roundWatch?.stop()
      this.roundWatch = null
      this.terrainFields?.dispose()
      this.terrainFields = null
      this.conn.close()
      this.audio.stopAll()
      this.results?.destroy()
      this.hud?.remove()
      this.topHud?.destroy()
      this.bars?.destroy()
      this.inventory?.destroy()
      this.escapeMenu?.destroy()
      this.optionsPanel?.destroy()
      this.debugMode?.destroy()
      this.overlay?.destroy()
      this.jetReadout?.remove()
      this.spectateLine?.remove()
      // T21.24, both halves — `WeatherLayer.destroy` is the model. Without the
      // unsubscribe every round leaks a listener, and the next flip of the
      // setting wakes a dead scene's dangling element.
      this.fpsCounter?.remove()
      this.unsubFpsCounter?.()
      this.hideJoinCodeBanner()
      this.feel?.destroy()
      this.radiation?.destroy()
      this.flareFx?.destroy()
      this.minimap?.destroy()
      this.debugHud?.destroy()
      this.world?.destroy()
      this.spaceSky.destroy()
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
    // `deathOverlay.ts` and `MenuScene`'s roster. The
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
      // `?game=1` skips the front end entirely, so there is no lobby to adopt
      // and a plain `join` happens — which is what every check written before
      // the menu expects. The menu path never reaches here.
      // T23.27: `&spectate=1` makes it a spectator's join.
      this.spectating ? { kind: 'spectate' } : undefined,
    )
      this.onWelcome(w)
    } catch (e) {
      this.setStatus(`could not join: ${String(e)}`)
    }
  }

  // ------------------------------------------------------------------ server

  /**
   * Leave the match for the title: "Exit to title", and a round that went back to
   * the lobby (T21.32 item 1). One function, so the two cannot disagree about
   * what leaving is.
   *
   * Close the socket, do not merely change scene: the seat stays occupied
   * otherwise and the room never reaps (§B14's shape — quitting that does not
   * quit). A disconnect is how the server already frees a seat (`docs/40` §6).
   */
  /** The running flare's query at the server's tick clock **now**, or `null` (T22.08D F2). */
  private flareQueryNow(): FlareQuery | null {
    const at = this.serverClock.now(performance.now() / 1000)
    return at === null ? null : this.flareClock.query(at)
  }

  private exitToTitle(): void {
    this.conn.close()
    this.scene.start('Title')
  }

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
    // T21.30: and the mirror is told, for the same reason as in `round_state`.
    this.core.setPhase(this.phase)
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

  /** T23.04: what the world renderer's sky needs of the map in force: size, seed, space-ness. */
  private gameMap(): GameMap {
    // T23.30: the Islands shape's cloud sea, off the map `map_init` installed (`setMapShape`).
    const cloudSea = this.core.meta.shape === 'Islands' ? this.core.height * C().ISLANDS_CLOUD_SEA_FRAC : null
    // T23.31 (docs/78 §A7): the world look `map_init` carries (the server's pick from the seed), or the dev override
    // (`?worldlook=volcanic`) `onMapInit` wrote into the core over it (`adoptWorldLook`).
    return { w: this.core.width, h: this.core.height, seed: this.mapSeed, space: this.onSpaceMap, cloudSea, look: worldLookOfMeta(this.core.meta.look) }
  }

  /**
   * T23.28: is the map in force painted? The lit terrain is the world renderer's, and it paints over frames after the
   * fields install (`TerrainLayer.ready`); until it has, Phaser's flat rock is what shows — the owner's "map with no
   * textures". No renderer (space draws Phaser's rock, `?world=off`, no WebGL2) has nothing to wait for — once its chunk
   * has settled, since before that it is not known which.
   */
  private mapPainted(): boolean {
    return this.ready && this.rendererSettled && !(this.worldRenderer?.terrainSwapPending() ?? false)
  }

  /** T23.28: send `ready` for the map in force, once: when it is painted, or at once on a hidden page (see `create`). */
  private trySendReady(): void {
    if (this.readySent || !this.ready) return
    if (!this.mapPainted() && !document.hidden) return
    this.readySent = true
    this.conn.sendRaw('ready', {})
  }

  /** T23.28: the cover is up until the map is in, painted, `ready` sent, and its round announced. */
  private coverWanted(): boolean {
    return !this.ready || !this.readySent || this.awaitingRound
  }

  private onMapInit(b64: string): void {
    if (!b64) return
    const init = this.mirror.applyMapInitB64(b64)
    // T23.31: the look the server drew this map in (installed by the mirror), or the dev override over it.
    const look = adoptWorldLook(this.core, location.search)

    this.world?.destroy()
    // (Phaser's rock no longer takes the seed or theme — T23.07, the one palette R5's. The lit terrain's albedo
    // does take the seed: a per-map offset, R24 / T23.07B, carried by `TerrainFields` below from `init.seed`.)
    // **Space is read off this map, not off `this.gravity`** (T22.06B F7). A
    // mid-match joiner is sent `map_init` *before* `lobby_state`, so at this line
    // `this.gravity` is whatever the previous match left it (the field outlives a
    // round) and the cave-backdrop lock was decided by the wrong match. The map's
    // own rocks are the same predicate the server gates on (`Map::space_geometry`,
    // R58: non-empty asteroids), and they arrive in this very message.
    const spaceMap = init.asteroids.length > 0
    this.world = new WorldView(this, this.core, undefined, spaceMap)
    // T23.04: the sky is keyed on the generator that made the map (`MapGenerator::to_u8`, off the wire).
    this.onSpaceMap = init.generator === MapGenerator.Space
    this.worldRenderer?.mapChanged(this.gameMap())
    // T23.06: the fields for this map, named by `map_init`'s own fields (T23.05B: its seed is the
    // one that reproduces the map) and computed off the frame; every carve the terrain hears of reaches them.
    this.terrainFields?.dispose()
    const seedLo = Number(init.seed & 0xffffffffn) >>> 0
    const seedHi = Number((init.seed >> 32n) & 0xffffffffn) >>> 0
    // T23.15: the theme is read here and nowhere else in the client — as simulation, not look (R5): it picks the
    // objects stamped into the collision mask, so the landform the fields are derived from needs it to be the server's.
    // T23.31: the look last — the relief's boulder threshold is the look's (`render_fields.rs::boulder_min_id`).
    const fields = new TerrainFields(this.core, [seedLo, seedHi, init.scale, init.generator, init.theme, init.shape, worldLookByte(look)])
    this.terrainFields = fields
    this.world.terrain.onDirty = (ids) => fields.noteDirtyChunks(ids)
    this.worldRenderer?.setTerrain(fields)

    // T22.06's space backdrop, seeded off the same wire seed (the ground sky's seed goes in above).
    this.spaceSky.setSeed(this.mapSeed)

    // §C5. Built from the wire rather than from `core.meta`: a networked client
    // never runs the generator, so `core.meta.teleport_pads` is empty here and a
    // renderer reading it would draw nothing while looking correct.
    this.padViews = init.pads.map((p, i) => ({ id: i, x: p.x, y: p.y }))
    this.world.pads.build(this.padViews, imagePortal(GATE_KEY))
    // T23.09: the gates are static lights, placed once per map.
    this.effectLights.statics.set([...gateLights(this.padViews), ...(spaceMap ? [] : crystalLights(init.objects))])
    // T21.11's platforms, rebuilt from the wire beside the pads. The index is
    // the id on both sides — `map_init` does not send one (§B16: two registries
    // assumed a positional relationship without asserting it and a laser
    // resolved as a bazooka).
    this.platformViews = init.platforms.map((p, i) => ({ id: i, x: p.x, y: p.y }))
    this.world.platforms.build(this.platformViews)
    // T23.19A/T23.19: gates, turrets, pickups and labels, graves and animals are the world renderer's, behind the
    // figures, whenever it draws this scene — each layer follows the drawer's own flag (`fx/feed.ts::followWorldDraws`,
    // T23.19D F1); space, `?world=off` and no WebGL2 keep Phaser's. The turrets face into the map.
    this.world.platforms.setMapWidth(this.core.width)
    // T23.19 (R5): the stamped crystals keep F's glow and light — drawn over their rock, lit beside the gates.
    this.leaveCrystals()
    this.leaveCrystals = spaceMap ? () => {} : joinCrystals(this, init.objects, () => true)

    // §D6's objects are stamped into the mask (collision, R5) and drawn as rock since T23.07 — the atlas
    // art retired (R15). Kept for the debug handle: what `map_init` carried.
    this.mapObjects = init.objects
    // The item layer lives in the shared stack (§C0), so its registry is set
    // here rather than in `create` — there is no layer before there is a world.
    this.world.items.setRegistry(this.core.itemRegistryJson())

    // Seat the local body so prediction has something to move. The server owns
    // the real position and the first snapshot corrects it; this only avoids a
    // frame with no player in it.
    const spawn = this.core.meta.spawn_points[0] ?? { x: this.core.width / 2, y: 0 }
    this.core.removePlayer(this.me)
    if (this.spectating) {
      // T23.27: no body — nothing for prediction to move, and no ghost for local rounds to hit or for the night view
      // to centre on. The camera starts at the spawn and follows the watched player from the first snapshot.
      this.predictor = null
      this.localView?.destroy()
      this.localView = null
      this.crosshair.setVisible(false)
    } else {
      this.core.addPlayer(this.me, spawn.x, spawn.y - C().PLAYER_H / 2)
      this.predictor = new Predictor(this.core, this.me)
      // T23.14E F2: the predicted player's bag is the server's (an `inventory` event may have beaten the map).
      this.pushBag()

      this.buildLocalView()
    }

    this.world.rig.follow(spawn)
    this.world.rig.snapTo(spawn)
    this.world.flush(spawn)

    this.minimap?.destroy()
    this.minimap = new Minimap(this.core, this.core.width, this.core.height)

    // T22.10B: a vortex list that arrived before this map is applied now — the
    // mirror kept it (a resync does not drop it); the core is told again.
    this.mirror.pushVortices()
    this.mirror.pushBlackHole()

    this.ready = true
    // T23.28: **`ready` once this map is painted**, not on decode (`trySendReady`, from `update`): the server starts
    // the round on every body's, so a round never starts on a screen still showing an untextured map. A first round's
    // map arrives in `lobby` and waits for its announcement too; a restart's was flagged by `new_round`. A resync's
    // (mid-round) waits for neither.
    this.readySent = false
    if (this.phase === 'lobby') this.awaitingRound = true
    this.trySendReady()
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
    // T22.14C MED-3: exact on the wire now, and never stepped back by a late snapshot —
    // the extrapolated clock was reset to every snapshot's (truncated) time, so it
    // jumped back up to a tenth of a second and the death countdown read over the delay.
    this.roundTime = roundClockOnSnapshot(this.roundTime, s.roundTime, this.serverRoundTime, C().MAX_FRAME_DT)
    this.serverRoundTime = s.roundTime
    // The overlay's visibility follows the **server's** alive flag rather than
    // the countdown reaching zero, so a respawn that lands early or late is
    // still what closes it (§B4).
    // (`meAlive` is read off the viewed row below — T23.27C F9: in spectate it is the watched player's.)
    this.serverDarkness = s.darkness
    if (s.darkness < this.observed.darknessMin) this.observed.darknessMin = s.darkness
    if (s.darkness > this.observed.darknessMax) this.observed.darknessMax = s.darkness
    this.clock.addSample(s.roundTime * 1000, now, this.lastRtt)
    // T22.08D F2: the tick, exact, plus the trip — the flare's clock.
    this.serverClock.sample(s.tick * C().SIM_DT, this.lastRtt / 1000, now / 1000)
    // T22.08D F3: a remote whose health drops while a flare runs has the server's
    // word behind its flames — the only per-player word a client gets about anyone
    // else (`FlareFx`'s doc says what it cannot rule out).
    const flareAt = this.serverClock.now(now / 1000)
    const flaring = flareAt !== null && this.flareClock.query(flareAt) !== null
    for (const p of s.players) {
      if (p.id === this.me) continue
      const was = this.remoteHealth.get(p.id)
      if (flaring && flareAt !== null && was !== undefined && p.health < was) this.flareFx?.confirm(p.id, flareAt, false)
      this.remoteHealth.set(p.id, p.health)
    }
    this.interp.push(
      s.tick,
      now,
      s.players.filter((p) => p.id !== this.me),
    )

    // T23.27 (`docs/78` §A1): in spectate the HUD's numbers are **the watched player's** — the same fields, off their
    // row (every player's health, fuel, battery, flags and vision are on the wire; ammo is not, so the HUD names the
    // weapon only). Whom to watch is decided first, on this snapshot.
    if (this.spectating) this.watch.update(this.watchCandidates(s.players), now)
    const mine = s.players.find((p) => p.id === this.viewId())
    if (mine) {
      // T23.27C F9: alive off the **same** row as every other number here. It came off `this.me`'s row alone, which a
      // spectator never has, so it stayed `true` while `irradiated`, `health` and `vision` followed the watched player:
      // the radiation feedback (`irradiated && meAlive`) went on through that player's death.
      this.meAlive = flag(mine.flags, FLAG.alive)
      this.serverPos = { x: mine.x, y: mine.y }
      this.health = mine.health
      // §C26. **Already in fuel units.** `codec.ts` dequantises the wire byte
      // when it decodes the snapshot, so `jetpackFuel` is 0..JETPACK_MAX_FUEL
      // here and dividing by 255 again would be the second half of a conversion
      // that has already happened.
      this.fuel = mine.jetpackFuel
      // Also already dequantised by `codec.ts`, for the same reason (§A24).
      this.battery = mine.battery
      // T23.14E F2: an energy weapon's use spends it — the predicted use (`Core.predictUse`) must see the server's.
      if (!this.spectating) this.core?.setBattery(this.me, mine.battery)
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
      // T22.09B. Bit 7 had no reader, which is T21.25's finding exactly: a
      // health bar drifting down for no visible reason.
      this.irradiated = flag(mine.flags, FLAG.irradiated)
      // §T20.07. `FLAG.flashlight` had **no production reader at all** — it was
      // written by the server, exported by `codec.ts` and consumed only by two
      // tests, which is why the flashlight did nothing in a real game.
      this.hasFlashlight = flag(mine.flags, FLAG.flashlight)
      // T21.02. **Drawing only** — the simulation half reaches the mirror
      // through `reconcile` below, which is the path that already carries
      // everything `applyInput` reads. This field exists because `localView` is
      // drawn from the scene and not from the snapshot.
      this.hasBoots = flag(mine.moveMods, MOVE_MOD.boots)
      // T21.34. Drawing and the HUD only, for the boots' reason: the wings on
      // your own body, and the jet bar and readout shown as refused.
      this.hasWings = flag(mine.moveMods, MOVE_MOD.wings)
      // Authoritative, because smoke is positional: what you can see depends on
      // which cloud you are standing in. This replaced a hardcoded 1, which is
      // why heavy fog changed nothing in the real game for four milestones.
      this.vision = mine.vision
    } else if (this.spectating) {
      // T23.27C F9: nobody to watch (`viewId()` is -1: no one alive) — the bars go blank rather than keep the last
      // player's numbers.
      this.meAlive = false
      this.health = 0
      this.fuel = 0
      this.battery = 0
      this.heals = 0
      this.batteries = 0
      this.teleportCharge = 0
      this.shieldOn = false
      this.poisoned = false
      this.irradiated = false
    }
    if (mine && this.predictor) {
      // T22.12C F5: before the reconcile replays, so a replayed input past the bell
      // is stepped as the server stepped it (T22.14C MED-2: no buttons, no pull).
      // T22.14C LOW-4/5: this snapshot's seq ↔ tick anchor (`seqClock.ts`, the one
      // mapping) re-keys the bell and the vortices' and hole's switch-overs.
      const anchor = { ack: s.lastInputSeq, tick: s.tick }
      if (this.bellEndsTick !== null) {
        this.bellSeq = firstSeqAfter(this.bellEndsTick, anchor)
        this.core.setBell(this.bellSeq)
      }
      this.mirror.anchorSeqs(this.core.acceptsInput() && s.lastInputSeq > 0 ? anchor : null)
      const corrections = this.predictor.stats.corrections
      this.predictor.reconcile({
        // T22.10E F-3: the results screen's reconciliation keys on the tick.
        tick: s.tick,
        lastInputSeq: s.lastInputSeq,
        // T22.14D F1: what the server stepped at the ack — the correction's previous input.
        steppedButtons: s.steppedButtons,
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
          // T20.19. `apply_input` scales the walk target by
          // `speed_multiplier()`, which is a function of health — so a snapshot
          // that carried position but not health left the mirror predicting a
          // hurt player up to 25 % fast, past `RECONCILE_EPSILON_PX` within a
          // couple of frames, on every frame they moved. It could not
          // self-correct either: the correction itself did not carry health.
          health: mine.health,
          // T20.21. `apply_input` refuses to move a dead body, exactly as
          // `apply_inputs` does — but only if it is told. This flag has been on
          // the wire since M6 (bit 0) and this scene already reads it for the
          // death overlay; it simply never reached the mirror, so a dead player
          // holding a direction was predicted walking at full speed.
          alive: flag(mine.flags, FLAG.alive),
          // T21.02. `applyInput` scales the walk target and the jump launch by
          // what the player is carrying, so the mirror has to be told — the
          // same rule health and `alive` are here for, and the third value to
          // need it. `reconcile` applies it before its positional epsilon can
          // gate it; see the comment there.
          moveMods: mine.moveMods,
        },
      })
      if (this.predictor.stats.corrections !== corrections) {
        // T23.14E F7: **the replay's steps, observed.** The landing cue watches every step this client takes
        // (`LandingLatch`), but a correction re-steps from the ack unseen — a landing it moves into the past was heard
        // late at the floor, or not at all. The replay's first landing (with its impact) and where the body now is.
        const r = this.core.landingSince(this.me, s.lastInputSeq, flag(mine.flags, FLAG.grounded))
        this.landing.observe(r.grounded, r.impact ?? 0)
        if (r.impact !== null) this.observed.replayLandings += 1
      }
    }
  }

  /**
   * The server moved player `id` to `(x, y)` at `tick` — a pad (`teleport`) or a
   * breach vortex (`vortex_trip`), or a dev hook (`relocate`, T22.12D F3). **One
   * handler for all three** (T22.10B): the arrival is the same event with three
   * sources. You: the predictor snaps (sim and render). Anyone else: their
   * interpolation steps across the trip instead of gliding through the map for a
   * snapshot interval.
   */
  private onRelocated(raw: unknown, ev: 'teleport' | 'vortex_trip' | 'relocate'): void {
    const p = asRecord(raw)
    const id = Number(p['id'] ?? -1)
    const x = Number(p['x'])
    const y = Number(p['y'])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    if (ev === 'vortex_trip') this.observed.vortexTrips++
    else if (ev === 'teleport') this.observed.teleports++
    else this.observed.relocations++
    if (id === this.me) {
      if (ev === 'relocate' && Number.isFinite(Number(p['tick']))) this.observed.myRelocateTick = Number(p['tick'])
      const snapped = this.predictor?.relocate(x, y, Number(p['tick'] ?? Number.NaN)) ?? false
      if (ev === 'vortex_trip') this.observed.myTrips.push({ x, y, snapped })
    } else {
      this.interp.cut(id, Number(p['tick'] ?? this.lastServerTick))
      // T23.14E F6: the jump is no push — the estimate starts afresh after it.
      this.remotePushes.get(id)?.reset()
    }
  }

  /**
   * T23.35: a `projectile_spawn`'s first point — on the owner's **drawn** gun when it left his gun (`muzzleDir`), which
   * `anchorMuzzles` then keeps it on for its flash's frames; else the server's point.
   */
  private spawnOrigin(p: Record<string, unknown>): Pt {
    const spawn = { x: Number(p['x'] ?? 0), y: Number(p['y'] ?? 0) }
    const owner = Number(p['owner'] ?? -1)
    const vel = { x: Number(p['vx'] ?? 0), y: Number(p['vy'] ?? 0) }
    const dir = muzzleDir(spawn, vel, this.mirror.players.get(owner) ?? null, C().MUZZLE_OFFSET, C().PLAYER_H)
    if (!dir) return spawn
    this.gunRounds.set(Number(p['id'] ?? -1), { owner, dir, frames: 0 })
    const drawn = this.drawnCentre(owner)
    return drawn ? gunAt(drawn, dir, C().MUZZLE_OFFSET) : spawn
  }

  /** T23.35: a player's drawn body centre, or `null` when it is not drawn (a hidden container is not moved). */
  private drawnCentre(id: number): Pt | null {
    const view = id === this.me ? this.localView : this.remotes.get(id)?.view
    return view?.container.visible ? { x: view.container.x, y: view.container.y - C().PLAYER_H / 2 } : null
  }

  /**
   * T23.35: each fresh round's first point (its muzzle flash) onto its shooter's gun **as drawn this frame**, for the
   * `MUZZLE_FRAMES` frames the flash is listed — a point fixed where the gun was when the event arrived was left behind
   * by a falling body (163 px measured at a hitch). Called once the bodies and the rounds are placed, before the lights.
   */
  private anchorMuzzles(): void {
    for (const [id, g] of this.gunRounds) {
      const drawn = this.drawnCentre(g.owner)
      if (drawn) {
        const at = gunAt(drawn, g.dir, C().MUZZLE_OFFSET)
        this.world?.anchorRound(id, at.x, at.y)
      }
      if (++g.frames >= MUZZLE_FRAMES) this.gunRounds.delete(id)
    }
  }

  /** The mirror's live rounds, each with its `roundOrigins` entry — or `null`: this client never heard it spawn. */
  private *withOrigins(): Iterable<{ id: number; x: number; y: number; weapon: number; origin: { x: number; y: number } | null }> {
    for (const p of this.mirror.projectiles.values()) yield { id: p.id, x: p.x, y: p.y, weapon: p.weapon, origin: this.roundOrigins.get(p.id) ?? null }
  }

  /**
   * T23.14D F8: a **remote's** figure swings or throws `weapon` (`WEAPON_KEYS` id) on the server's `melee`,
   * `projectile_spawn` and (T23.14F) `mine_placed`, which every client receives. A gun changes nothing (`firedWith`).
   *
   * **Your own** plays when your predicted use takes (`useNow`, T23.14E); its echo lands here and is reconciled
   * (T23.14F F2, `PendingUses`): an echo a prediction was waiting for plays nothing (it would restart the swing); an
   * echo **no** prediction was waiting for — a use the mirror refused and the server took — swings now, late.
   * Paired by the seq the use was sent under (`useSeq`, the server's `use_seq` — T23.19D F4).
   */
  private swingOf(owner: unknown, weapon: unknown, useSeq: unknown = null): void {
    if (typeof owner !== 'number' || typeof weapon !== 'number') return
    const key = WEAPON_KEYS[weapon]
    if (owner === this.me) {
      if (key && this.pendingUses.echo(key, typeof useSeq === 'number' ? useSeq : null, performance.now())) {
        this.localView?.firedWith(key)
        this.observed.localSwings += 1
      }
      return
    }
    this.remotes.get(owner)?.view.firedWith(key)
  }

  /**
   * The server's bag, installed in the predicted player (`Core.setBag`) — on every `inventory` event and when the
   * map seats the local body (an event can beat the map).
   */
  private pushBag(): void {
    if (!this.core || this.slots.length === 0) return
    this.core.setBag(
      this.me,
      this.slots.map((sl) => sl?.item ?? 0),
      this.slots.map((sl) => sl?.count ?? 0),
      this.selectedSlot,
    )
  }

  /**
   * Send one use — a fire (the click, `F`, a held weapon's repeat, the e2e hook) or §C11's quick-throw (`E`) — and,
   * T23.14E F2, swing the local figure **on this frame when the predicted player takes it**: `Core.predictUse` runs the
   * server's own checks in its order (`World::fire` / `World::quick_throw` → `PlayerState::try_fire_slot`) on the
   * predicted `PlayerState` — round, rider, alive, kind, the one per-player cooldown, stock, energy — and returns the
   * item it used. No round trip, and no TypeScript copy of the rules (T23.09D's `input/localSwing.ts`, retired).
   */
  /**
   * Select a quick-bar slot: sent, and (T23.14E F2) selected in the predicted player at once — the server runs
   * `select_slot` then a following `fire` in arrival order, so a use right after this is of the new selection.
   */
  private selectLocal(slot: number): void {
    this.selectedSlot = slot
    this.conn.sendSelectSlot(slot)
    this.core?.selectSlot(this.me, slot)
  }

  private useNow(quick: boolean): void {
    // T23.19D F4: sent under the current input seq, which the server echoes on what the use produces.
    const seq = this.seq
    if (quick) this.conn.sendQuickThrow(seq)
    else this.conn.sendFire(seq)
    const now = performance.now()
    // The mirror's cooldown runs on this page's clock (`now`), not the server's tick time: the server stamps a use
    // with its time *on arrival*, which no client clock predicts (jitter bunches or spreads two sends either way), so
    // a seq-derived clock would be the same guess. What the clocks disagree on, `PendingUses` reconciles (T23.14F F2).
    const key = this.core?.predictUse(this.me, quick, now / 1000) ?? null
    this.observed.uses += 1
    this.observed.lastUse = { quick, key }
    if (key) {
      this.localView?.firedWith(key)
      this.pendingUses.predicted(key, seq, now)
      if (swingsKey(key)) this.observed.localSwings += 1
    }
  }

  private dropRemote(id: number): void {
    const r = this.remotes.get(id)
    if (r) {
      r.view.destroy()
      this.remotes.delete(id)
    }
    this.remoteTilts.delete(id)
    this.remotePushes.delete(id)
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
  private movementCues(
    dt: number,
    body: { vx: number; grounded: boolean; moveState: number; landingImpact: number },
  ): void {
    const jetting = body.moveState === 2
    if (jetting !== this.wasJetting) {
      this.audio.hold('jetpack', jetting, 0.35)
      this.wasJetting = jetting
    }

    const landed = this.landing.take()
    if (landed !== null) {
      // Land, scaled by how hard: a step off a ledge and a fall from a jetpack
      // burn should not sound the same.
      // **`landingImpact`, not `vy`** (T20.11). `move_y` zeroes the velocity
      // *before* it marks the body grounded, so on this exact frame `vy` is 0 —
      // this expression has evaluated to the constant 0.25 floor since M6, and
      // the comment above it described something that could not happen. The
      // impact speed is measured inside `integrate`, where it still exists.
      // T23.09D: the impact of the step that landed (`LandingLatch`), not the frame's last step's.
      const force = landingVolume(landed, C().MAX_FALL_SPEED)
      this.audio.play('land', { volume: force })
      this.observed.landVolumes.push(force)
      if (this.observed.landVolumes.length > 8) this.observed.landVolumes.shift()
      this.stepAcc = 0
    }

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
        if (Number(p['owner'] ?? -1) === this.me) this.observed.ownProjectileSpawns += 1
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
    return this.predictor?.renderPos ?? this.viewAt ?? this.world?.rig.center ?? { x: 0, y: 0 }
  }

  /** T23.27: whose numbers the HUD shows and whose place the view is — yours, or in spectate the watched player's. */
  private viewId(): number {
    return this.spectating ? (this.watch.watching ?? -1) : this.me
  }

  /** T23.27: who can be watched — every player but this seat (a spectator is never in a snapshot anyway). */
  private watchCandidates(players: Iterable<{ id: number; flags: number }> = this.mirror.players.values()): WatchCandidate[] {
    return [...players].filter((p) => p.id !== this.me).map((p) => ({ id: p.id, alive: flag(p.flags, FLAG.alive) }))
  }

  /**
   * T23.27: **the viewpoint** — the local body's drawn place (the predictor's), or in spectate the watched player's
   * interpolated sample, which is where `renderRemotes` draws them. `null` before there is one; callers keep the last.
   */
  private viewer(sampled: ReadonlyMap<number, InterpolatedPlayer>): { x: number; y: number } | null {
    if (!this.spectating) return this.predictor?.renderPos ?? null
    const w = this.watch.watching === null ? undefined : sampled.get(this.watch.watching)
    return w ? { x: w.x, y: w.y } : null
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
    // T21.43: a rider's trigger fires the platform, so the repeat follows it.
    // Mounted is the **server's** word, off the snapshot — the same field
    // `debug().mount.mounted` reads — so a mount the server refused cannot
    // start a stream here.
    const mine = this.mirror.players.get(this.me)
    const mounted = mine ? flag(mine.moveMods, MOVE_MOD.mounted) : false
    // An empty stack stops the repeat here as well as at the server, so a
    // player holding the button on a spent weapon is not sending refused
    // requests at the weapon's cadence for as long as they hold it.
    const source = repeatSource(
      mounted,
      { weapon: profile, count: sel?.count ?? 0 },
      C().GUN_PLATFORM_FIRE_INTERVAL,
    )
    const shots = this.repeatFire.update({ dt, held, ...source })
    for (let i = 0; i < shots; i++) this.useNow(false)
  }

  override update(_time: number, delta: number): void {
    // §C12's FPS counter, from real frame timestamps and not from Phaser's
    // smoothed average (§A38). Sampled every frame whether or not the mode is on,
    // so switching it on reports the rate you already had rather than starting a
    // fresh window that reads 0 for half a second.
    this.debugMode?.update(_time)
    // T23.14F F6: behind the dev surface, so the busy-wait folds out of the production bundle.
    if (devSurface() && this.slowFrameMs > 0) {
      // T23.14E F4, e2e only: hold this frame — the server's events queue behind it, as behind a loaded box's frame.
      const end = performance.now() + this.slowFrameMs
      while (performance.now() < end) {
        // spin: the frame is held
      }
      this.observed.slowFrames += 1
    }
    // T21.24's player-facing counter. **Sampled every frame, written four times
    // a second** (`FPS_READOUT_INTERVAL`). Sampling unconditionally is what makes
    // switching it on report the rate you already had, rather than a fresh empty
    // window that reads 0 until it fills.
    //
    // Above the `ready` guard with the debug meter: a client still waiting for
    // its world is exactly when a player wants to know whether frames are being
    // produced at all.
    this.playerFps.sample(_time)
    this.fpsTextDue -= delta / 1000
    if (isFpsCounter() && this.fpsTextDue <= 0) {
      this.fpsTextDue = FPS_READOUT_INTERVAL
      this.writeFpsCounter()
    }
    // T23.28: the load handshake and its cover, above the `ready` guard — the cover is up exactly while that guard holds.
    this.trySendReady()
    this.loadCover?.set(this.coverWanted())
    if (!this.ready) return
    const dt = delta / 1000
    if (!this.ready || !this.world) return
    // T23.27: a spectator has no predictor (no body) — it steps and sends no input; the rest of the frame runs for it.
    const predictor = this.predictor
    if (!predictor && !this.spectating) return

    if (predictor) {
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
      // **Real time, not Phaser's `delta`** (T22.10F). Phaser smooths `delta` and
      // clamps it to one 60 Hz frame whenever the page is not focused (and for the
      // first `panicMax` frames): an unfocused tab at 15 fps reported 16.7 ms a frame
      // and stepped one input where 60 ms had passed. That used to cost only speed —
      // the server ran whatever arrived — but since R89 the server steps every player
      // every tick, standing in for inputs that have not come; a client simulating
      // slower than real time then disagrees with every stand-in and its seqs fall
      // ever further behind the server's. The fixed step's clock is the wall clock;
      // `MAX_FRAME_DT` still caps one frame.
      // **The first frame starts the clock at zero** (T22.10G). It took the frame's `dt`
      // (Phaser's first delta is the scene's whole boot): a first burst of 14–15 inputs,
      // which the server's jitter buffer trimmed to its lead — 11 dropped, a 63.7 px
      // correction in the T22.10F review. The server now waits out the lead on the
      // first input itself; this client need only start sending one a tick.
      const wall = performance.now()
      const elapsed = this.stepClockAt === null ? 0 : (wall - this.stepClockAt) / 1000
      this.stepClockAt = wall
      this.acc = Math.min(this.acc + elapsed, MAX_FRAME_DT)
      const batch = []
      while (this.acc >= step) {
        const body = this.core.playerState(this.me)
        const centre = body ? { x: body.x, y: body.y } : this.world.rig.center
        const input = this.localInput.sample(++this.seq, centre, this.cameras.main)
        predictor.pushInput(input, step)
        const after = this.core.playerState(this.me)
        if (after) this.landing.observe(after.grounded, after.landingImpact)
        batch.push(input)
        this.acc -= step
      }
      // **No redundancy: each input is sent once** (T22.10D F5 — this said "the last
      // few inputs go with every packet, so a dropped one costs nothing", `docs/40`
      // §2, and it has been false since T22.10B). The transport is TCP (socket.io,
      // no volatile emits), so a packet is never dropped, only late; what the
      // packets must do is carry *every* input of the frame, in order.
      //
      // Not while the results screen is up: the server drops every input in `Ended`
      // and steps a neutral tick (T21.30, `World::apply_inputs`), so there is nothing
      // it would use. (T22.14C LOW-7: this said the server kept accepting input there
      // and queued a burst for the next round — false since T21.30.)
      //
      // **Every input this frame is sent, in packets of at most `INPUT_REDUNDANCY`**
      // (T22.10B; `codec.ts::inputPackets` since T22.10D, so it has a test) — the
      // most `decode_input_batch` takes. This sent only the last
      // three, so a frame that stepped four or more ticks (a 15–20 fps page, which is
      // what a headless browser drawing the vortex shader runs at) applied an input
      // locally that the server never received: the server acked past it without
      // integrating it, and the predictor snapped back by a tick of travel on every
      // such snapshot — 4–12 px under a vortex's pull, measured by `breach-vortex`
      // off `lastAckErrorPx` (ack deltas +4/+2 alternating, the big errors on the +4s).
      if (batch.length && !this.results.isUp) {
        for (const packet of inputPackets(batch, C().INPUT_REDUNDANCY)) this.conn.sendInput(packet)
        this.inputsSent++
        this.debugHud?.noteInputs(performance.now(), batch.length)
      }
    }

    // One tiny echo a second is enough to keep the estimate current without
    // adding meaningful traffic.
    this.rttAcc += dt
    if (this.rttAcc >= 1) {
      this.rttAcc = 0
      this.conn.sendRaw('ping_rtt', String(performance.now()))
    }

    predictor?.updateRender(dt)
    this.roundTime += dt
    this.frameDt = dt

    const body = this.core.playerState(this.me)
    // T23.27: the viewpoint (`viewer`) — the predictor's drawn place, as it always was, or in spectate the watched
    // player's, off the same sample of the remotes `renderRemotes` draws below.
    const sampleAt = performance.now()
    const sampled = this.interp.sample(sampleAt)
    this.viewAt = this.viewer(sampled) ?? this.viewAt
    const rp = this.viewAt ?? this.world.rig.center
    if (body && this.localView) {
      const aim = dequantizeAngle(
        this.localInput.sample(this.seq, { x: body.x, y: body.y }, this.cameras.main).aim,
      )
      // T22.19 (R107): feet along the pull at the drawn position; upright when dead or
      // where nothing pulls. Visual only — the aim above is sampled in screen space.
      // T22.19B: the wells alone (the hole and a vortex do not stand anyone), and a
      // relocation (a pad, a trip, a respawn) snaps the tilt to the new spot's.
      const pull = this.meAlive ? this.core.standPullAt(rp.x, rp.y, body.moveMods) : null
      this.localTrack = trackTilt(this.localTrack, rp.x, rp.y, body.vx, body.vy, pull ? standTarget(pull[0]!, pull[1]!) : null, dt)
      // T22.19B F6: the name tag, off the lobby's names — it had no caller before.
      this.localView.setName(this.scores.get(this.me)?.name ?? '')
      this.localView.setWeapon(this.slots[this.selectedSlot]?.key ?? '')
      this.localView.setState(rp.x, rp.y, body.vx, body.vy, aim, {
        tilt: this.localTilt,
        // T23.14D F8: the server's word (§B4) — your own body draws the dead pose. It was the literal `true`.
        alive: this.meAlive,
        grounded: body.grounded,
        // `&& meAlive` for T22.04: `alive` above is a literal, and the mirror
        // stops stepping a dead player, so without it a body killed mid-burn
        // would go on drawing its jet flame until the respawn.
        jetpack: body.moveState === 2 && this.meAlive,
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
        // T21.02, and **not a literal** — that is the shape T20.08 found here
        // with `shield: false`, where the one player who needed to see their own
        // state was the one who could not. It comes off the same byte every
        // remote's boots come off.
        boots: this.hasBoots,
        wings: this.hasWings,
        space: this.gravity === SPACE_GRAVITY,
        // T22.04C: the push the mirror stepped with (the predictor's replay included),
        // so braking draws the exhaust on the side the push comes from.
        thrust: this.core.thrustAt(this.me),
        thrustMax: this.core.fullThrust(),
      })
      this.crosshair.update(rp.x, rp.y, aim)
      this.crosshairAt = { x: rp.x + Math.cos(aim) * C().AIM_RADIUS, y: rp.y + Math.sin(aim) * C().AIM_RADIUS }
      // `watchPoint` is an e2e affordance, and only that (§C2). A supply crate
      // lands wherever the schedule puts it, which is usually several hundred px
      // off camera — so a screenshot named `crate-falling.png` reliably contained
      // no crate, and a check that cannot photograph its subject cannot tell a
      // parachute that draws from one that does not. Rendering is world-space, so
      // what this frames is exactly what a player standing there would see.
      this.world.rig.follow(this.watchPoint ?? { x: rp.x, y: rp.y })
      this.movementCues(dt, body)
    }
    // T23.27: a spectator's camera follows the watched player (no body of its own to lead the rig).
    if (this.spectating && this.viewAt) this.world.rig.follow(this.watchPoint ?? this.viewAt)
    // T99.04: a framed point holds whatever else is (or is not) followed. A spectator watching nobody kept its last
    // target, and every frame the rig lerped the snapped view back toward it — a directed shot sat 340 px off its mark.
    if (this.watchPoint) this.world.rig.follow(this.watchPoint)
    this.world.rig.update(dt)

    this.renderRemotes(sampleAt, sampled)

    // Darkness from round time locally, corrected by the server's byte so the
    // two never drift apart (`docs/14` §1) — and none at all in space (T22.06).
    const space = this.gravity === SPACE_GRAVITY
    const darkness = sceneDarkness(space, this.serverDarkness, this.roundTime, C().NIGHT_DARKNESS)
    this.drawnDarkness = darkness
    // T23.19D F2: what the furniture's night halo fades with.
    fxFeed(this).night = darkness / C().NIGHT_DARKNESS
    // T23.11 (R7): the world's palette is F1's night and F5's moonlit day blended by the same darkness, the moons
    // where the round's clock puts them. Only the picture: `phase_change` and its audio are untouched.
    this.worldRenderer?.setDaylight(nightShare(darkness, C().NIGHT_DARKNESS), cycleU(this.roundTime))
    // T23.04: the space backdrop is up exactly on a space map — derived per frame, no latch —
    // and placed after the rig moved the camera (above).
    if (this.spaceSky.isShown !== this.onSpaceMap) this.spaceSky.setShown(this.onSpaceMap)
    this.spaceSky.update(this.roundTime)

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
    // T23.09C F2: each round with where it left the gun — `null` for one whose spawn this client never heard (in flight
    // before it joined, or across a resync), which then flashes no muzzle.
    this.world?.syncProjectiles(this.withOrigins())
    this.anchorMuzzles()
    // Toxic rain is on while any recorded effect is in its active phase. The
    // lifecycle is already tracked for the e2e; nothing consumed it visually,
    // which is §B21 exactly — the number was right and never reached the screen.
    // T19.24: derived once per frame and **outside the `world` guard**, so a
    // frame with no world leaves it empty rather than leaving last frame's vents
    // standing in the light list below.
    this.vents = this.ventsNow()
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
        // T19.24: **the vents the server chose**, derived from the seed it
        // broadcast on `effect_start`. This was a hardcoded `[]`, so a networked
        // client drew no vent, no mouth and no ember — and emitted no light
        // during the jet, the only phase that damages you. The sandbox rendered
        // all of it; nobody plays in the sandbox.
        //
        // Read into `this.vents` once per frame rather than called twice: the
        // light list below needs the same answer, and two calls are two JSON
        // round trips through wasm for a value that cannot change inside a frame.
        vents: this.vents,
        fallScale: C().MAX_FALL_SPEED,
        fog: this.fog.strength(this.roundTime),
        hasFlashlight: this.hasFlashlight,
        // (T21.26's ambient rain retired with the clouds it fell from — T23.04.)
      })
      // T23.07: Phaser's rock only while the lit terrain does not draw it (never absent).
      this.world.setRockVisible(!(this.worldRenderer?.terrainReady() ?? false))
    }
    // Mine visibility is distance to the *player*, not to the camera centre —
    // the camera leads the aim, so those are not the same point.
    this.fx.update(dt, this.ear(), performance.now())
    // World items were tracked from T6.08 and drawn by nothing: a medkit on the
    // ground was invisible in the real game.
    this.world?.items.update(dt, [...this.mirror.items.values()], this.ear())
    this.tombstones.update([...this.mirror.tombstones.values()])
    this.birds.update(this.mirror.birds.values(), this.time.now)
    this.animals.update(this.mirror.animals.values(), this.time.now)
    if (this.world) {
      const me = this.core.playerState(this.me)
      const on = me ? padUnderfoot(this.padViews, me.x, me.y) : null
      this.world.pads.update(dt * 1000, on, this.teleportCharge)
      // **T21.14: light the platform its rider is standing on.**
      //
      // `PlatformLayer::setOccupied` shipped with exactly one caller — a sandbox
      // debug hook written for the pixel check — so in a real match the lamp
      // never lit for anyone, and the check could not see it because it drove
      // that hook directly rather than this path.
      //
      // Who is mounted comes off the wire (`MOVE_MOD.mounted`); *which*
      // platform does not, because it does not need to: the rider is standing
      // on it, and `platformUnderfoot` is the same geometry the server's
      // `GunPlatform::underfoot` uses. Cosmetic, exactly like `padUnderfoot`
      // above — a disagreement costs one frame of a lamp, never a mount.
      this.world.platforms.setOccupied(this.occupiedPlatforms())
    }
    this.feel.update(dt, this.feelFrame())
    this.radiation.update(
      dt,
      this.gravity === SPACE_GRAVITY,
      this.meAlive,
      this.irradiated && this.meAlive,
      // F8: radiation and the seal's drain are `Playing`-only on the server.
      this.phase === 'playing',
      C().RADIATION_LOG_INTERVAL,
    )
    // T22.08B: the flare, and who it has set alight — the local body at its
    // rendered position, every drawn remote beside it (`renderRemotes`).
    {
      const k = C()
      const me = this.predictor?.renderPos
      if (me) {
        this.flareBodies.push({ id: this.me, alive: this.meAlive, x: me.x, y: me.y, w: k.PLAYER_W, h: k.PLAYER_H, drawX: me.x, drawY: me.y })
      }
      const at = this.serverClock.now(performance.now() / 1000)
      this.lastFlareQuery = at === null ? null : this.flareClock.query(at)
      this.flareFx.update(this.lastFlareQuery, this.core, this.flareBodies, at ?? 0, this.roundTime)
      this.flareBodies.length = 0
      // T22.10B: the vortices, pulling and fading, where `vortex_open` put them.
      this.vortexFx.update(this.mirror.vortices, performance.now(), this.time.now / 1000)
      // T22.12B: the black hole where `black_hole` put it — results screen too (R8.4).
      // T22.12C R93: and its telegraph, before it opens.
      this.blackHoleFx.update(this.mirror.blackHole, this.mirror.blackHoleWarn, performance.now(), this.time.now / 1000)
      // T22.08D F5: the ribbon has gone and only burns are finishing — say so.
      if (this.flareClock.runningId >= 0) this.topHud?.setEffectTail(this.flareClock.runningId, this.flareFx.state.tail)
    }
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
      // T23.10B F1: where the rule measured each remote this frame (`sightSeen`) — a hidden container is not moved, and
      // its stale place could sit in a light the remote has left.
      const dots = [...this.remotes.keys()].flatMap((id) => {
        const at = this.sightSeen.get(id)
        return at ? [{ id, x: at.x, y: at.y }] : []
      })
      // The *same* fov the night view and the renderer cull with — computed once,
      // above, rather than recomputed here. Two copies of this number would let
      // the minimap and the screen disagree about who is visible (§A6).
      // T21.19: dropped crates blink here, from the mirror the item layer draws from,
      // on the server's round clock.
      // T22.12C R93: and the black hole, once it is here — hidden with its layer, so
      // the check's hidden frame is a control for the minimap too.
      const hole = this.blackHoleFx.state.hidden ? null : this.mirror.blackHole
      this.minimap.update(dt, rp, dots, this.sight, beaconCrates(this.mirror.items.values()), this.roundTime, hole)
    }

    // T23.10 (R7): the player's field of view is drawn as F1 draws night — a soft falloff into the night palette
    // outside it (`nightView`, the world renderer's output pass), never the old black MULTIPLY lightmap. The effect
    // lights — ordnance, fire, lava — light the terrain as F's point lights (`effectLights.ts`), handed over below.
    this.debugHud.update(performance.now(), {
      rttMs: this.clock.rtt,
      pendingInputs: predictor?.stats.pending ?? 0,
      corrections: predictor?.stats.corrections ?? 0,
      lastCorrectionPx: predictor?.stats.lastCorrectionPx ?? 0,
      maxCorrectionPx: predictor?.stats.maxCorrectionPx ?? 0,
      snaps: predictor?.stats.snaps ?? 0,
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
    this.sightFov = fov
    // T23.10B F1: the sight circle and the lights the remotes were judged by (`renderRemotes`), not a second choice.
    this.worldRenderer?.setNightView(nightView(darkness, [{ x: rp.x, y: rp.y, r: fov }], this.sightLit))
    // T23.09C F7: built every frame whether or not the world renderer is up — its bookkeeping (which rounds have
    // flashed) must not go stale while the renderer loads: a round first listed then would flash late, mid-air.
    const effectLights = this.effectLights.frame(this.effectSources(), viewRect(this.cameras.main.worldView))
    this.worldRenderer?.setLights(effectLights)
    this.refreshHud()
  }

  /**
   * T23.09: what this frame's effect lights are made of — the ordnance layer's records, every drawn
   * body that is jetting (the local view and the remotes the dark did not cull: a hidden body casts
   * no light, or its plume would show where the seeing rule hid it), and the vents drawn this frame.
   */
  private effectSources(): EffectSources {
    const o = this.world?.ordnance.state
    const views = [this.localView, ...[...this.remotes.values()].map((r) => r.view)]
    return {
      projectiles: o?.projectiles.values() ?? [],
      tracers: o?.tracers ?? [],
      impacts: o?.impacts ?? [],
      jets: views.flatMap((v) => jetFlames(v)),
      vents: this.vents,
      ...(this.world ? { stale: this.world.staleRounds } : {}),
      hole: fxFeed(this).blackHole,
      flare: fxFeed(this).flare,
    }
  }

  /**
   * The lava vents to draw this frame, or none.
   *
   * Derived, not received: the server puts the effect's seed on `effect_start`
   * and both sides run the same `LavaBurst::new` over the same surface, so the
   * client draws fire exactly where the server opened the ground. That the two
   * agree is proved by cross-check rather than by screenshot —
   * `game-core/src/effects/lava.rs::t19_24_client_side_vents` and
   * `game-wasm/src/lib.rs::t19_24_server_driven_lava`, the second of which goes
   * through the real `load_mask` and `lava_vents` entry points.
   *
   * The seed alone was never enough: `LavaBurst::new` reads
   * `map.meta.surface_points`, and `load_mask` used to clear exactly that field.
   */
  private ventsNow(): VentSpec[] {
    // `roundTime`, not `serverRoundTime` — the same pairing `fog` uses: the
    // origin comes from the snapshot that announced the effect, and the *read*
    // uses the client's per-frame clock so the phases advance smoothly instead
    // of stepping at 20 Hz. The offset between the two is under one snapshot
    // interval against 3 s phase windows, so it cannot move a vent between
    // jetting and burning.
    const q = this.lava.query(this.roundTime)
    if (!q || !this.core) return []
    return this.core.lavaVents(q.lo, q.hi, q.elapsed)
  }

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

  /** T23.14: item id → registry key (`item_registry_json`), parsed once — what a remote's figure holds. */
  private itemKeysMap: Map<number, string> | null = null
  private itemKeys(): Map<number, string> {
    if (!this.itemKeysMap) {
      const defs = JSON.parse(this.core.itemRegistryJson()) as { id: number; key: string }[]
      this.itemKeysMap = new Map(defs.map((d) => [d.id, d.key]))
    }
    return this.itemKeysMap
  }

  /** The local body, built when the map arrives (T23.15: no appearance to rebuild it for). */
  private buildLocalView(): void {
    this.localView?.destroy()
    this.localView = new PlayerView(this)
    // T23.14 (R10): the scarf is the seat's colour.
    this.localView.setSeat(this.me)
    // T23.21 (R10): the quick bar's selected slot is underlined in the same colour.
    this.inventory?.setAccent(this.seatColour())
    this.localView.container.setDepth(DEPTH.actors)
  }

  /** T23.21: the local seat's scarf colour (`PlayerView.setSeat`'s rule). */
  private seatColour(): string {
    const n = SCARF_COLOURS.length
    return SCARF_COLOURS[((this.me % n) + n) % n]!
  }

  /**
   * Remote players come from the interpolation buffer, never from
   * `apply_input`: there are no remote inputs to run, and interpolating
   * transmitted positions is both cheaper and more accurate (`docs/42` §4).
   */
  private renderRemotes(now: number, sampled: ReadonlyMap<number, InterpolatedPlayer>): void {
    this.flareBodies.length = 0
    // T23.27: the seeing rule's own circle is centred on the viewpoint (`viewer`): yours, or the watched player's.
    const localPos = this.viewAt ?? { x: 0, y: 0 }
    const darkness = sceneDarkness(this.gravity === SPACE_GRAVITY, this.serverDarkness, this.roundTime, C().NIGHT_DARKNESS)
    const fov = fovRadius({
      darkness,
      fogMult: this.vision,
      health: C().BASE_HEALTH,
      hasFlashlight: this.hasFlashlight,
    })
    // T23.10B F1: one list of circles for the rule, the night view's pools and the minimap. The lights are the last
    // list handed to the renderer (this frame's is built after the bodies, which its jets depend on) — so a pool opens,
    // and a player in it appears, one frame after its light; both together.
    const own = { x: localPos.x, y: localPos.y, r: fov }
    this.sightLit = sightLights(this.effectLights.last, viewRect(this.cameras.main.worldView), NIGHT_CIRCLES - 1)
    this.sight = [own, ...this.sightLit]

    for (const [id, p] of sampled) {
      let r = this.remotes.get(id)
      if (!r) {
        r = { view: new PlayerView(this), lastSeen: now }
        r.view.setSeat(id)
        r.view.container.setDepth(DEPTH.actors)
        this.remotes.set(id, r)
      }
      r.lastSeen = now
      // Cull outside your field of view (`docs/14` §5): at night you do not see
      // someone standing in the dark, and drawing them anyway is the whole
      // see-in-the-dark hole. T23.10B F1: "…outside your FoV **and not inside any
      // light**" — the lights' circles are the night view's own (`this.sight`).
      const visible = darkness <= 0.01 || seenAt(this.sight, p.x, p.y)
      r.view.container.setVisible(visible && flag(p.flags, FLAG.alive))
      // T23.10: where the rule measured this remote (its sampled place — a hidden container is not moved) and the verdict.
      this.sightSeen.set(id, { x: p.x, y: p.y, visible: r.view.container.visible })
      // T22.19 (R107): the remote's pull at its interpolated position, its own byte.
      // **Stepped before the visibility cull** (T22.19B F5): a remote hidden by the dark
      // used to keep the angle it was last seen at and turn from it when it reappeared.
      // A pull query and a lerp per remote — cheap. A relocation snaps (`trackTilt`).
      const rpull = flag(p.flags, FLAG.alive) ? this.core.standPullAt(p.x, p.y, p.moveMods) : null
      const rtrack = trackTilt(
        this.remoteTilts.get(id) ?? null,
        p.x,
        p.y,
        p.vx,
        p.vy,
        rpull ? standTarget(rpull[0]!, rpull[1]!) : null,
        this.frameDt,
      )
      this.remoteTilts.set(id, rtrack)
      if (!visible) {
        // T23.14E F6: a culled frame is not stepped, so the velocity the estimate holds goes stale: start afresh.
        this.remotePushes.get(id)?.reset()
        continue
      }
      const k = C()
      this.flareBodies.push({
        id,
        alive: flag(p.flags, FLAG.alive),
        x: p.x,
        y: p.y,
        w: k.PLAYER_W,
        h: k.PLAYER_H,
        drawX: p.x,
        drawY: p.y,
      })
      // T22.19B F6: the name tag. A child of the container, so it hides with the body
      // above (the dark's cull, a dead remote) — the same visibility rule.
      r.view.setName(this.scores.get(id)?.name ?? '')
      // T23.14: the held item, off the snapshot's selected-item byte (every player's is on the wire).
      const sel = this.mirror.players.get(id)?.selectedItem ?? null
      r.view.setWeapon(sel === null ? '' : (this.itemKeys().get(sel) ?? ''))
      const full = this.core.fullThrust()
      const jetting = flag(p.flags, FLAG.jetpack) && flag(p.flags, FLAG.alive)
      let est = this.remotePushes.get(id)
      if (!est) this.remotePushes.set(id, (est = new PushEstimate()))
      const push = est.step(jetting, p.vx, p.vy, jetting ? this.core.bodyPullAt(p.x, p.y, p.moveMods, true) : NO_PULL, this.frameDt, full)
      r.view.setState(p.x, p.y, p.vx, p.vy, p.aim, {
        tilt: rtrack.theta,
        alive: flag(p.flags, FLAG.alive),
        grounded: flag(p.flags, FLAG.grounded),
        jetpack: flag(p.flags, FLAG.jetpack),
        shield: flag(p.flags, FLAG.shield),
        iframes: flag(p.flags, FLAG.iframes),
        boots: flag(p.moveMods, MOVE_MOD.boots),
        wings: flag(p.moveMods, MOVE_MOD.wings),
        space: this.gravity === SPACE_GRAVITY,
        // T23.14D F4: a remote's input is not on the wire, so its push is estimated from its motion.
        thrust: push,
        thrustMax: full,
      })
    }

    for (const [id, r] of [...this.remotes]) {
      if (!sampled.has(id)) {
        r.view.destroy()
        this.remotes.delete(id)
        this.remoteTilts.delete(id)
        this.remotePushes.delete(id)
      }
    }
  }

  // --------------------------------------------------------------------- ui

  private buildHud(): void {
    this.hud = document.createElement('div')
    this.hud.dataset['hud'] = 'root'
    this.hud.id = 'game-hud'
    this.hud.style.cssText =
      // T23.21: F's serif and ink (`ui/hudStyle.ts`), letter-spaced as `hudE`'s labels.
      `position:fixed;left:0;right:0;bottom:0;padding:6px 26px;font:12px/1.5 ${HUD_SERIF};letter-spacing:.06em;` +
      'color:rgba(236,230,220,.85);text-shadow:0 1px 2px #000;pointer-events:none;z-index:10;' +
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
      // T23.21: under the bars' captions (left 26), in F's serif; the yellow is the jet's own colour, kept.
      'position:fixed;left:26px;bottom:34px;z-index:12;' +
      `font:12px/1.2 ${HUD_SERIF};letter-spacing:.12em;` +
      'color:#ffd23f;text-shadow:0 1px 2px rgba(0,0,0,.9);pointer-events:none;'
    document.body.appendChild(jet)
    this.jetReadout = jet

    // T21.24: the optional frame-rate readout.
    //
    // **Top-left, which is the one corner of a round nothing else claims** — since
    // 2026-09-16 the clock and the event banner are both top-*centre* (the clock
    // moved off the kill feed, the banner moved below the clock), the kill feed
    // has the top-right to itself, the bars, jetpack and quick bar are along the
    // bottom and the minimap is bottom-right. Offset to `top:26px` because
    // `#debug-fps` sits at `top:8px`:
    // in a dev build with F1 on, the two readouts stack instead of overprinting,
    // which is the mistake the jetpack number made over the round clock.
    //
    // **A fixed DOM element, not a Phaser text object.** "Does not follow the
    // camera oddly" is a property a screen-space DOM node has by construction;
    // a `GameObjects.Text` has it only for as long as nobody forgets
    // `setScrollFactor(0)`, and `this.hud` and the bars already established the
    // shape (§A35).
    const fps = document.createElement('div')
    fps.id = 'fps-counter'
    fps.style.cssText =
      'position:fixed;left:10px;top:26px;z-index:12;pointer-events:none;' +
      'font:700 13px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'color:#8cff8c;text-shadow:0 1px 2px rgba(0,0,0,.9);'
    document.body.appendChild(fps)
    this.fpsCounter = fps
    // Read at construction, so a player who set it last session gets it without
    // opening the panel — and it is `loadSettings` at boot that makes that read
    // return anything (T21.16 shipped a setting nothing loaded).
    this.applyFpsCounter()
    // Live, like the quality toggle, and **applied immediately** rather than on
    // the next frame: a toggle that waits a frame tells whoever just flipped it
    // the old answer. `WeatherLayer` is the model for both halves of this.
    this.unsubFpsCounter = onFpsCounterChange(() => this.applyFpsCounter())

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
          this.selectLocal(slot)
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
    this.inventory.setAccent(this.seatColour())

    // §C13. Quitting **leaves the room** as well as changing scene: a scene
    // change alone keeps the seat, and the room then never reaps (§B14's shape,
    // and the same reason `ResultsScreen.onExit` closes the socket).
    // T21.16. Built before the menu that opens it, so the callback below has
    // something to reach.
    this.optionsPanel = new OptionsPanel({
      // **Back and Esc do the same thing**, rather than Back closing to the
      // round while Esc closes to the menu — two ways out of one panel that
      // disagree is the kind of detail a player notices and cannot name.
      onClose: () => {
        this.optionsPanel?.toggle(false)
        this.escapeMenu?.toggle(true)
      },
      storage: localStorage,
      // T21.33: on the Canvas renderer High Quality has nothing to run, so the row says so.
      shadersAvailable: hasWebGL(this),
      // R20: "Auto (Full)" / "Auto (Low)" for a player who never chose — the world renderer's GPU;
      // low until it has loaded (what `qualityTier(null)` answers too).
      detectedTier: () => this.worldRenderer?.detectedTier() ?? 'low',
    })
    this.escapeMenu = new EscapeMenu({
      onResume: () => this.escapeMenu?.toggle(false),
      // **The menu steps aside while the panel is up.** It is wider than the
      // panel, so leaving it visible left "Resume" and "Quit to title" poking
      // out around the edges, greyed and unclickable — which reads as a bug
      // rather than as depth. Closing options brings it straight back, so the
      // player still lands where they were.
      onOptions: () => {
        this.escapeMenu?.toggle(false)
        this.optionsPanel?.toggle(true)
      },
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
          optionsOpen: this.optionsPanel?.isOpen() ?? false,
          inventoryOpen: this.inventory?.isOpen ?? false,
          menuOpen: this.escapeMenu?.isOpen ?? false,
        })
      ) {
        case 'closed-options':
          // Back to the menu it was opened from, not out to the round.
          this.optionsPanel?.toggle(false)
          this.escapeMenu?.toggle(true)
          break
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
    // T23.27: a spectator has no bag (a remote's inventory is not on the wire) — no quick bar; and a line naming whom
    // it watches, under the round clock.
    if (this.spectating) {
      this.inventory?.destroy()
      this.inventory = null
      const line = document.createElement('div')
      line.id = 'spectate-line'
      line.style.cssText =
        // T23.21: F's serif, under the event banner (which ends at BANNER_TOP + 18 now; the old 64 sat on it).
        'position:fixed;left:50%;top:76px;transform:translateX(-50%);z-index:12;pointer-events:none;' +
        `font:13px/1.3 ${HUD_SERIF};letter-spacing:.12em;color:#9fe7ff;` +
        'text-shadow:0 1px 2px rgba(0,0,0,.9);white-space:pre'
      document.body.appendChild(line)
      this.spectateLine = line
    }
  }

  private setStatus(text: string): void {
    if (this.hud) this.hud.dataset['status'] = text
  }

  private hideJoinCodeBanner(): void {
    this.codeBanner?.remove()
    this.codeBanner = null
  }

  /** §A35: `worldView` and the canvas's CSS rect, never the camera transform. */
  /**
   * Which platforms have a rider on them right now (T21.14).
   *
   * **Both halves of the answer come from different places, deliberately.**
   * *Whether* a player is mounted is the server's, carried by
   * `MOVE_MOD.mounted` — the client cannot derive it, because standing on a
   * platform is not the same as having finished the mount. *Which* platform is
   * geometry, and is not on the wire because it does not need to be: a rider is
   * standing on theirs.
   *
   * The local player is included from their own snapshot rather than from
   * prediction, so the lamp cannot light on a mount the server refused.
   */
  private occupiedPlatforms(): number[] {
    const c = C()
    return occupiedPlatforms(
      this.mirror.players.values(),
      this.platformViews,
      MOVE_MOD.mounted,
      c.PLAYER_H,
      c.GUN_PLATFORM_W,
    )
  }

  /**
   * Show or hide the FPS counter **now**, with a number already in it (T21.24).
   *
   * Both halves matter. Hiding is obvious; writing the text here is what stops
   * the counter appearing empty — or holding the number it had when it was last
   * switched off — for up to `FPS_READOUT_INTERVAL` after a flip. Painted from
   * `isFpsCounter()` and never from a flag of its own, which is the rule the
   * options panel's buttons follow for the same reason.
   */
  private applyFpsCounter(): void {
    const el = this.fpsCounter
    if (!el) return
    const on = isFpsCounter()
    el.style.display = on ? 'block' : 'none'
    if (on) {
      this.writeFpsCounter()
      this.fpsTextDue = FPS_READOUT_INTERVAL
    }
  }

  /** The readout's text: a whole number, because tenths are unreadable. */
  private writeFpsCounter(): void {
    if (this.fpsCounter) this.fpsCounter.textContent = `${Math.round(this.playerFps.fps())} fps`
  }

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

  /**
   * T23.27: "SPECTATING <name> · <weapon> — Tab / Shift+Tab to switch · hold S for scores". The weapon is the
   * watched player's held item off the snapshot (`selectedItem`); its ammo is not on the wire for a remote.
   */
  private spectateText(): string {
    const id = this.watch.watching
    if (id === null) return 'SPECTATING — waiting for a player'
    const name = this.scores.get(id)?.name ?? `p${id}`
    const item = this.mirror.players.get(id)?.selectedItem
    const weapon = item === undefined || item === null ? '' : (this.itemKeys().get(item) ?? '')
    return `SPECTATING ${name}${weapon ? ` · ${weapon}` : ''} — Tab / Shift+Tab to switch · hold ${SPECTATE_SCORES_KEY} for scores`
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
    this.topHud?.update(this.phase, secondsLeft, this.roundTime, C().TIMER_WARN_SECONDS)

    // §C8's cluster. `fuelShown` is last frame's fuel, which is what makes the
    // refill delay derivable from two samples rather than from a flag the client
    // is never sent.
    const c = C()
    const waiting = inRefillDelay(this.fuelShown, this.fuel, c.JETPACK_MAX_FUEL, this.wasJetting)
    this.bars?.update({
      health: healthBar(this.health, c.BASE_HEALTH, c.HEALTH_CAP, this.poisoned),
      energy: energyBar(this.battery, c.BATTERY_MAX),
      jetpack: jetpackBar(this.fuel, c.JETPACK_MAX_FUEL, waiting, this.hasWings),
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
    // **The clock came out of this strip on 2026-09-16**, owner, from play:
    // *"honestly i see we have two timers. one on the bottom left and one top
    // right."* They were the same number twice — `#hud-timer` and this — and this
    // is the worse copy: 12 px monospace at the bottom edge against 40 px of
    // display face. `phaseBanner` stays, because "Warmup" and "Round over" are
    // words the big timer does not carry, and it brings its own clock with it.
    const lines = [[status, banner ?? '', strip].filter((p) => p !== '').join('   │   ')]
    if (this.scoreboardOpen) lines.push(board)
    this.hud.textContent = lines.join('\n')
    if (this.spectateLine) this.spectateLine.textContent = this.spectateText()

    // §C26. One decimal, from the snapshot's fuel — see `jetpackReadout-math`
    // for the measured curve this exists to make legible.
    if (this.jetReadout) {
      const trend = fuelTrend(this.fuelShown, this.fuel, C().JETPACK_REFILL, C().SIM_DT)
      this.fuelShown = this.fuel
      this.jetReadout.dataset['fuel'] = fuelText(this.fuel, C().JETPACK_MAX_FUEL)
      this.jetReadout.dataset['trend'] = trend
      // T21.34: both ends (§A39) — the flag beside the text it produced.
      this.jetReadout.dataset['refused'] = this.hasWings ? '1' : '0'
      this.jetReadout.textContent = jetReadoutText(this.fuel, C().JETPACK_MAX_FUEL, trend, this.hasWings)
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
       * The same handle for T20.10's ground animals, and **a second function
       * rather than a second body in `setBirdsVisible`.**
       *
       * That is not a style preference, it was measured. Folding the animals
       * into the birds' toggle made one name mean two things, and `birds.mjs`
       * went red on the next gate: hiding "the bird layer" changed a 981x403
       * region against a bird's own 40x28 box, with the changed pixels centred
       * 495 px from the bird, because an animal on the other side of the frame
       * vanished in the same toggle. The check was right and the handle was
       * wrong — a field that means two things is a bug waiting for the first
       * caller that wants one of them.
       */
      setAnimalsVisible(on: boolean) {
        self.animals?.setVisible(on)
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
      /** e2e only (T99.02): a trailer's close-up — the live zoom, which the world renderer reads. */
      setZoom(z: number) {
        self.cameras.main.setZoom(z)
        return self.cameras.main.zoom
      },
      /** e2e only (T99.04): a trailer shot's explosion shake, as a multiple of the game's (1). */
      setShakeScale(k: number) {
        self.shakeScale = Math.max(0, k)
        return self.shakeScale
      },
      /** e2e only (T99.04): the pickups, off for the trailer's wildlife shot. */
      setItemsVisible(on: boolean) {
        return self.world?.items.setVisible(on) ?? null
      },
      /** e2e only (T99.04): the pickups' name labels, off for a trailer shot. */
      setItemLabelsVisible(on: boolean) {
        return self.world?.items.setLabelsVisible(on) ?? null
      },
      /** e2e only (T99.04): draw the animals as every world's creatures at once (`mixedFauna`). */
      setFaunaMix(on: boolean) {
        self.animals?.setFaunaMix(on)
      },
      /** e2e only (`DEV_PROBE=1`, T99.04): a crowd of animals and birds around column `x`. */
      debugFauna(x: number, spiders: number, beetles: number, birds: number) {
        self.conn.sendRaw('debug_fauna', { x, spiders, beetles, birds })
      },
      /** e2e only (T99.02): the trailer's shots carry no crosshair. */
      setCrosshairVisible(on: boolean) {
        self.crosshair.setVisible(on)
      },
      /**
       * Show or hide the teleport pads — **for the pixel check's control
       * frame** (`docs/72` §C2, T21.12).
       *
       * "The gate is on screen" is only evidence against the same camera, the
       * same map and the same light with the layer gone. Two pads cannot be
       * that control and neither can two maps.
       *
       * Returns what it did, read back off the container, rather than
       * acknowledging the ask — a hook that answers `true` for "I was called"
       * is the shape this project keeps paying for.
       */
      /** e2e only (T21.18): flip High Quality here, and say what is painted now. */
      setHighQuality(on: boolean) {
        setHighQuality(localStorage, on)
        return {
          setting: isHighQuality(),
          // T23.18: every effect is F's, drawn by the world renderer on both tiers (not a setting's shader).
          worldFx: fxFeed(self).worldDraws,
        }
      },
      /** e2e only (§C2, T21.18): hide the hazard/jet/mine layer for a same-instant control frame. */
      showFx(on: boolean) {
        self.fx?.setVisible(on)
        return { visible: self.fx?.visible ?? false }
      },
      /**
       * e2e only (T22.08D F1): the server's own flare elapsed (`DEV_PROBE=1`), bracketed
       * by the client's at the moment of asking and of hearing back — so a check compares
       * the client's clock against the server's, not against itself.
       */
      probeFlare(): Promise<{ before: number | null; server: unknown; after: number | null; atTick: number | null }> {
        return new Promise((resolve) => {
          const before = self.flareQueryNow()?.elapsed ?? null
          const timer = setTimeout(() => resolve({ before, server: null, after: null, atTick: null }), 5000)
          self.probeWaiters.push((server) => {
            clearTimeout(timer)
            // T22.08F: the client's flare clock **at the tick the server answered for** —
            // `FlareClock` on the tick clock (`tick × SIM_DT`, what `flareClock.start` was
            // given), so both sides are one instant and no round trip is in the number.
            const tick = (server as { tick?: unknown } | null)?.tick
            const atTick = typeof tick === 'number' ? (self.flareClock.query(tick * C().SIM_DT)?.elapsed ?? null) : null
            resolve({ before, server, after: self.flareQueryNow()?.elapsed ?? null, atTick })
          })
          self.conn.sendRaw('debug_effects', {})
        })
      },
      /**
       * e2e only (T23.28, `DEV_PROBE=1`): the server's own round — its phase, round clock, pickups and graves (ids) and
       * bodies — for a check to count the drawn set against. Null on a timeout.
       */
      probeRound(): Promise<unknown> {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 5000)
          self.probeWaiters.push((server) => {
            clearTimeout(timer)
            resolve(server)
          })
          self.conn.sendRaw('debug_effects', {})
        })
      },
      /** e2e only (§C2, T22.10B): hide the vortex layer for a same-instant control frame. */
      showVortices(on: boolean) {
        self.vortexFx.setHidden(!on)
        return self.vortexFx.state
      },
      /**
       * e2e only (`DEV_PROBE=1`, T22.10B): ask the server to breach the rim on the ray
       * through this player — or, with `aim` (T22.17), through that world point. The
       * answer lands in `debug().vortex.lastBreach`; the vortex arrives as any other
       * does, through `vortex_open`.
       */
      debugBreach(aim?: { x: number; y: number }) {
        self.observed.lastBreach = null
        self.observed.myRelocateTick = null
        self.conn.sendRaw('debug_breach', aim ? { x: aim.x, y: aim.y } : {})
      },
      /** e2e only (§C2, T22.12B): hide the black hole for a same-instant control frame. */
      showBlackHole(on: boolean) {
        self.blackHoleFx.setHidden(!on)
        return self.blackHoleFx.state
      },
      /**
       * e2e only (T22.14A L): repaint the black hole as it looks `ms` after its arrival,
       * for a frozen photograph of the arrival frame — the disc and the ring are the
       * rule and must be full size from it. The next unfrozen frame repaints as usual.
       */
      drawBlackHoleAt(ms: number) {
        const h = self.mirror.blackHole
        if (h) self.blackHoleFx.update(h, null, h.arrivedAt + ms, self.time.now / 1000)
        return self.blackHoleFx.state
      },
      /**
       * e2e only (`DEV_PROBE=1`, T22.12B): bring the black hole now (it eats the rock
       * nearest this player) and, with `dist`, put this player at rest that far from it.
       * The answer lands in `debug().blackHole.lastProbe`; the hole arrives as a real one
       * does, through `black_hole` and the carve stream.
       */
      /** e2e only (T22.12D F1): hear the server `ms` late (every event, in order). */
      netDelay(ms: number) {
        self.conn.setInboundDelay(ms)
      },
      /**
       * e2e only (`DEV_PROBE=1`, T22.19): put this player's body centre at `(x, y)` at
       * rest — `World::dev_relocate`, announced as a relocation like a pad's. The
       * answer lands in `debug().stand.lastPlace`.
       */
      debugPlace(x: number, y: number, id?: number, anchor?: number) {
        self.observed.lastPlace = null
        // T99.04: `id` places a bot instead (a spectator's staged shot); `anchor` seconds hold it there, fighting.
        self.conn.sendRaw('debug_place', { x, y, ...(id === undefined ? {} : { id }), ...(anchor === undefined ? {} : { anchor }) })
      },
      /**
       * e2e only (T22.19, §C2): redraw the local figure at `tilt` (radians) for a frozen
       * photograph — the same instant upright, to compare the drawn figure against.
       * The next unfrozen frame draws the real tilt again.
       */
      poseLocalTilt(tilt: number, aim?: number) {
        self.localView?.poseTilt(tilt, aim)
        return self.localView?.tilt ?? null
      },
      /** e2e only (T22.19): `poseLocalTilt` for remote `id`. */
      poseRemoteTilt(id: number, tilt: number, aim?: number) {
        const r = self.remotes.get(id)
        r?.view.poseTilt(tilt, aim)
        return r?.view.tilt ?? null
      },
      /**
       * e2e only (T22.19B F6, §C2): hide every name tag, for the label check's control
       * frame — the same instant with the tags gone. Freeze first. Returns how many tags
       * it changed, read back off the views.
       */
      setNamesVisible(on: boolean) {
        let n = 0
        for (const v of [self.localView, ...[...self.remotes.values()].map((r) => r.view)]) {
          if (v && v.setNameVisible(on) === on) n++
        }
        return n
      },
      debugBlackHole(dist?: number, warn?: boolean, id?: number) {
        self.observed.lastBlackHole = null
        self.conn.sendRaw('debug_black_hole', {
          ...(dist === undefined ? {} : { dist }),
          ...(warn ? { warn: true } : {}),
          // T99.04: near player `id` (a bot) instead of the asker.
          ...(id === undefined ? {} : { id }),
        })
      },
      /** e2e only (§C2, T22.08B): hide the flare — ribbon and flames — for a same-instant control frame. */
      showFlare(on: boolean) {
        self.flareFx.setHidden(!on)
        return self.flareFx.state
      },
      /** e2e only (T21.18): keep ended hazards on screen, so a cloud can be photographed steadily. */
      holdHazards(on: boolean) {
        self.fx?.holdHazards(on)
        return { held: self.fx?.hazardsAreHeld ?? false }
      },
      /**
       * T23.14F F2, e2e only: make the predicted player disagree with the server, as the wire orderings T23.14F lists
       * do — `'empty'`: its bag emptied (a pickup it has not heard of: it refuses, the server takes); `slot`: that
       * slot selected on the mirror only (an overwritten selection: it takes a use the server makes with another
       * item); `'server'`: the server's bag and selection back (`pushBag`).
       */
      desyncMirror(how: 'empty' | 'server' | { slot: number }) {
        if (!self.core) return false
        if (how === 'server') self.pushBag()
        else if (how === 'empty') {
          const none = self.slots.map(() => 0)
          self.core.setBag(self.me, none, none, self.selectedSlot)
        } else self.core.selectSlot(self.me, how.slot)
        return true
      },
      /** T23.14E F4, e2e only: every frame busy-waits `ms` (0: off) — a slow frame on demand. */
      slowFrames(ms: number) {
        self.slowFrameMs = Math.max(0, ms)
      },
      /**
       * T23.14E F4, e2e only: watch the ordnance layer's rounds **on the canvas** — for each, the Phaser canvas's pixels
       * around it on the frame it is first drawn, against the same patch on the first frame after it is gone (the
       * control frame), and a patch as far on the other side of the player (the control region). `on` false returns
       * the results and stops.
       */
      watchRounds(on: boolean) {
        const seen = self.roundWatch?.stop() ?? []
        self.roundWatch = on
          ? new RoundWatch(self.game, self.cameras.main, {
              state: () => self.world?.ordnance.state ?? null,
              centre: () => self.mirror.players.get(self.me) ?? null,
            })
          : null
        return seen
      },
      /** e2e only (§C2, T21.18): hide the ordnance layer for a same-instant control frame. */
      showOrdnance(on: boolean) {
        self.world?.ordnance.setVisible(on)
        return { visible: self.world?.ordnance.visible ?? false }
      },
      /** e2e only (T21.18): stop explosions ageing, so one blast can be posed and photographed. */
      holdImpacts(on: boolean) {
        if (self.world) self.world.ordnance.state.holdImpacts = on
        return { held: self.world?.ordnance.state.holdImpacts ?? false }
      },
      /**
       * e2e only (T21.18): age held explosions by `seconds` through the state's own
       * `ageImpacts`, then repaint — so a frozen blast can be posed at a known age.
       */
      advanceImpacts(seconds: number) {
        self.world?.ordnance.state.ageImpacts(seconds)
        self.world?.ordnance.render()
        return {
          impacts: self.world?.ordnance.state.impacts.length ?? 0,
          blasts: self.world?.ordnance.state.blasts.map((b) => ({ age: b.age, ttl: b.ttl })) ?? [],
        }
      },
      /** e2e only (T21.18): stop beams fading, so one can be photographed steadily. */
      holdTracers(on: boolean) {
        if (self.world) self.world.ordnance.state.holdTracers = on
        return { held: self.world?.ordnance.state.holdTracers ?? false }
      },
      showPads(on: boolean) {
        self.world?.pads.setVisible(on)
        return { visible: self.world?.pads.visible ?? false }
      },
      debug() {
        const body = self.core.playerState(self.me)
        return {
          ready: self.ready,
          /**
           * T23.28: the load handshake, both ends of the cover — whether the element is in the document (`up`), and
           * the inputs that decide it; `resets` counts the `new_round`s heard, `holders` what each one reset.
           */
          cover: {
            up: self.loadCover?.isUp ?? false,
            inDom: document.getElementById('load-cover') !== null,
            readySent: self.readySent,
            awaitingRound: self.awaitingRound,
            painted: self.mapPainted(),
            resets: self.roundReset?.runs ?? 0,
            holders: self.roundReset?.names ?? [],
          },
          me: self.me,
          // §F9, at both ends (§A39): the strength the scene walked from the
          // effect's start time, and the alpha the shared layer actually filled
          // with. The pair is what tells a reader whether a fogless-looking
          // frame is a dead effect or a dead renderer.
          fogStrength: self.fog.strength(self.roundTime),
          fogAlpha: self.world?.weather.fogAlpha ?? 0,
          // T22.00G: the strength `fogAlpha` was drawn from, off the same frame —
          // `fogStrength` above is live, and on the ramp the two clocks disagree.
          fogDrawnStrength: self.world?.weather.fogDrawnStrength ?? 0,
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
          /** T23.09: the kinds of the last effect-light list handed to the world renderer, in order. */
          effectLights: [...self.effectLights.lastKinds],
          /** T23.09D: the local figure's action (a predicted swing), and the server's melee events heard so far. */
          localAction: self.localView?.action ?? null,
          /** T23.09A/T23.09C F3: whether the lit terrain's last drawn frame had its cave wall; null before it drew. */
          // T23.09C F3: the drawn frame's wall (`wallK`), not the switch.
          caveWall: self.worldRenderer?.caveWallDrawn() ?? null,
          /**
           * T22.04B: what each body's jet flame drew last frame (T23.14B: the figure's
           * flame, was the plume), keyed by seat — read off the **views**,
           * so there is no second copy to disagree with the picture. It is the only window onto
           * this scene's space wiring (`gravity` off `lobby_state`, `space:` and
           * `jetpack:` at both `setState` calls); `thrusters-match` reads it.
           */
          flames: Object.fromEntries([
            ...(self.localView ? [[self.me, self.localView.flameState] as const] : []),
            ...[...self.remotes].map(([id, r]) => [id, r.view.flameState] as const),
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
          // T23.19: where each grave is drawn (the layer's own objects), for a check or a shot to point the camera at.
          gravesDrawnAt: self.tombstones?.drawn ?? [],
          // Both ends (§A39): what the server said, and what is on screen. A
          // bird nobody can see is a supply line nobody can open.
          birds: self.mirror.birds.size,
          // Both ends (§A39): what the server says exists, and what the layer
          // drew. `animalsDrawnAt` is the drawn positions, for the reason
          // `birdsDrawnAt` exists — a patch computed from mirror coordinates and
          // then screenshotted compares two different instants.
          animals: self.mirror.animals.size,
          animalsDrawn: self.animals?.count ?? 0,
          animalsDrawnAt: self.animals?.drawn ?? [],
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
          // T23.10B F1: where the gates stand (their light is a gate's, `gateLights`) — night-view-match's light leg.
          padsAt: self.padViews.map((p) => ({ x: p.x, y: p.y })),
          // T23.10B F1: every standing light on the map (gates, crystals) — a check's stand outside all of them.
          staticLights: self.effectLights.statics.query({ x: 0, y: 0, w: self.core.width, h: self.core.height }).map((l) => ({ x: l.x, y: l.y, r: l.r })),
          padsDrawn: self.world?.pads.count ?? 0,
          // T21.12, both ends once more: a pad can be drawn as the fallback
          // ring with no gate art loaded, and that is a legal state
          // (`docs/50` §8) — so "drawn" and "wearing a gate" are two different
          // numbers and a check that conflated them would pass on placeholders.
          gatesDrawn: self.world?.pads.gatesDrawn ?? 0,
          // T21.12: where the charge indicator is, so a pixel check can sample
          // it rather than a rect that used to be right.
          gatePortal: self.world?.pads.portalGeometry() ?? null,
          // T21.12: whether the pad layer is currently drawn, so the pixel
          // check's control frame can prove it turned it off rather than
          // assuming it.
          padsVisible: self.world?.pads.visible ?? false,
          platformsDrawn: self.world?.platforms.count ?? 0,
          // T23.19A: how many of them the world renderer draws (behind the figures), and the gates likewise.
          turretsInWorld: self.world?.platforms.turretsInWorld ?? 0,
          gatesInWorld: self.world?.pads.drawsInWorld ? (self.world?.pads.gatesDrawn ?? 0) : 0,
          // §D6: what `map_init` carried. Drawn as rock since T23.07 (the mask stamps them), so there is
          // no separate index to count at the other end any more.
          objects: self.mapObjects.length,
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
          // T23.19A: where the pickups lie, so a check (or a person's probe) can walk a player to one.
          itemPositions: [...self.mirror.items.values()].map((i) => ({ id: i.id, x: i.x, y: i.y })),
          // The local player's charge as the client has it, so a check can watch
          // it fill rather than sleeping for two seconds and hoping.
          teleportCharge: self.teleportCharge,
          onPad: (() => {
            const me = self.core.playerState(self.me)
            return me ? padUnderfoot(self.padViews, me.x, me.y) : null
          })(),
          /**
           * T21.22. **Riding a platform, and standing on one — two fields,
           * because they are two facts.**
           *
           * `occupiedPlatforms` above already says why the halves come from
           * different places, and this is the same split made readable to a
           * browser check. **Whether** she is mounted is the server's, carried
           * by `MOVE_MOD.mounted` and read off the mirror's snapshot rather
           * than off prediction, so a mount the server refused cannot appear
           * here. **Which** platform is under her feet is geometry — the same
           * `platformUnderfoot` the lamp uses — and it is emphatically *not*
           * the same question: a mount takes `GUN_PLATFORM_MOUNT_TIME` of
           * standing still on it, and an occupied platform refuses a second
           * rider, so `platformUnderfoot` non-null with `mounted` false is a
           * legal and common state.
           *
           * Collapsing them into one flag would have made
           * `e2e-two-clients`'s "get off the platform" step untestable: the
           * step has to watch the geometry change, and the assertion either
           * side of the firing loop has to watch the mount.
           *
           * The reason both exist at all: a player who spawns on a platform
           * mounts it by standing still, and a mounted player's trigger pull
           * fires the platform's gun instead of one rocket (a stream while held, T21.43).
           * With nothing reporting the mount, that arrives at a check as
           * "10 rockets left the muzzle for 4 trigger pulls" — a true count
           * blaming the wrong mechanism.
           */
          /**
           * Where every gun platform is, so a check can say *which* one it is
           * near rather than guess a coordinate — `padPositions`, `mines` and
           * `birdViews` above all exist for the same reason.
           *
           * It is what makes `mount.mounted`'s **presence control** possible at
           * all: proving "she is not mounted" is not vacuous means deliberately
           * walking her onto one, and a check cannot walk toward a position it
           * cannot read. It also turns the mount assertions' failure message
           * from "she is mounted" into "she is mounted, here, and the platforms
           * are there" — the diagnosis in the failure rather than in the next
           * session.
           *
           * `platformViews` is what `map_init` carried and what the lamp layer
           * was built from, so this is the same list the renderer uses, not a
           * second copy that could disagree.
           */
          platformPositions: self.platformViews.map((p) => ({ id: p.id, x: p.x, y: p.y })),
          mount: (() => {
            const mine = self.mirror.players.get(self.me)
            const c = C()
            return {
              mounted: mine ? flag(mine.moveMods, MOVE_MOD.mounted) : false,
              platformUnderfoot: mine
                ? platformUnderfoot(
                    self.platformViews,
                    mine.x,
                    mine.y,
                    c.PLAYER_H,
                    c.GUN_PLATFORM_W,
                  )
                : null,
            }
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
          // T21.18: explosions the layer holds (flat flashes, and the longer-lived blasts F's explosion is drawn from —
          // T23.18, counted drawn by `__world.fx()`), where they are; and where the layer has every flame — the
          // positions its picture was drawn from, not the mirror's.
          impactsDrawn: self.world?.ordnance.state.impacts.length ?? 0,
          blastsAt: (self.world?.ordnance.state.blasts ?? []).map((b) => ({ x: b.x, y: b.y, r: b.r, age: b.age })),
          flamesDrawnAt: [...(self.world?.ordnance.state.projectiles.values() ?? [])]
            .filter((p) => p.kind === 'flame')
            .map((p) => ({ x: p.x, y: p.y })),
          // T21.18: the snapshot's vision multiplier (fog times smoke) — the simulation half
          // of smoke, which a check asserts does not move with High Quality.
          vision: self.vision,
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
          // T21.31: where the streaks were drawn — the real drops, so a check can ask
          // whether one fell over a player's head.
          toxicDropsDrawn: self.world?.weather.toxicDropsDrawn ?? [],
          // ...and where the ordnance layer's live drops are, the state they are drawn
          // from — so a check compares places, not only counts.
          toxicDropsLive: self.world?.liveToxicDropList ?? [],
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
          // T21.43: every projectile the layer ever **started drawing**, by kind.
          // Cumulative, because a platform round lives ~0.6 s and a live count
          // polled once a few hundred ms misses most of a stream — the same
          // reason `observed.projectileSpawns` only goes up.
          projectilesAddedByKind: { ...(self.world?.projectilesAddedByKind ?? {}) },
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
          // T23.27: spectate — whom the camera follows, where the viewpoint is (the watched player's drawn place), and
          // the camera rig's centre, so a check reads both ends of "the camera is on player A".
          spectating: self.spectating,
          watching: self.watch.watching,
          viewAt: self.viewAt,
          cameraCentre: self.world ? { x: self.world.rig.center.x, y: self.world.rig.center.y } : null,
          watchSteps: self.observed.watchSteps,
          /** T23.27: the ids in the last snapshot — a spectator's own is never among them (no body). */
          playerIds: [...self.mirror.players.keys()],
          /** T22.08E: where the crosshair's mark sits, world px — a pixel check's probe under it is occluded. */
          crosshair: self.crosshairAt,
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
            jetpack: jetpackBar(self.fuel, C().JETPACK_MAX_FUEL, false, self.hasWings),
            // T21.34: the flag the jet bar's refusal is drawn from.
            wings: self.hasWings,
            shieldOn: self.shieldOn,
            // Both ends (§A39): the flag off the wire beside the colour it
            // produced, so a green bar with `poisoned` false is visible as a
            // disagreement rather than as a colour nobody can explain.
            poisoned: self.poisoned,
            // T22.09B, both ends: bit 7 off the wire beside what was mounted.
            irradiated: self.irradiated,
            radiation: self.radiation?.stats() ?? null,
            battery: self.battery,
            heals: self.heals,
            batteries: self.batteries,
          },
          hudBanner: {
            text: self.topHud?.banner.textContent ?? '',
            shown: (self.topHud?.banner.style.display ?? 'none') !== 'none',
            effects: self.topHud?.effects() ?? [],
          },
          // T22.08B: what the flare layer drew, and who it shows burning — and the
          // clock's query, so a check can ask the core for the damage points itself
          // rather than read back what was drawn.
          flare: self.flareFx?.state ?? null,
          flareQuery: self.lastFlareQuery,
          // T22.10B: the list the core sums (opening order), what the layer drew,
          // the relocations heard, and the predictor's corrections — the
          // rubber-band a vortex the client was not told about produces.
          // T22.12B: the hole the core pulls toward, what the layer drew, the server's
          // last probe answer, and the rocks the core still sums.
          // T22.19 (R107): the tilt the scene stepped, the tilt the view drew, and the
          // pull it was stepped toward — for the local body and each remote.
          stand: {
            tilt: self.localTilt,
            drawn: self.localView?.tilt ?? null,
            at: self.localView?.drawnAt ?? null,
            pull: (() => {
              const b = self.core.playerState(self.me)
              const rp = self.predictor?.renderPos
              return b && rp ? Array.from(self.core.standPullAt(rp.x, rp.y, b.moveMods)) : null
            })(),
            feet: self.localView?.drawnFeet ?? null,
            aim: self.localView?.drawnAim ?? null,
            name: self.localView?.nameTag ?? null,
            remotes: [...self.remotes].map(([id, r]) => ({
              id,
              tilt: self.remoteTilts.get(id)?.theta ?? 0,
              drawn: r.view.tilt,
              at: r.view.drawnAt,
              feet: r.view.drawnFeet,
              aim: r.view.drawnAim,
              name: r.view.nameTag,
            })),
            lastPlace: self.observed.lastPlace,
          },
          blackHole: {
            hole: self.mirror.blackHole ? { ...self.mirror.blackHole } : null,
            warn: self.mirror.blackHoleWarn ? { ...self.mirror.blackHoleWarn } : null,
            fx: self.blackHoleFx?.state ?? null,
            lastProbe: self.observed.lastBlackHole,
            asteroids: self.core.meta.asteroids.map((a) => ({ x: a.x, y: a.y })),
            checksums: { ...self.mirror.stats },
            // T22.12D F3: dev placements heard as relocations.
            relocations: self.observed.relocations,
            // T22.12D (R94): the last `Playing` `round_state`'s `ends_tick`.
            bellEndsTick: self.bellEndsTick,
            // T22.14C MED-2: the bell's seq as the core has it, and the newest seq
            // pushed — a frame predicted before the bell has `inputSeq < bellSeq`.
            bellSeq: self.bellSeq,
            inputSeq: self.seq,
            // T22.12E F2: the tick the server's `ended` `round_state` carried.
            endedAtTick: self.endedAtTick,
          },
          vortex: {
            list: self.mirror.vortices.map((v) => ({ ...v })),
            fx: self.vortexFx?.state ?? null,
            trips: self.observed.vortexTrips,
            myTrips: self.observed.myTrips.map((t) => ({ ...t })),
            lastBreach: self.observed.lastBreach,
            myRelocateTick: self.observed.myRelocateTick,
            corrections: self.predictor?.stats.corrections ?? 0,
            lastCorrectionPx: self.predictor?.stats.lastCorrectionPx ?? 0,
            maxCorrectionPx: self.predictor?.stats.maxCorrectionPx ?? 0,
            lastJumpPx: self.predictor?.stats.lastJumpPx ?? 0,
            lastAckErrorPx: self.predictor?.stats.lastAckErrorPx ?? null,
            lastAck: self.predictor?.stats.lastAck ?? 0,
            maxEasedJumpPx: self.predictor?.stats.maxEasedJumpPx ?? 0,
            maxAckErrorPx: self.predictor?.stats.maxAckErrorPx ?? 0,
            snaps: self.predictor?.stats.snaps ?? 0,
            settled: self.predictor?.stats.settled ?? 0,
            worstJump: self.predictor?.stats.worstJump ?? null,
            // T22.14E: the last correction's context, for a check that fails on one.
            lastCorrection: self.predictor?.stats.lastCorrection ?? null,
            // T22.12D F1: the bell's own error (NaN → null until measured).
            bellErrorPx: Number.isFinite(self.predictor?.stats.bellErrorPx) ? self.predictor?.stats.bellErrorPx : null,
          },
          darkness: self.serverDarkness,
          // T22.06: what was drawn and lit with, and the sky that drew it. The byte
          // above can be 0 while the frame is dark — that `||` is why both exist.
          drawnDarkness: self.drawnDarkness,
          // T23.10 (R7): the seeing rule, both ends — the sight radius the night view was drawn with, and each
          // remote's drawn place and whether it is drawn (`renderRemotes` hides one beyond it at night).
          sight: {
            fov: self.sightFov,
            // T23.10B F1: the lights' circles the remotes were judged against (and the night view drew).
            lit: self.sightLit.map((c) => ({ ...c })),
            remotes: [...self.sightSeen].filter(([id]) => self.remotes.has(id)).map(([id, r]) => ({ id, ...r })),
          },
          // T23.06B (F3/F9): why this map's terrain fields are not the full picture — the worker
          // failed (main-thread fallback, no generated cave walls) or version skew — '' when they are;
          // and whether the new terrain's picture is whole (T23.07's switch from Phaser's rock).
          terrainWarning: self.terrainFields?.stats.warning ?? '',
          terrainReady: self.worldRenderer?.terrainReady() ?? false,
          rockVisible: self.world?.rockVisible ?? false,
          sky: {
            space: self.spaceSky?.isShown ? self.spaceSky.debug() : null,
            // T23.04: whether the world renderer draws the ground sky (not on a space map).
            ground: self.worldRenderer ? !self.onSpaceMap : null,
          },
          // T19.24. **World coordinates, so a check can find what it is
          // photographing.** The client learns vent positions only by deriving
          // them from the effect seed, so without this a pixel check would have
          // to hardcode a coordinate that rots the next time the map seed moves —
          // and would then sample empty ground and pass for the wrong reason.
          // `no-dev-surface.mjs` guards this whole object out of a production
          // build.
          vents: self.vents.map((v) => ({
            x: v.x,
            y: v.y,
            jetting: v.jetting,
            burning: v.burning,
          })),
          health: self.health,
          /**
           * T23.27C F5: every player's health and jet fuel as the last snapshot carried them, and the HUD's (`viewed`) —
           * a spectate check's two ends.
           */
          playerRows: Object.fromEntries([...self.mirror.players].map(([id, p]) => [id, { health: p.health, fuel: p.jetpackFuel }])),
          viewed: { health: self.health, fuel: self.fuel },
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
            uses: self.observed.uses,
            slowFrames: self.observed.slowFrames,
            replayLandings: self.observed.replayLandings,
            landVolumes: [...self.observed.landVolumes],
            landingFloor: LANDING_VOLUME_FLOOR,
            lastUse: self.observed.lastUse,
            localSwings: self.observed.localSwings,
            pendingUses: { ...self.pendingUses.stats, waiting: self.pendingUses.waiting, boundMs: self.pendingUses.bound() },
            hitscans: self.observed.hitscans,
            explosions: self.observed.explosions,
            projectileSpawns: self.observed.projectileSpawns,
            ownProjectileSpawns: self.observed.ownProjectileSpawns,
            unmappedFireCues: self.observed.unmappedFireCues,
            darknessMin: self.observed.darknessMin,
            darknessMax: self.observed.darknessMax,
            maxTickLag: self.observed.maxTickLag,
          },
        }
      },
      fire() {
        self.useNow(false)
      },
      /** T23.14E F1: §C11's `E`, as the key sends it (the predicted throw included). */
      quickThrow() {
        self.useNow(true)
      },
      /** T23.14E: select quick-bar `slot` as its number key does (sent, and in the predicted player). */
      selectSlot(slot: number) {
        self.selectLocal(slot)
      },
      /** T23.09C F6: the last effect-light list handed to the world renderer, each with its source's kind (as the sandbox's). */
      effectLights() {
        return self.effectLights.last.map((l, k) => ({ kind: self.effectLights.lastKinds[k], ...l }))
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
