/**
 * The client's view of the server's world.
 *
 * It maintains state and **does not render** — scenes read from it. That
 * separation is what lets the whole thing be unit tested without Phaser, which
 * matters here because carve ordering is the single place a client can silently
 * corrupt itself.
 */

import type { Core } from '../core'
import { fromBase64 } from './connection'
import { decodeMapInit, decodeSnapshot, type MapInit, type Snapshot } from './codec'
import type { TombstoneView } from '../render/tombstones-math'

export interface RemotePlayerState {
  id: number
  x: number
  y: number
  vx: number
  vy: number
  aim: number
  health: number
  flags: number
  jetpackFuel: number
  /** `null` when the player is holding nothing. */
  selectedItem: number | null
  /** Server time this state was sampled at, for the interpolator. */
  time: number
}

export interface WorldItemView {
  id: number
  /**
   * The registry id of what is lying there, or **`null` when the server has not
   * said**.
   *
   * `crate_spawn` carries only `{tick, world_item_id, x, y}` (`docs/40` §
   * "Server -> client events"), so a client that watches a crate arrive is never
   * told its contents. This used to read `n(p['item_id'])` for both arms, which
   * is **0** for a crate — and 0 is `MEDKIT`. Every crate was therefore
   * labelled "Medkit" on the client that saw it land, and T19.17 spent a whole
   * task on "a MEDKIT crate that could not be picked up" before the server's own
   * copy turned out to hold two molotovs. A field that means both "medkit" and
   * "nobody told me" is the §A39 shape CLAUDE.md names; `null` is the honest
   * answer and forces every reader to decide what to do about it.
   *
   * A client that joins *after* the crate landed does learn the contents — the
   * join catch-up re-sends every live item as `item_spawn`, item id and all
   * (`session.rs:1265`). So this is `null` for the watcher and a number for the
   * joiner, which is a genuine asymmetry on the wire and is written up as a
   * finding rather than papered over here.
   */
  item: number | null
  /** Stack size, or `null` when the server has not said — see `item`. */
  count: number | null
  x: number
  y: number
  source: string
  /**
   * Has it come to rest? Nothing tracked this before T13.05, which is why
   * `isFallingCrate` sat here for three milestones taking an argument no caller
   * could supply — and why crates were drawn hanging in the sky (§C7).
   */
  grounded: boolean
}

/** A bird in flight (§C16). `kind` 0 is normal, 1 is metal. */
export interface BirdView {
  id: number
  kind: number
  x: number
  y: number
  right: boolean
}

export interface ProjectileView {
  id: number
  weapon: number
  owner: number
  x: number
  y: number
  vx: number
  vy: number
}

export interface MirrorStats {
  carvesApplied: number
  pendingCarves: number
  resyncs: number
  checksumMismatches: number
  checksumsChecked: number
}

/** How long a carve gap may persist before the local mask is declared lost. */
const CARVE_GAP_TIMEOUT_MS = 2000

type Pending = { seq: number; apply: () => void }

export class WorldMirror {
  readonly players = new Map<number, RemotePlayerState>()
  readonly items = new Map<number, WorldItemView>()
  /**
   * The graveyard (§B8). Kept as current state rather than a stream of events,
   * so a client that missed a despawn converges on the next full list and a
   * mid-round joiner starts from the server's own set.
   */
  readonly tombstones = new Map<number, TombstoneView>()
  readonly projectiles = new Map<number, ProjectileView>()
  /** §C16. Server-simulated; the client only draws what it is told. */
  readonly birds = new Map<number, BirdView>()

  private readonly core: Core
  private nextCarveSeq = 0
  private readonly buffered = new Map<number, Pending>()
  private gapSince: number | null = null
  private mapLoaded = false

  readonly stats: MirrorStats = {
    carvesApplied: 0,
    pendingCarves: 0,
    resyncs: 0,
    checksumMismatches: 0,
    checksumsChecked: 0,
  }

  /** Called when the local mask is provably wrong and must be refetched. */
  onResyncNeeded: (() => void) | null = null

  constructor(core: Core) {
    this.core = core
  }

  get loaded(): boolean {
    return this.mapLoaded
  }

  get pendingCarves(): number {
    return this.buffered.size
  }

  applyMapInitB64(b64: string): MapInit {
    return this.applyMapInit(decodeMapInit(fromBase64(b64)))
  }

  applyMapInit(m: MapInit): MapInit {
    if (!this.core.loadMask(m.width, m.height, m.rle)) {
      throw new Error('map_init: mask failed to load')
    }
    // **Before any carve is applied.** §C5's pads are indestructible, and this
    // core runs the same `carve_circle` the server does — without them it digs
    // pixels the server refused and the two masks part company one pad-sized
    // patch at a time. It lives here rather than in the scene because this is
    // the layer that owns the mask, and a renderer-only install would look
    // correct and diverge silently.
    this.core.setTeleportPads(m.pads)
    // A resync restarts the carve stream: the mask we just loaded already
    // contains every carve the server has applied, so anything buffered is
    // either already baked in or about to be re-sent.
    this.buffered.clear()
    this.gapSince = null
    // Pick the stream up where this mask leaves off. Resetting to 0 instead is
    // how every carve became a full resync: the world's first carve is `seq 1`,
    // so a client expecting 0 buffers it, times out, and refetches the map —
    // for every rocket, forever.
    this.nextCarveSeq = m.carveSeq + 1
    this.mapLoaded = true
    return m
  }

  applySnapshotB64(b64: string, now: number): Snapshot {
    return this.applySnapshot(decodeSnapshot(fromBase64(b64)), now)
  }

  applySnapshot(s: Snapshot, now: number): Snapshot {
    const seen = new Set<number>()
    for (const p of s.players) {
      seen.add(p.id)
      this.players.set(p.id, {
        id: p.id,
        x: p.x,
        y: p.y,
        vx: p.vx,
        vy: p.vy,
        aim: p.aim,
        health: p.health,
        flags: p.flags,
        jetpackFuel: p.jetpackFuel,
        selectedItem: p.selectedItem,
        time: now,
      })
    }
    // A player absent from a snapshot has left: the snapshot is the full roster,
    // not a delta (`docs/40` §3), so keeping stale entries would leave ghosts.
    for (const id of [...this.players.keys()]) {
      if (!seen.has(id)) this.players.delete(id)
    }
    return s
  }

  /**
   * Apply a carve, or buffer it if it arrived ahead of its predecessor.
   *
   * Order is the whole game here. Carves are integer-exact, so applying them in
   * the server's order gives a bit-identical mask; applying them out of order
   * does not, and every prediction and collision after that is wrong.
   */
  applyCarve(seq: number, fn: () => void, now: number): void {
    if (seq < this.nextCarveSeq) return // duplicate; already applied
    this.buffered.set(seq, { seq, apply: fn })
    this.drainCarves(now)
  }

  private drainCarves(now: number): void {
    for (;;) {
      const next = this.buffered.get(this.nextCarveSeq)
      if (!next) break
      next.apply()
      this.buffered.delete(this.nextCarveSeq)
      this.nextCarveSeq++
      this.stats.carvesApplied++
    }
    this.stats.pendingCarves = this.buffered.size

    if (this.buffered.size === 0) {
      this.gapSince = null
      return
    }
    // Something is buffered and cannot be applied, so a `seq` is missing.
    this.gapSince ??= now
    if (now - this.gapSince > CARVE_GAP_TIMEOUT_MS) {
      this.requestResync()
    }
  }

  /** Drives the gap timeout without needing a carve to arrive. */
  tick(now: number): void {
    if (this.buffered.size > 0) this.drainCarves(now)
  }

  private requestResync(): void {
    this.stats.resyncs++
    this.buffered.clear()
    this.gapSince = null
    this.onResyncNeeded?.()
  }

  /**
   * Compare the server's mask hash with ours. A mismatch means the terrain has
   * diverged, which is the bug this whole ordering discipline exists to prevent
   * — so it resyncs rather than trying to repair.
   */
  verifyChecksum(serverHashHex: string): boolean {
    // Before `map_init` lands there is nothing meaningful to compare: the core
    // still holds whatever map it was constructed with, so every checksum
    // "mismatches" and the client resyncs in a loop it can never win.
    if (!this.mapLoaded) return true
    this.stats.checksumsChecked++
    const ours = hex(this.core.maskHash())
    // The server truncates to 8 bytes (`docs/40` §5); compare the common prefix
    // so a shorter server hash is not read as a mismatch.
    const n = Math.min(ours.length, serverHashHex.length)
    const match = n > 0 && ours.slice(0, n) === serverHashHex.slice(0, n)
    if (!match) {
      this.stats.checksumMismatches++
      this.requestResync()
    }
    return match
  }

  // ---------------------------------------------------------------- events

  applyEvent(name: string, p: Record<string, unknown>, now: number): void {
    switch (name) {
      case 'carve': {
        const seq = n(p['seq'])
        const x = n(p['x'])
        const y = n(p['y'])
        const r = n(p['r'])
        this.applyCarve(seq, () => this.core.carve(x, y, r), now)
        break
      }
      case 'carve_capsule': {
        const seq = n(p['seq'])
        const x0 = n(p['x0'])
        const y0 = n(p['y0'])
        const x1 = n(p['x1'])
        const y1 = n(p['y1'])
        const r = n(p['r'])
        this.applyCarve(seq, () => this.core.carveCapsule(x0, y0, x1, y1, r), now)
        break
      }
      case 'item_spawn':
      case 'crate_spawn': {
        const id = n(p['world_item_id'])
        // **Only what the payload actually carries.** `crate_spawn` has no
        // `item_id` and no `count`, and defaulting them to `n(undefined)` = 0
        // and 1 fabricated a MEDKIT holding one of itself — see `item` on
        // `WorldItemView`. `undefined` is the one value that distinguishes "the
        // server did not say" from a real id of 0, so it is tested for rather
        // than coerced.
        const rawItem = p['item_id']
        const rawCount = p['count']
        this.items.set(id, {
          id,
          item: rawItem === undefined || rawItem === null ? null : n(rawItem),
          count: rawCount === undefined || rawCount === null ? null : n(rawCount, 1),
          x: n(p['x']),
          y: n(p['y']),
          source: String(p['source'] ?? (name === 'crate_spawn' ? 'Crate' : 'Initial')),
          // The join snapshot knows; a spawn event is by definition mid-air.
          grounded: p['grounded'] === true,
        })
        break
      }
      case 'item_move': {
        // Where it actually is. `item_spawn` gives the position an item was
        // *created* at, which for a crate is the sky — and until this arm
        // existed that was the only position the client ever heard, so a crate
        // hung at y=48 for the rest of the round while the real one lay on the
        // ground being picked up by people who walked over it by accident.
        const it = this.items.get(n(p['world_item_id']))
        if (!it) break
        it.x = n(p['x'])
        it.y = n(p['y'])
        it.grounded = p['grounded'] === true
        break
      }
      case 'bird_spawn': {
        const id = n(p['id'])
        this.birds.set(id, {
          id,
          kind: n(p['kind']),
          x: n(p['x']),
          y: n(p['y']),
          right: p['right'] === true,
        })
        break
      }
      case 'bird_move': {
        // As with `item_move` and `projectile_move`: without this the client
        // holds the position the bird was *created* at, which is off the edge
        // of the map, and draws nothing for the whole crossing.
        const b = this.birds.get(n(p['id']))
        if (!b) break
        const x = n(p['x'])
        // Facing follows travel, so a bird re-seen after a dropped packet is
        // still drawn pointing the way it is going.
        b.right = x >= b.x
        b.x = x
        b.y = n(p['y'])
        break
      }
      case 'bird_despawn':
        this.birds.delete(n(p['id']))
        break
      case 'tombstone_spawn': {
        const id = n(p['id'])
        this.tombstones.set(id, {
          id,
          owner: n(p['owner']),
          x: n(p['x']),
          y: n(p['y']),
          skinId: n(p['skin_id']),
        })
        break
      }
      case 'tombstone_despawn':
        this.tombstones.delete(n(p['id']))
        break
      case 'item_pickup':
      case 'item_despawn':
        this.items.delete(n(p['world_item_id']))
        break
      case 'projectile_spawn': {
        const id = n(p['id'])
        this.projectiles.set(id, {
          id,
          weapon: n(p['weapon']),
          owner: n(p['owner']),
          x: n(p['x']),
          y: n(p['y']),
          vx: n(p['vx']),
          vy: n(p['vy']),
        })
        break
      }
      // Where it has got to. Without this the map below holds the position a
      // projectile was *created* at for the whole of its life, and everything
      // downstream draws it there — a rocket as a dot on the muzzle, a meteor
      // above the top of the map. Exactly what `item_move` fixed for crates
      // (§C7); this is the same defect one layer over, and it is the single
      // cause behind both §C22 and §C23.
      case 'projectile_move': {
        const live = this.projectiles.get(n(p['id']))
        // Only for one we already know about: a `move` that arrived after its
        // `despawn` (or before its `spawn`, on a reconnect) must not resurrect a
        // projectile with no weapon, which would draw as a fragment forever.
        if (live) {
          live.x = n(p['x'], live.x)
          live.y = n(p['y'], live.y)
        }
        break
      }
      case 'projectile_despawn':
        this.projectiles.delete(n(p['id']))
        break
      case 'mask_checksum':
        this.verifyChecksum(String(p['hash'] ?? ''))
        break
      default:
        break
    }
  }
}

function n(v: unknown, dflt = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt
}

export function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
