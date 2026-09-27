/**
 * T23.09C F2: false muzzle flashes, tested **through `WorldView.syncProjectiles`** — the call both scenes make every
 * frame — and the effect lights built from what it leaves in the ordnance layer, not through a hand-built trail.
 *
 * `WorldView` is a Phaser object; `syncProjectiles` reads only the ordnance layer and its own bookkeeping, so the view
 * is made without its constructor and handed a real `OrdnanceState` behind the three calls the method makes.
 */
import { describe, expect, it, vi } from 'vitest'
import { OrdnanceState, WEAPON_KEYS } from './ordnance-state'
import { EffectLights, MUZZLE_LIGHT, type EffectSources } from '../look/effectLights'

vi.mock('phaser', () => ({ default: {} }))

const view = { x: 0, y: 0, w: 1280, h: 720 }
/** The layer's beam life and trail length (`BEAM_LIFETIME`, `PROJECTILE_TRAIL_LEN` in the game); neither is read here. */
const LIFE = 0.35
const TRAIL = 12
const SMG = WEAPON_KEYS.indexOf('smg')

async function fixture(): Promise<{ w: import('./worldView').WorldView; state: OrdnanceState }> {
  const { WorldView } = await import('./worldView')
  const state = new OrdnanceState(LIFE, TRAIL)
  const w = Object.create(WorldView.prototype) as import('./worldView').WorldView
  Object.assign(w, {
    tracked: new Map(),
    projectilesAddedByKind: {},
    weaponKeys: WEAPON_KEYS,
    staleRounds: new WeakSet<object>(),
    synced: false,
    ordnance: {
      state,
      addProjectile: (...a: Parameters<OrdnanceState['addProjectile']>) => state.addProjectile(...a),
      moveProjectile: (...a: Parameters<OrdnanceState['moveProjectile']>) => state.moveProjectile(...a),
      removeProjectile: (...a: Parameters<OrdnanceState['removeProjectile']>) => state.removeProjectile(...a),
    },
  })
  return { w, state }
}

const sources = (w: import('./worldView').WorldView, state: OrdnanceState): EffectSources => ({
  projectiles: state.projectiles.values(),
  tracers: state.tracers,
  impacts: state.impacts,
  jets: [],
  vents: [],
  stale: w.staleRounds,
})

const muzzles = (fx: EffectLights): { x: number; y: number }[] =>
  fx.last.filter((_, k) => fx.lastKinds[k] === 'muzzle').map((l) => ({ x: l.x, y: l.y }))

describe('T23.09C F2: a muzzle flashes only where a round was seen leaving the gun', () => {
  it('a round in flight at the first sync (a late join, a new scene) flashes nothing; one fired after does', async () => {
    const { w, state } = await fixture()
    const fx = new EffectLights()
    w.syncProjectiles([{ id: 7, x: 600, y: 300, weapon: SMG }])
    fx.frame(sources(w, state), view)
    expect(muzzles(fx)).toEqual([])
    // Control (presence): a round that appears in a later sync — the sandbox's, fired this frame — flashes where it is.
    w.syncProjectiles([{ id: 7, x: 640, y: 300, weapon: SMG }, { id: 8, x: 200, y: 400, weapon: SMG }])
    fx.frame(sources(w, state), view)
    expect(muzzles(fx)).toEqual([{ x: 200, y: 400 }])
    expect(fx.last.find((_, k) => fx.lastKinds[k] === 'muzzle')!.i).toBe(MUZZLE_LIGHT.i)
  })

  it('a networked round flashes at its spawn point, not where it was first drawn; one with no spawn heard flashes nothing', async () => {
    const { w, state } = await fixture()
    const fx = new EffectLights()
    w.syncProjectiles([])
    // The round has moved on 60 px (a projectile_move arrived before this frame's sync): the flash is at the gun.
    w.syncProjectiles([{ id: 1, x: 460, y: 300, weapon: SMG, origin: { x: 400, y: 300 } }, { id: 2, x: 900, y: 500, weapon: SMG, origin: null }])
    fx.frame(sources(w, state), view)
    expect(muzzles(fx)).toEqual([{ x: 400, y: 300 }])
    // The round itself is drawn where it is.
    expect(state.projectiles.get(1)).toMatchObject({ x: 460, y: 300 })
  })

  it('a stale round stays stale: it never flashes on a later frame either', async () => {
    const { w, state } = await fixture()
    const fx = new EffectLights()
    w.syncProjectiles([{ id: 3, x: 100, y: 100, weapon: SMG }])
    for (let k = 1; k <= 4; k++) {
      w.syncProjectiles([{ id: 3, x: 100 + 20 * k, y: 100, weapon: SMG }])
      fx.frame(sources(w, state), view)
      expect(muzzles(fx)).toEqual([])
    }
  })
})
