import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `scene.start('X')` with `X` unregistered is **silent** (T20.13).
 * `ScenePlugin.start` queues a stop of the current scene and a start of the key;
 * the stop happens, the start finds nothing, and the page is left with no running
 * scene. No warning, no exception, and Phaser's `<canvas>` element outlives every
 * scene — so `document.querySelector('canvas') !== null` is still true over the
 * blank page, which is how `escape-menu.mjs` stayed green over this defect on the
 * `?game=1` flag.
 *
 * `main.ts` closes every dev scene list over the scenes it can reach. This walks
 * the scene sources and fails if the graph that closure reads has fallen behind
 * the `scene.start` calls it is meant to describe.
 */
const here = resolve(dirname(fileURLToPath(import.meta.url)))
const mainSrc = readFileSync(join(here, 'main.ts'), 'utf8')

/**
 * Comments out, then code.
 *
 * Not cosmetic: `GameScene`'s own doc comments say the words
 * `scene.start('Game')`, and scanning them made the scene an edge to itself and
 * the falsification below report two missing edges instead of one.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Every `scene.start('X')` in a scene, as `From -> X`. */
function startsInSources(): Array<{ from: string; to: string }> {
  const dir = join(here, 'scenes')
  const out: Array<{ from: string; to: string }> = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('Scene.ts')) continue
    const src = codeOnly(readFileSync(join(dir, f), 'utf8'))
    // The scene's own key, from `super('Game')`.
    const key = /super\(\s*'([A-Za-z]+)'/.exec(src)?.[1]
    if (!key) continue
    for (const m of src.matchAll(/scene\.start\(\s*'([A-Za-z]+)'/g)) {
      const to = m[1]
      if (to) out.push({ from: key, to })
    }
  }
  return out
}

/** The `SCENE_GRAPH` table in `main.ts`, read as `From -> To` edges. */
function edgesInTable(): Array<{ from: string; to: string }> {
  const table = mainSrc.slice(mainSrc.indexOf('const SCENE_GRAPH'), mainSrc.indexOf('\n]\n'))
  const out: Array<{ from: string; to: string }> = []
  for (const m of table.matchAll(/key: '([A-Za-z]+)'[^}]*?starts: \[([^\]]*)\]/g)) {
    const from = m[1]
    const starts = m[2]
    if (!from || !starts) continue
    for (const t of starts.matchAll(/'([A-Za-z]+)'/g)) {
      const to = t[1]
      if (to) out.push({ from, to })
    }
  }
  return out
}

const key = (e: { from: string; to: string }) => `${e.from} -> ${e.to}`

describe('every scene.start target is registered (T20.13)', () => {
  const inCode = startsInSources()
  const inTable = edgesInTable()

  it('found the calls and the table — without this everything below is vacuous', () => {
    expect(inCode.map(key)).toContain('Game -> Title')
    expect(inCode.map(key)).toContain('Menu -> Game')
    expect(inTable.length).toBeGreaterThan(2)
  })

  it('carries every edge the scenes actually call', () => {
    const missing = inCode.filter((e) => !inTable.some((t) => key(t) === key(e))).map(key)
    expect([...new Set(missing)]).toEqual([])
  })

  it('goes red when an edge is dropped from the table — the falsification', () => {
    const stripped = inTable.filter((e) => key(e) !== 'Game -> Title')
    const missing = inCode.filter((e) => !stripped.some((t) => key(t) === key(e))).map(key)
    expect([...new Set(missing)]).toEqual(['Game -> Title'])
  })

  it('no scene list in main.ts is handed to Phaser without the closure', () => {
    // The defect was a hand-written array, twice. Any `return [` of scene
    // constructors in `pickDevScene` is that shape again — the dev-only scenes
    // (Sandbox, Preview, Boot) are dynamic imports and reach none of these four.
    const dev = codeOnly(mainSrc.slice(mainSrc.indexOf('async function pickDevScene')))
    const bare = [...dev.matchAll(/return \[([^\]]*Scene[^\]]*)\]/g)].map((m) => m[1] ?? '')
    expect(bare.filter((b) => /(Title|Menu|Skins|Game)Scene/.test(b))).toEqual([])
  })
})
