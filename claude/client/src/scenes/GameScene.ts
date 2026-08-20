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
import { C, Core, dequantizeAngle } from '../core'
import { asRecord, Connection, type Welcome } from '../net/connection'
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
import { cycleU, darknessAt } from '../render/sky-math'
import { formatClock, phaseBanner, rankScores, type Phase } from '../ui/scoreboard'
import { FLAG, flag } from '../net/codec'
import { FeelLayer, type FeelFrame } from '../ui/feelLayer'
import { Minimap } from '../ui/minimap'
import { DebugHud } from '../ui/debugHud'
import { traumaFromExplosion } from '../render/cameraRig-math'

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
  private localView: PlayerView | null = null
  private remotes = new Map<number, RemoteView>()
  private localInput!: LocalInput
  private crosshair!: Crosshair
  private hud!: HTMLDivElement
  private feel!: FeelLayer
  private minimap: Minimap | null = null
  private debugHud!: DebugHud
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
  private seq = 0
  private acc = 0
  private roundTime = 0
  private phase: Phase = 'lobby'
  private timeLeft = 0
  private scores = new Map<number, { name: string; score: number; deaths: number }>()
  private ready = false
  private lastServerTick = 0
  private serverDarkness = 0

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
    this.localInput = new LocalInput(this)
    this.crosshair = new Crosshair(this, DEPTH.hud)
    this.buildHud()
    this.feel = new FeelLayer()
    this.debugHud = new DebugHud(this, C().PLAYER_W, C().PLAYER_H)
    this.input.keyboard?.on('keydown-F3', () => this.debugHud.toggle())
    this.input.keyboard?.on('keydown-M', () => this.minimap?.toggle())

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
    })
    this.conn.on('score', () => this.refreshHud())
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
    for (const ev of ['carve', 'carve_capsule', 'item_spawn', 'crate_spawn', 'item_pickup',
      'item_despawn', 'projectile_spawn', 'projectile_despawn', 'mask_checksum']) {
      this.conn.on(ev, (raw) => {
        this.mirror.applyEvent(ev, asRecord(raw), performance.now())
        if (ev === 'carve' || ev === 'carve_capsule') this.minimap?.setTerrainDirty()
      })
    }
    this.conn.on('explosion', (raw) => {
      const p = asRecord(raw)
      const x = Number(p['x'] ?? 0)
      const y = Number(p['y'] ?? 0)
      const r = Number(p['r'] ?? 0)
      this.ordnance.addImpact(x, y, r, 'blast')
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
    })
    this.conn.on('death', (raw) => {
      const p = asRecord(raw)
      const victim = Number(p['victim'] ?? -1)
      const attacker = p['attacker'] === null ? undefined : Number(p['attacker'])
      const cause = String(p['cause'] ?? 'player')
      const nameOf = (id: number) => this.scores.get(id)?.name ?? `p${id}`
      this.feel.kill({
        victim: nameOf(victim),
        killer: attacker === undefined ? undefined : nameOf(attacker),
        cause: attacker === victim ? 'self' : cause === 'weather' ? 'weather' : 'player',
        by: String(p['by'] ?? cause),
        involvesYou: victim === this.me || attacker === this.me,
      })
    })
    this.conn.on('hitscan', (raw) => {
      const p = asRecord(raw)
      this.ordnance.addTracer(
        Number(p['x0'] ?? 0),
        Number(p['y0'] ?? 0),
        Number(p['x1'] ?? 0),
        Number(p['y1'] ?? 0),
      )
    })

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (p.rightButtonDown()) {
        // docs/30 §3: right-click toggles the inventory panel. It is client-side
        // and sends nothing; the round keeps running while it is open.
        this.invOpen = !this.invOpen
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
      this.hud?.remove()
      this.feel?.destroy()
      this.minimap?.destroy()
      this.debugHud?.destroy()
      this.world?.destroy()
      this.lightmap.destroy()
      this.sky.destroy()
      this.ordnance.destroy()
      for (const r of this.remotes.values()) r.view.destroy()
    })

    if (params.get('e2e') === '1') this.exposeDebugHandle()

    const name = params.get('name') ?? `player${Math.floor(Math.random() * 1000)}`
    try {
      const w = await this.conn.connect(undefined, name, 0)
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

    this.lastServerTick = s.tick
    this.debugHud?.noteSnapshot(now, s.tick)
    this.roundTime = s.roundTime
    this.serverDarkness = s.darkness
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
    }
    this.world.rig.update(dt)
    this.world.update(this.world.rig.center)

    this.renderRemotes(performance.now())

    // Darkness from round time locally, corrected by the server's byte so the
    // two never drift apart (`docs/14` §1).
    const darkness = this.serverDarkness || darknessAt(cycleU(this.roundTime), C().NIGHT_DARKNESS)
    this.sky.update(this.roundTime, darkness)
    this.ordnance.update(dt)
    this.feel.update(dt, this.feelFrame())

    const fov = fovRadius({
      darkness,
      fogMult: 1,
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
      fogMult: 1,
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
      'position:fixed;left:0;right:0;bottom:0;padding:6px 10px;font:12px monospace;' +
      'color:#fff;text-shadow:0 1px 2px #000;pointer-events:none;z-index:10'
    document.body.appendChild(this.hud)
  }

  private setStatus(text: string): void {
    if (this.hud) this.hud.dataset['status'] = text
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
    const strip = `HP ${Math.round(this.health)}   ${held ? `${held.key} x${held.count}` : '(empty)'}`
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
      debug() {
        const body = self.core.playerState(self.me)
        return {
          ready: self.ready,
          me: self.me,
          mapW: self.core.width,
          mapH: self.core.height,
          seed: self.core.meta.seed,
          phase: self.phase,
          players: [...self.mirror.players.keys()],
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
        }
      },
      fire() {
        self.conn.sendFire()
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
