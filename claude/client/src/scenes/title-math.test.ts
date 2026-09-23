import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newGuard, runGuarded, runGuardedAsync } from './title-math'

describe('the decorative guard (§E9)', () => {
  it('runs the body while nothing is wrong — the control the rest of this needs', () => {
    const g = newGuard()
    let calls = 0
    for (let i = 0; i < 5; i++) runGuarded(g, () => void calls++, fail)
    expect(calls).toBe(5)
    expect(g.live).toBe(true)
    expect(g.failures).toBe(0)
  })

  it('does not let a throw escape, which is what stopped Phaser’s frame loop', () => {
    const g = newGuard()
    // If this rethrew, the assertion would never be reached — the test *is* the
    // claim. §E9: a throw inside `update()` stops the loop, and after that
    // nothing on the page can be clicked.
    expect(() =>
      runGuarded(
        g,
        () => {
          throw new Error('boom')
        },
        () => {},
      ),
    ).not.toThrow()
  })

  it('reports once and then stops running the body, not once per frame', () => {
    const g = newGuard()
    let calls = 0
    const reports: string[] = []
    for (let i = 0; i < 60; i++) {
      runGuarded(
        g,
        () => {
          calls++
          throw new Error('every frame')
        },
        (m) => reports.push(m),
      )
    }
    // Called once, refused thereafter. A guard that kept calling would report
    // sixty times at 60 Hz, which is the "logs and carries on" shape §E9 rejects.
    expect(calls).toBe(1)
    expect(reports).toEqual(['every frame'])
    expect(g.failures).toBe(1)
    expect(g.live).toBe(false)
    expect(g.reason).toBe('every frame')
  })

  it('keeps a non-Error throw legible rather than rendering it [object Object]', () => {
    const g = newGuard()
    const reports: string[] = []
    runGuarded(
      g,
      () => {
        throw 'a bare string'
      },
      (m) => reports.push(m),
    )
    expect(reports).toEqual(['a bare string'])
  })

  it('latches the same way on the awaited path', async () => {
    const g = newGuard()
    let calls = 0
    const reports: string[] = []
    for (let i = 0; i < 3; i++) {
      await runGuardedAsync(
        g,
        async () => {
          calls++
          throw new Error('load failed')
        },
        (m) => reports.push(m),
      )
    }
    expect(calls).toBe(1)
    expect(reports).toEqual(['load failed'])
    expect(g.live).toBe(false)
  })

  it('lets an awaited body succeed — the presence half of the assertion above', async () => {
    const g = newGuard()
    let calls = 0
    await runGuardedAsync(g, async () => void calls++, fail)
    expect(calls).toBe(1)
    expect(g.live).toBe(true)
  })
})

// §E9: "the title screen must not run the simulation." The guard above stops a
// background from breaking the menu; this stops a *simulation* from being the
// background again. Read from the source, because the claim is about what the
// scene constructs, and no runtime probe can say "this line does not exist".
describe('the title screen does not run the simulation', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(resolve(here, 'TitleScene.ts'), 'utf8')
  // **Comments stripped, because the claim is about code.** The first version of
  // this asserted against the raw file and went red on the scene's own doc
  // comment, which names `Core.attract` precisely to record that it has lost its
  // last caller. A test that forbids a *word* forbids explaining the decision —
  // and it was measuring prose while claiming to measure construction, which is
  // the failure this milestone keeps paying for.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('read the file it is asserting about, and stripped only its comments', () => {
    // Without this the assertions below pass for an empty string, which is what
    // a moved file — or a stripper that ate everything — would hand them.
    expect(src.length).toBeGreaterThan(500)
    expect(src).toContain('SHRED')
    expect(code).toContain('SHRED')
    expect(code).toContain('class TitleScene')
    // The stripper really did remove prose: the scene's doc comment names
    // `Core.attract` and the code must not.
    expect(src).toContain('Core.attract')
    expect(code.length).toBeLessThan(src.length)
  })

  it('constructs no world, no core and no bots', () => {
    for (const forbidden of ['Core.attract', 'AttractCore', 'WorldView', 'PlayerView']) {
      expect(code).not.toContain(forbidden)
    }
  })

  it('does not rebuild itself from inside update()', () => {
    // The 45-second teardown-and-restart ran from `update()`, so a throw there
    // removed the DOM *and* stopped the loop. Nothing in this scene tears down
    // or re-creates anything from the frame callback.
    //
    // **The class, not the one call that did it.** The first version asserted
    // only `this.teardown()`, which a future `this.ui.remove()` or
    // `scene.restart()` would have walked straight past — a guard against the
    // historical instance rather than against the shape.
    const update = code.slice(code.indexOf('override update('))
    for (const forbidden of [
      'this.teardown()',
      'this.buildUi()',
      '.remove()',
      'scene.restart',
      'scene.start',
      'new SkyLayer',
    ]) {
      expect(update).not.toContain(forbidden)
    }
  })

  it('builds the UI before anything that can fail', () => {
    // §E9's ordering, asserted rather than trusted: the old scene awaited two
    // loaders before creating any DOM, so a rejection left a blank page with no
    // button. `buildUi` must come first in `create`.
    const create = code.slice(code.indexOf('async create('), code.indexOf('private teardown('))
    const ui = create.indexOf('this.buildUi()')
    const load = create.indexOf('loadAssetManifest')
    const backdrop = create.indexOf('new SkyLayer')
    expect(ui).toBeGreaterThan(-1)
    expect(load).toBeGreaterThan(ui)
    expect(backdrop).toBeGreaterThan(ui)
  })
})

function fail(msg: string): never {
  throw new Error(`the guard reported a failure it should not have: ${msg}`)
}
