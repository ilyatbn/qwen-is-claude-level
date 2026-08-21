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
import { OrdnanceLayer } from '../render/ordnance'
import { OrdnanceFxLayer } from '../render/ordnanceFx'
import { hazardKind } from '../render/ordnanceFx-math'
import { ItemLayer } from '../render/itemSprites'
import { cycleU, darknessAt } from '../render/sky-math'
import { formatClock, phaseBanner, rankScores, type Phase } from '../ui/scoreboard'
import { FLAG, flag } from '../net/codec'
import { FeelLayer, type FeelFrame } from '../ui/feelLayer'
import { Minimap } from '../ui/minimap'
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
  private lightmap!: Lightmap
  private ordnance!: OrdnanceLayer
  private fx!: OrdnanceFxLayer
  private items!: ItemLayer
  private localView: PlayerView | null = null
  private remotes = new Map<number, RemoteView>()
  private localInput!: LocalInput
  private crosshair!: Crosshair
  private hud!: HTMLDivElement
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
  private slots: Array<{ key: string; count: number } | null> = Array(8).fill(null)
  private health = 100
  private rttSamples = 0
  private rttAcc = 0

  private me = -1
  /** FoV multiplier from the server: fog times the smoke I am standing in. */
  private vision = 1
  private seq = 0
  private acc = 0
  private roundTime = 0
  private readonly death = new DeathOverlay()
  private tombstones!: TombstoneLayer
  /** The server's word on whether the local player is alive. */
  private meAlive = true
  private phase: Phase = 'lobby'
  private timeLeft = 0
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
    this.ordnance = new OrdnanceLayer(this)
    // §A39 #10: the server has narrated melee, cones, mines and hazards since
    // T11.05 and nothing subscribed. This is the other half.
    this.fx = new OrdnanceFxLayer(this, C().MINE_ARM_TIME)
    this.items = new ItemLayer(this)
    this.tombstones = new TombstoneLayer(this, C().TOMBSTONE_W, C().TOMBSTONE_H)
    this.items.setRegistry(this.core.itemRegistryJson())
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
      this.observed.phases.add(this.phase)
      // The big code is for inviting someone, which is a warmup activity. Once
      // the round is live it belongs in the strip, not across the screen.
      if (this.phase !== 'lobby' && this.phase !== 'warmup') this.hideJoinCodeBanner()
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
      this.slots = Array.from({ length: 8 }, (_, i) => {
        const sl = arr[i]
        if (!sl || typeof sl !== 'object') return null
        const r = sl as Record<string, unknown>
        return { key: String(r['key'] ?? '?'), count: Number(r['count'] ?? 0) }
      })
      const sel = p['selected']
      if (typeof sel === 'number') this.selectedSlot = sel
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
      'item_despawn', 'projectile_spawn', 'projectile_despawn', 'mask_checksum',
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
      this.ordnance.addImpact(x, y, r, 'blast')
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
        cause: attacker === victim ? 'self' : cause === 'weather' ? 'weather' : 'player',
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
      const x0 = Number(p['x0'] ?? 0)
      const y0 = Number(p['y0'] ?? 0)
      this.ordnance.addTracer(x0, y0, Number(p['x1'] ?? 0), Number(p['y1'] ?? 0))
      this.audio.spatial('fire_smg', x0, y0, this.ear())
    })

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (p.rightButtonDown()) {
        // docs/30 §3: right-click toggles the inventory panel. It is client-side
        // and sends nothing; the round keeps running while it is open.
        this.invOpen = !this.invOpen
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
    for (let i = 0; i < 8; i++) {
      const key = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT'][i] as string
      this.input.keyboard?.on(`keydown-${key}`, () => {
        this.selectedSlot = i
        this.conn.sendSelectSlot(i)
        this.audio.play('ui_click', { volume: 0.4 })
        this.refreshHud()
      })
    }
    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      this.selectedSlot = (this.selectedSlot + (dy > 0 ? 1 : 7)) % 8
      this.conn.sendSelectSlot(this.selectedSlot)
      this.refreshHud()
    })
    this.input.keyboard?.on('keydown-E', () => this.conn.sendUseItem(this.selectedSlot))
    this.input.keyboard?.on('keydown-TAB', (e: KeyboardEvent) => {
      e.preventDefault()
      this.scoreboardOpen = !this.scoreboardOpen
      this.refreshHud()
    })

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.conn.close()
      this.audio.stopAll()
      this.items?.destroy()
      this.hud?.remove()
      this.hideJoinCodeBanner()
      this.feel?.destroy()
      this.minimap?.destroy()
      this.debugHud?.destroy()
      this.world?.destroy()
      this.lightmap.destroy()
      this.sky.destroy()
      this.ordnance.destroy()
      this.fx?.destroy()
      for (const r of this.remotes.values()) r.view.destroy()
    })

    if (params.get('e2e') === '1') this.exposeDebugHandle()

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
    this.roundTime = w.roundTime
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
    this.mirror.applyMapInitB64(b64)

    this.world?.destroy()
    this.world = new WorldView(this, this.core)

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
          fuel: (mine.jetpackFuel / 255) * C().JETPACK_MAX_FUEL,
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
        // to be audible even when the sky tint is off-screen.
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
    if (batch.length) {
      this.conn.sendInput(batch.slice(-C().INPUT_REDUNDANCY))
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
      this.world.rig.follow({ x: rp.x, y: rp.y })
      this.movementCues(dt, body)
    }
    this.world.rig.update(dt)
    this.world.update(this.world.rig.center)

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
      this.world.weather.setToxic(toxic)
      this.world.weather.update(dt, [], C().MAX_FALL_SPEED)
    }
    this.ordnance.update(dt)
    // Mine visibility is distance to the *player*, not to the camera centre —
    // the camera leads the aim, so those are not the same point.
    this.fx.update(dt, this.ear(), performance.now())
    // World items were tracked from T6.08 and drawn by nothing: a medkit on the
    // ground was invisible in the real game.
    this.items.update(dt, [...this.mirror.items.values()], this.ear())
    this.tombstones.update([...this.mirror.tombstones.values()])
    this.feel.update(dt, this.feelFrame())

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
      ...this.ordnance
        .lights()
        .map((l) => ({ x: l.x, y: l.y, radius: l.r, kind: 'radial' as const, intensity: l.a })),
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
    const banner = phaseBanner(this.phase, this.timeLeft)
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
    // The always-visible strip: what you are holding and how much of it, so the
    // panel is only needed to change loadout (docs/30 §3).
    const held = this.slots[this.selectedSlot]
    const strip =
      `HP ${Math.round(this.health)}   ${held ? `${held.key} x${held.count}` : '(empty)'}` +
      // Recoverable after the banner goes: someone joining late still needs it.
      (this.joinCode ? `   code ${this.joinCode}` : '')
    const lines = [
      [status, banner ?? formatClock(this.timeLeft), strip].filter((p) => p !== '').join('   │   '),
    ]
    if (this.invOpen) {
      lines.push(
        this.slots
          .map((sl, i) => {
            const label = sl ? `${sl.key} x${sl.count}` : '—'
            return i === this.selectedSlot ? `[${i + 1}:${label}]` : ` ${i + 1}:${label} `
          })
          .join(' '),
      )
    }
    if (this.scoreboardOpen) lines.push(board)
    this.hud.textContent = lines.join('\n')
  }

  private exposeDebugHandle(): void {
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
          },
          /** Read from the DOM: what the host can actually see, not what we sent. */
          visibleCode:
            document.querySelector('#join-code b')?.textContent?.trim() ??
            (self.joinCode && self.hud?.textContent?.includes(self.joinCode)
              ? self.joinCode
              : ''),
          mapW: self.core.width,
          mapH: self.core.height,
          seed: self.core.meta.seed,
          phase: self.phase,
          players: [...self.mirror.players.keys()],
          // Items the server says exist, and items actually on screen. Two
          // numbers rather than one, because they were silently different for
          // three milestones: the mirror tracked them and nothing drew them.
          worldItems: self.mirror.items.size,
          itemsDrawn: self.items?.count ?? 0,
          // Two numbers, not one (§A39): the server's graveyard against the
          // graves actually on screen.
          tombstones: self.mirror.tombstones.size,
          tombstonesDrawn: self.tombstones?.count ?? 0,
          // Count at both ends (§A39). These two numbers were silently
          // different for world items for three milestones; asserting only
          // that the server placed a mine would have passed the whole time.
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
          camera: { x: self.cameras.main.scrollX, y: self.cameras.main.scrollY },
          zoom: self.cameras.main.zoom,
          hazardsDrawn: self.fx?.hazardCount ?? 0,
          // The snapshot roster includes the local player, so this is the
          // total — not remotes plus one.
          playerCount: self.mirror.players.size,
          player: body,
          renderPos: self.predictor?.renderPos ?? null,
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
          // Round state, for a check that has to watch a whole round rather
          // than a moment of one.
          roundTime: self.roundTime,
          timeLeft: self.timeLeft,
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
