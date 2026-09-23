import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  validateRegistry,
  resolveSkin,
  framesFor,
  parseTint,
  resolveWeaponSkin,
  accessoryScale,
  accessoryY,
  GLASSES_WIDTH_FRACTION,
  HAT_WIDTH_FRACTION,
  spriteScale,
  animKey,
  FALLBACK_SKIN_ID,
  type SkinRegistry,
} from './skins-math'

const atRoot = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url))

function loadRegistry(): SkinRegistry {
  return JSON.parse(readFileSync(atRoot('assets/skins.json'), 'utf8')) as SkinRegistry
}

describe('skins.json, as shipped', () => {
  it('validates', () => {
    expect(validateRegistry(loadRegistry())).toEqual([])
  })

  it('every referenced frame exists in the atlas it names', () => {
    // The check that actually matters: a registry can be structurally perfect
    // and still name frames the atlas has never heard of, which shows up as a
    // magenta box at runtime rather than as a failure here.
    const reg = loadRegistry()
    const atlases = new Map<string, Set<string>>()
    const missing: string[] = []

    for (const skin of reg.players) {
      if (!atlases.has(skin.atlas)) {
        const p = atRoot(`assets/atlas/${skin.atlas}.json`)
        if (!existsSync(p)) {
          // Atlases are committed, but a checkout that has not run the build
          // script should skip rather than fail — the game falls back anyway.
          atlases.set(skin.atlas, new Set())
          continue
        }
        const json = JSON.parse(readFileSync(p, 'utf8')) as { frames: Record<string, unknown> }
        atlases.set(skin.atlas, new Set(Object.keys(json.frames)))
      }
      const have = atlases.get(skin.atlas)
      if (!have || have.size === 0) continue
      for (const state of Object.keys(skin.frames) as (keyof typeof skin.frames)[]) {
        for (const frame of framesFor(skin, state)) {
          if (!have.has(frame)) missing.push(`${skin.name}: ${frame}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('covers every id the server can hand out', () => {
    // MAX_PLAYERS is 6 and the join payload's skin_id is unvalidated, so ids
    // 0..5 must at least resolve. Higher ids fall back, which is also tested.
    const reg = loadRegistry()
    for (let id = 0; id < 6; id++) {
      expect(resolveSkin(reg, id), `skin ${id}`).not.toBeNull()
    }
  })
})

describe('validateRegistry', () => {
  it('reports duplicate ids rather than silently picking one', () => {
    const reg = {
      version: 1,
      players: [
        { id: 0, name: 'a', atlas: 'chars', prefix: 'p_', frames: { idle: ['i'] }, anchor: { x: 0.5, y: 0.9 }, tint: null },
        { id: 0, name: 'b', atlas: 'chars', prefix: 'q_', frames: { idle: ['i'] }, anchor: { x: 0.5, y: 0.9 }, tint: null },
      ],
      weapons: [],
    }
    expect(validateRegistry(reg).join()).toMatch(/duplicate player skin id 0/)
  })

  it('reports a registry with no skin 0, because every fallback needs it', () => {
    const reg = {
      version: 1,
      players: [
        { id: 3, name: 'a', atlas: 'chars', prefix: 'p_', frames: { idle: ['i'] }, anchor: { x: 0.5, y: 0.9 }, tint: null },
      ],
      weapons: [],
    }
    expect(validateRegistry(reg).join()).toMatch(/no skin with id 0/)
  })

  it('rejects non-objects without throwing', () => {
    expect(validateRegistry(null).length).toBe(1)
    expect(validateRegistry(42).length).toBe(1)
    expect(validateRegistry({ players: [] }).length).toBeGreaterThan(0)
  })
})

describe('resolveSkin', () => {
  const reg = loadRegistry()

  it('returns the requested skin when it exists', () => {
    expect(resolveSkin(reg, 2)?.id).toBe(2)
  })

  it('falls back to skin 0 for an unknown id, and does not throw', () => {
    expect(resolveSkin(reg, 999)?.id).toBe(FALLBACK_SKIN_ID)
    expect(resolveSkin(reg, -1)?.id).toBe(FALLBACK_SKIN_ID)
  })

  it('returns null rather than throwing when there is no registry at all', () => {
    expect(resolveSkin(null, 0)).toBeNull()
  })
})

describe('framesFor', () => {
  const skin = resolveSkin(loadRegistry(), 0)!

  it('prefixes every frame name', () => {
    for (const f of framesFor(skin, 'walk')) expect(f.startsWith(skin.prefix)).toBe(true)
  })

  it('falls back to idle for a state the skin does not define', () => {
    const bare = { ...skin, frames: { idle: ['idle'] } }
    expect(framesFor(bare, 'jetpack')).toEqual([`${skin.prefix}idle`])
  })

  it('returns an empty list, not undefined, for an empty skin', () => {
    const empty = { ...skin, frames: {} }
    expect(framesFor(empty, 'idle')).toEqual([])
  })
})

describe('animKey', () => {
  it('is stable and distinct per skin and state', () => {
    const reg = loadRegistry()
    const a = resolveSkin(reg, 0)!
    const b = resolveSkin(reg, 1)!
    expect(animKey(a, 'walk')).toBe(animKey(a, 'walk'))
    expect(animKey(a, 'walk')).not.toBe(animKey(b, 'walk'))
    expect(animKey(a, 'walk')).not.toBe(animKey(a, 'idle'))
  })
})

describe('parseTint', () => {
  it('parses a hex string', () => {
    expect(parseTint('0xff8a7a')).toBe(0xff8a7a)
  })
  it('treats null and nonsense as no tint', () => {
    expect(parseTint(null)).toBeUndefined()
    expect(parseTint('not a colour')).toBeUndefined()
    expect(parseTint(undefined)).toBeUndefined()
  })
})

describe('resolveWeaponSkin', () => {
  it('finds a weapon by key', () => {
    expect(resolveWeaponSkin(loadRegistry(), 'bazooka')?.frame).toBe('bazooka_default')
  })
  it('returns null for an unknown weapon rather than throwing', () => {
    expect(resolveWeaponSkin(loadRegistry(), 'railgun')).toBeNull()
  })
})

describe('spriteScale', () => {
  it('makes 110px art cover a 28px body with the documented overshoot', () => {
    // 28 * 1.55 / 110 — the sprite is a little taller than the hitbox, which is
    // the platformer convention anchor.y exists to reconcile.
    expect(spriteScale(110, 28)).toBeCloseTo((28 * 1.55) / 110, 6)
  })
  it('is 1 for degenerate art rather than dividing by zero', () => {
    expect(spriteScale(0, 28)).toBe(1)
  })
})

describe('accessory placement (T20.12)', () => {
  // `PLAYER_H` 28 x the 1.55 overshoot, and `PlayerView`'s fallback anchor.
  const drawn = 43.4
  const anchorY = 0.9
  const top = -drawn * anchorY

  it('puts the hat above the glasses, both inside the drawn figure', () => {
    const bottom = drawn * (1 - anchorY)
    const hat = accessoryY(drawn, anchorY, 'hat')
    const glasses = accessoryY(drawn, anchorY, 'glasses')
    expect(hat).toBeGreaterThan(top)
    expect(glasses).toBeLessThan(bottom)
    expect(hat).toBeLessThan(glasses)
  })

  /**
   * **The bands must not overlap**, and this is the assertion that keeps them
   * apart. `PlayerView` anchors the hat by its bottom and the glasses by their
   * centre, so their extents are computable here — and if they ever share a strip
   * of the sprite, `skins.mjs` loses its control region and can no longer say
   * which accessory moved a pixel.
   */
  it('a drawn hat ends above where the glasses begin', () => {
    const hatH = 9 * accessoryScale(14, 16, HAT_WIDTH_FRACTION)
    const glassesH = 4 * accessoryScale(12, 16, GLASSES_WIDTH_FRACTION)
    const hatBottom = accessoryY(drawn, anchorY, 'hat')
    const glassesTop = accessoryY(drawn, anchorY, 'glasses') - glassesH / 2
    expect(hatBottom).toBeLessThanOrEqual(glassesTop)
    // The presence half: both are actually drawn something, so "they do not
    // overlap" is not satisfied by two accessories of zero height.
    expect(hatH).toBeGreaterThan(2)
    expect(glassesH).toBeGreaterThan(2)
  })

  it('scales with the drawn height, not with the hitbox', () => {
    // The art overshoots the hitbox, so an offset pinned to `PLAYER_H` would put
    // a hat in the middle of the character's face the day `overshoot` moves.
    const small = accessoryY(20, anchorY, 'hat')
    const large = accessoryY(60, anchorY, 'hat')
    expect(large).toBeLessThan(small)
    expect(large / small).toBeCloseTo(3, 5)
  })

  it('the two kinds are not the same offset — the control', () => {
    expect(accessoryY(40, 0.9, 'hat')).not.toBeCloseTo(accessoryY(40, 0.9, 'glasses'), 3)
  })

  it('sizes an accessory by width, so silhouettes keep their heights', () => {
    // A top hat is tall and a cap is not; matching heights would flatten both to
    // the same outline, which is the one thing the picker exists to show.
    const s = accessoryScale(14, 16, HAT_WIDTH_FRACTION)
    expect(14 * s).toBeCloseTo(16 * HAT_WIDTH_FRACTION, 6)
    expect(accessoryScale(0, 16, 1)).toBe(1)
  })
})
