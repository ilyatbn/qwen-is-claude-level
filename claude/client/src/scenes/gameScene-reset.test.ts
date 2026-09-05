import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `GameScene` is constructed **once** and `create()`d on every
 * `scene.start('Game')` (T20.13). So every field with a `= value` initializer
 * survives a round, and the four that were nulled by hand in `SHUTDOWN` were four
 * of thirty-odd — which is how a stale `world` killed the render loop and a stale
 * `scores` carried the last room's players into the next match's scoreboard.
 *
 * `resetForNewRound()` is the one list. This is the guard that keeps it one list:
 * a field added to the class and named in neither the reset nor the exemption
 * table below fails here, at the moment it is added, rather than in whichever
 * browser check happens to re-enter the scene.
 *
 * It reads the source rather than the class because the alternative needs a
 * canvas: instantiating `GameScene` under vitest boots Phaser. The same trade the
 * server's `no_room_list_producer_survives` makes.
 */
const src = readFileSync(
  join(resolve(dirname(fileURLToPath(import.meta.url))), 'GameScene.ts'),
  'utf8',
)

/** `private name` / `private readonly name`, followed by a type, `!`, or `=`. */
const FIELD = /^ {2}private (?:readonly )?([A-Za-z_][A-Za-z0-9_]*)\s*[!?:=]/gm

export function fieldsOf(source: string): string[] {
  return [...source.matchAll(FIELD)].map((m) => m[1] ?? '').filter((n) => n !== '')
}

/** The body of `resetForNewRound`, up to its closing brace at method indent. */
export function resetBody(source: string): string {
  const head = source.indexOf('  private resetForNewRound(): void {')
  if (head < 0) throw new Error('resetForNewRound() is gone — the guard cannot run')
  const end = source.indexOf('\n  }\n', head)
  return source.slice(head, end)
}

/**
 * Fields that legitimately do **not** belong in `resetForNewRound`, each with the
 * reason. Adding a name here is a deliberate act; forgetting one is not possible.
 */
const EXEMPT: Record<string, string> = {
  // Rebuilt by `create()` on every entry, and declared `!` for exactly that.
  core: 'from the registry, every create()',
  conn: 'adopted from MenuScene or constructed, every create()',
  mirror: 'new WorldMirror, every create()',
  interp: 'new RemoteInterpolator, every create()',
  clock: 'new ClockSync, every create()',
  sky: 'new SkyLayer, every create()',
  lightmap: 'new Lightmap, every create()',
  fx: 'new OrdnanceFxLayer, every create()',
  localInput: 'new LocalInput, every create()',
  crosshair: 'new Crosshair, every create()',
  hud: 'buildHud(), every create()',
  feel: 'new FeelLayer, every create()',
  debugHud: 'new DebugHud, every create()',
  tombstones: 'new TombstoneLayer, every create()',
  birds: 'new BirdLayer, every create()',
  results: 'new ResultsScreen, every create()',
  // Deliberately outlives a round.
  audio: 'the Mixer keeps its decoded buffers; initAudio() reassigns it and SHUTDOWN stops it',
  unlockAudio: 'reassigned by initAudio() alongside the Mixer it unlocks',
  repeatFire:
    'readonly, and self-healing: the first frame with the button not held clears it (autoFire.ts)',
}

describe('GameScene survives re-entry, so resetForNewRound must know every field (T20.13)', () => {
  const fields = fieldsOf(src)
  const body = resetBody(src)

  it('found a class to walk — without this the assertion below is vacuous', () => {
    expect(fields.length).toBeGreaterThan(30)
    expect(fields).toContain('scores')
    expect(fields).toContain('world')
    expect(fields).toContain('ready')
  })

  it('resets, or explicitly exempts, every field the constructor initialises', () => {
    const unaccounted = fields.filter((f) => !EXEMPT[f] && !new RegExp(`this\\.${f}\\b`).test(body))
    expect(unaccounted).toEqual([])
  })

  it('names the field it caught, and catches one — the falsification', () => {
    // At the live site: a field declared on the class and mentioned nowhere in
    // the reset. This is the edit a future task will make without thinking.
    const withNewField = src.replace(
      '  private ready = false',
      '  private ready = false\n  private carriedOver = 0',
    )
    expect(withNewField).not.toEqual(src)
    const fs2 = fieldsOf(withNewField)
    expect(fs2).toContain('carriedOver')
    expect(fs2.filter((f) => !EXEMPT[f] && !new RegExp(`this\\.${f}\\b`).test(body))).toEqual([
      'carriedOver',
    ])
  })

  it('does not let a mention outside the method vouch for a field', () => {
    // The body must end at the method's own closing brace. If it ran to the end
    // of the file every field would "pass", which is the vacuous version of this
    // whole test.
    expect(body).toContain('this.scores.clear()')
    expect(body).not.toContain('async create()')
    expect(body.length).toBeLessThan(src.length / 4)
  })

  it('clears the two fields the report was actually about', () => {
    expect(body).toMatch(/this\.ready = false/)
    expect(body).toMatch(/this\.world = null/)
    expect(body).toMatch(/this\.scores\.clear\(\)/)
  })

  it('runs before create() awaits anything — Phaser does not await create()', () => {
    const create = src.slice(src.indexOf('  async create(): Promise<void> {'))
    const reset = create.indexOf('this.resetForNewRound()')
    // A statement-position `await`, not the word: the comment above the call
    // says "Phaser does not await create", and `indexOf('await ')` found that.
    const firstAwait = create.search(/\n\s+await /)
    expect(reset).toBeGreaterThan(-1)
    expect(firstAwait).toBeGreaterThan(-1)
    expect(reset).toBeLessThan(firstAwait)
  })
})
