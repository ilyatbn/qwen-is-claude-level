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
import { C, Core, dequantizeAngle } from '../core'
import { asRecord, Connection, type LobbyIntent, type Welcome } from '../net/connection'
import { WorldMirror, hex } from '../net/worldMirror'
import { Predictor } from '../net/prediction'
import { ClockSync, RemoteInterpolator } from '../net/interpolation'
import { WorldView } from '../render/worldView'
import { DEPTH } from '../render/backdrop'
import { PlayerView } from '../render/playerView'
import { Crosshair, LocalInput } from '../input/localInput'
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
import { energyBar, healthBar, inRefillDelay, jetpackBar, shieldRing } from '../ui/bars-math'
import { DebugHud } from '../ui/debugHud'
import { traumaFromExplosion } from '../render/cameraRig-math'
import { Mixer } from '../audio/mixer'
import { loadAudio } from '../audio/sfx'

interface RemoteView {
  view: PlayerView
  lastSeen: number
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
  /** Whether the server says the shield is up, and when it went up. */
  private shieldOn = false
  private shieldSince = 0
  private jetReadout: HTMLDivElement | null = null
  /** The private room's join code, once the server has told us (§B9). */
  private joinCode: string | null = null
  private lobbyPanel: HTMLDivElement | null = null
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
   * The whole inventory, quick bar then backpack (§C10).
   *
   * Sized from the constant on the first `inventory` event; the initial length
   * only has to be non-empty, because every read is bounds-checked.
   */
  private slots: Array<{ key: string; count: number } | null> = []
  private health = 100
  private rttSamples = 0
  private rttAcc = 0

  private me = -1
  /** FoV multiplier from the server: fog times the smoke I am standing in. */
  private vision = 1
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
  private scores = new Map<number, { name: string; score: number; deaths: number }>()
  private ready = false
  private lastServerTick = 0
  private serverDarkness = 0

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
   */
  private observed = {
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

  async create(): Promise<void> {
    await loadAssetManifest(this)
    await runLoader(this)

    this.core = this.registry.get('core') as Core
    const params = new URLSearchParams(location.search)

    this.mirror = new WorldMirror(this.core)
    this.interp = new RemoteInterpolator()
    this.clock = new ClockSync()
    this.conn = new Connection()

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
      // §C18: a lobby is a place you wait, so say what is being waited for.
      // `time_left` is finite only while the countdown runs.
      if (this.phase === 'lobby') this.showLobby(this.timeLeft)
      else this.hideLobby()
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
        return { key: String(r['key'] ?? '?'), count: Number(r['count'] ?? 0) }
      })
      const sel = p['selected']
      if (typeof sel === 'number') this.selectedSlot = sel
      this.inventory?.update(
        this.slots.map((sl, i) => ({ slot: i, key: sl?.key ?? null, count: sl?.count ?? 0 })),
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
        this.scores.set(id, { name: String(p['name'] ?? `p${id}`), score: 0, deaths: 0 })
      }
    })
    this.conn.on('player_leave', (raw) => this.dropRemote(Number(asRecord(raw)['id'] ?? -1)))
    // The join code for a private room. Nothing subscribed to this before, so
    // creating a private game never showed anyone the code — which is the only
    // thing a private game is for (§A39, and the M10 checkpoint found it).
    this.conn.on('room_created', (raw) => {
      const code = asRecord(raw)['code']
      if (typeof code === 'string' && code.length > 0) this.showJoinCode(code)
    })
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
        } else if (ev === 'effect_phase') {
          this.topHud?.setEffectPhase(id, String(p['phase'] ?? 'active') as EffectPhase)
        } else {
          this.topHud?.endEffect(id)
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
        // docs/30 §3: right-click toggles the inventory panel. It is client-side
        // and sends nothing; the round keeps running while it is open.
        // §C10: right-click reveals the backpack's two rows. Client-side, sends
        // nothing, and **not a pause** — the round runs behind it, exactly as
        // §B4 established for the death screen.
        this.invOpen = this.inventory?.toggle() ?? !this.invOpen
        this.audio.play('ui_click', { volume: 0.5 })
        this.refreshHud()
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
      this.topHud = null
      this.bars?.destroy()
      this.bars = null
      this.inventory?.destroy()
      this.inventory = null
      this.escapeMenu?.destroy()
      this.escapeMenu = null
      this.debugMode?.destroy()
      this.debugMode = null
      this.overlay?.destroy()
      this.overlay = null
      this.jetReadout?.remove()
      this.jetReadout = null
      this.hideJoinCodeBanner()
      this.feel?.destroy()
      this.minimap?.destroy()
      this.debugHud?.destroy()
      this.world?.destroy()
      this.lightmap.destroy()
      this.sky.destroy()
      this.fx?.destroy()
      for (const r of this.remotes.values()) r.view.destroy()
    })

    // §C17: the handle is a **development** surface. `devSurface()` folds to a
    // literal at build time, so in a production bundle this whole call and the
    // body it reaches are deleted rather than merely unreachable.
    if (devSurface() && params.get('e2e') === '1') this.exposeDebugHandle()

    const name = params.get('name') ?? `player${Math.floor(Math.random() * 1000)}`
    try {
      const w = await this.conn.connect(
      undefined,
      name,
      Number(localStorage.getItem('deepcut.skin') ?? 0),
      // What the menu chose, if the player came through it. `?game=1` skips the
      // front end entirely, and then this is undefined and a plain `join`
      // happens — which is what every check written before the menu expects.
      this.registry.get('lobbyIntent') as LobbyIntent | undefined,
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
    for (const p of w.players) {
      this.scores.set(p.id, { name: p.name ?? `p${p.id}`, score: p.score, deaths: 0 })
    }
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

    this.localView?.destroy()
    this.localView = new PlayerView(this, 0)
    this.localView.container.setDepth(DEPTH.actors)

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
      const up = flag(mine.flags, FLAG.shield)
      if (up && !this.shieldOn) this.shieldSince = this.serverRoundTime
      this.shieldOn = up
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
      case 'projectile_spawn':
        this.observed.projectileSpawns += 1
        this.audio.spatial(
          String(p['weapon'] ?? '') === 'grenade' ? 'fire_grenade' : 'fire_bazooka',
          x,
          y,
          ear,
        )
        break
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

  override update(_time: number, delta: number): void {
    // §C12's FPS counter, from real frame timestamps and not from Phaser's
    // smoothed average (§A38). Sampled every frame whether or not the mode is on,
    // so switching it on reports the rate you already had rather than starting a
    // fresh window that reads 0 for half a second.
    this.debugMode?.update(_time)
    if (!this.ready) return
    const dt = delta / 1000
    if (!this.ready || !this.world || !this.predictor) return

    // Fixed timestep. Stepping by the frame delta would make movement depend on
    // the frame rate, and the whole point of shipping game-core to the browser
    // is that it runs the simulation the server runs.
    const step = C().SIM_DT
    this.acc = Math.min(this.acc + dt, 0.25)
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
        shield: false,
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
      let toxic = false
      for (const e of this.observed.effects.values()) {
        if (e.kind === 'ToxicRain' && e.phases.has('active') && !e.phases.has('end')) toxic = true
      }
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
      this.world.update(this.world.rig.center, dt, {
        toxicActive: toxic,
        vents: [],
        fallScale: C().MAX_FALL_SPEED,
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
      flashlightOn: false,
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
      flashlightOn: false,
    })

    for (const [id, p] of sampled) {
      let r = this.remotes.get(id)
      if (!r) {
        r = { view: new PlayerView(this, 0), lastSeen: now }
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
        selectSlot: (slot) => {
          this.selectedSlot = slot
          this.conn.sendSelectSlot(slot)
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

  /**
   * Show the host their join code.
   *
   * Displayed until the round leaves warmup, because that is when you would
   * read it to someone; after that it moves into the HUD strip so it is
   * recoverable without being in the way. It is DOM, like every other
   * screen-space element here (§A35).
   */
  private showJoinCode(code: string): void {
    this.joinCode = code
    if (this.codeBanner) return
    const el = document.createElement('div')
    el.id = 'join-code'
    el.style.cssText =
      'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:11;' +
      'font:14px/1.6 monospace;color:#e8ecff;text-align:center;pointer-events:none;' +
      'background:rgba(6,10,26,0.72);padding:6px 14px;border-radius:4px;'
    el.innerHTML =
      `<div style="opacity:.7">Invite with this code</div>` +
      `<b style="font-size:2rem;letter-spacing:.5rem;color:#ffd23f">${code}</b>`
    document.body.appendChild(el)
    this.codeBanner = el
  }

  /**
   * The lobby overlay: who is here, the countdown, and "Start with bots".
   *
   * §C18. It lives in `GameScene` and not in a scene of its own because the
   * player is already *in* the room — the socket is here, and the map is
   * already loaded behind it, which is the point of generating it when the room
   * is created. A second scene would be a second lobby to keep in step, which
   * is the shape of defect this milestone exists to end (§C0).
   *
   * DOM, like every other screen-space element here (§A35): a Phaser object with
   * `scrollFactor(0)` still has camera zoom applied and lands off-viewport.
   */
  private showLobby(countdown: number): void {
    const humans = this.scores.size
    const counting = Number.isFinite(countdown) && countdown > 0
    const line = counting
      ? `Starting in ${Math.ceil(countdown)}…`
      : `Waiting for another player — or start now with bots.`

    if (!this.lobbyPanel) {
      const el = document.createElement('div')
      el.id = 'lobby-panel'
      el.style.cssText =
        'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:14;' +
        'font:16px/1.7 system-ui,sans-serif;color:#e8ecff;text-align:center;' +
        'background:rgba(6,10,26,0.88);padding:22px 34px;border-radius:8px;' +
        'min-width:320px;'
      document.body.appendChild(el)
      this.lobbyPanel = el
    }
    const el = this.lobbyPanel
    // Rebuilt each update, so the button is re-bound with it.
    el.innerHTML =
      `<div style="font-size:1.4rem;font-weight:700;margin-bottom:6px">Lobby</div>` +
      `<div id="lobby-roster" style="opacity:.85">${humans} player${humans === 1 ? '' : 's'} here</div>` +
      `<div id="lobby-status" style="margin:10px 0 14px">${line}</div>` +
      `<button id="lobby-start" style="font:15px system-ui;padding:8px 18px;` +
      `border-radius:5px;border:0;background:#3d5afe;color:#fff;cursor:pointer">` +
      `Start with bots</button>`
    el.querySelector('#lobby-start')?.addEventListener('click', () => {
      this.conn.sendStartWithBots()
    })
  }

  private hideLobby(): void {
    this.lobbyPanel?.remove()
    this.lobbyPanel = null
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
      health: healthBar(this.health, c.BASE_HEALTH, c.HEALTH_CAP),
      energy: energyBar(this.battery, c.BATTERY_MAX),
      jetpack: jetpackBar(this.fuel, c.JETPACK_MAX_FUEL, waiting),
      consumables: { heals: this.heals, batteries: this.batteries },
      shield: shieldRing(
        this.shieldOn,
        this.shieldSince,
        this.serverRoundTime,
        c.SHIELD_DURATION,
        this.battery,
        c.SHIELD_DRAIN,
      ),
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
          /** Read from the DOM: what the host can actually see, not what we sent. */
          visibleCode:
            document.querySelector('#join-code b')?.textContent?.trim() ??
            (self.joinCode && self.hud?.textContent?.includes(self.joinCode)
              ? self.joinCode
              : ''),
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
            health: healthBar(self.health, C().BASE_HEALTH, C().HEALTH_CAP),
            energy: energyBar(self.battery, C().BATTERY_MAX),
            jetpack: jetpackBar(self.fuel, C().JETPACK_MAX_FUEL, false),
            shieldOn: self.shieldOn,
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
        return C()
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
