/**
 * Every event the mirror handles must actually be subscribed to.
 *
 * `WorldMirror.apply` is a switch over event names and `GameScene` holds the
 * list of names it asks the socket for. Nothing connects the two, so a new arm
 * added to one and not the other is silent: the handler compiles, its unit tests
 * pass, and the event never arrives.
 *
 * That is not hypothetical. `item_move` was written into the mirror, omitted
 * from the subscription list, and the crate went on hanging in the sky through a
 * full green build — three lines below a comment warning about this exact shape.
 *
 * Read as text because `GameScene` imports Phaser, which cannot be loaded under
 * vitest (§A8).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '../../..')
const mirrorSrc = readFileSync(join(root, 'client/src/net/worldMirror.ts'), 'utf8')
const sceneSrc = readFileSync(join(root, 'client/src/scenes/GameScene.ts'), 'utf8')

/** Every `case 'x':` in the mirror's apply switch. */
function handled(): string[] {
  return [...mirrorSrc.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1] as string)
}

/** Every name in the `for (const ev of [...])` subscription list. */
function subscribed(): string[] {
  const m = sceneSrc.match(/for \(const ev of \[([\s\S]*?)\]\)/)
  if (!m) throw new Error('could not find the subscription list in GameScene')
  return [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1] as string)
}

/**
 * Events that reach the mirror by another route and must not be required here.
 * Kept explicit so adding one is a decision rather than a loosened regex.
 */
const OTHER_ROUTES = new Set([
  // Sent once on join as a list, not as a stream (`session.rs` replays them
  // through the same `item_spawn` arm).
  'initial',
])

describe('event wiring', () => {
  it('subscribes to every event the mirror can handle', () => {
    const subs = new Set(subscribed())
    const missing = handled().filter((n) => !subs.has(n) && !OTHER_ROUTES.has(n))
    expect(missing).toEqual([])
  })

  it('finds a non-trivial list at both ends, so it cannot pass on a bad regex', () => {
    // The control. Two empty arrays satisfy the assertion above forever, and a
    // rename of either construct would produce exactly that.
    expect(handled().length).toBeGreaterThan(8)
    expect(subscribed().length).toBeGreaterThan(8)
    expect(handled()).toContain('item_move')
    expect(subscribed()).toContain('item_move')
  })
})
