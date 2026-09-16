/**
 * The registry and the art must not drift apart.
 *
 * `assets/skins.json` names the tombstone skins and
 * `render/tombstoneTextures.ts` draws them — two files describing one thing,
 * which §A24 is the whole reason this project keeps auditing. Rather than plumb
 * one through the other for five entries, the duplication is *checked*: this is
 * the "stops the registry and the art drifting apart" test T10.05 asks for.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TOMBSTONE_ART, tombstoneArt } from './tombstoneTextures'

interface StoneEntry {
  id: number
  name: string
  atlas: string | null
  frame: string
}

const registry = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../assets/skins.json', import.meta.url)), 'utf8'),
) as { tombstones?: StoneEntry[] }

describe('tombstone registry', () => {
  it('lists a tombstone for every drawn marker, in the same order', () => {
    const stones = registry.tombstones ?? []
    expect(stones.map((s) => [s.id, s.name, s.frame])).toEqual(
      TOMBSTONE_ART.map((a) => [a.id, a.name, a.key]),
    )
  })

  it('has contiguous ids from 0, because they are wire values', () => {
    // `tombstone_skin_id` goes on the wire (§B9) and every reader falls back to
    // 0, so a gap would resolve to the default and look like a bug in the picker.
    expect(TOMBSTONE_ART.map((a) => a.id)).toEqual(TOMBSTONE_ART.map((_, i) => i))
  })

  it('marks every entry procedural', () => {
    // `atlas: null` is the convention weapons already use for art no Kenney pack
    // ships. If one of these ever gains a packed frame, this test should be the
    // thing that makes someone say so deliberately.
    for (const s of registry.tombstones ?? []) expect(s.atlas).toBeNull()
  })

  it('gives every marker a distinct name', () => {
    // Five options that read the same in the picker are one option.
    const names = new Set(TOMBSTONE_ART.map((a) => a.name))
    expect(names.size).toBe(TOMBSTONE_ART.length)
  })
})

describe('tombstoneArt', () => {
  it('resolves each id to its own art', () => {
    for (const a of TOMBSTONE_ART) expect(tombstoneArt(a.id).key).toBe(a.key)
  })

  it('falls back to 0 for an unknown id rather than throwing', () => {
    // docs/50 §8: the id arrives over the wire from a client this server does
    // not validate, so "unknown" is a normal input, not a corrupt one.
    for (const bad of [-1, 99, 5, Number.NaN]) {
      expect(tombstoneArt(bad).id).toBe(0)
    }
  })
})
