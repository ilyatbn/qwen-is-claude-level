import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Core, C, strictConstants } from './index'
import { deadlineMs } from '../../../scripts/lib/deadline.mjs'

/**
 * T20.15. `scripts/checks/lobby-start.mjs` built a `waitForFunction` timeout from
 * `constants().LOBBY_BOT_TIMEOUT`, which is **not in `constants_json`** — so the
 * read was `undefined`, the arithmetic `NaN`, and the wait had no deadline. It
 * could not fail when the thing it waited for never happened.
 *
 * The one site was the example; the task's deliverable was the grep. These are the
 * three seams that let the shape exist, each closed and each asserted:
 *
 *  1. **The read** — the browser checks are untyped `.mjs`, so nothing caught it.
 *     `strictConstants` throws on a `SCREAMING_CASE` key that is not there.
 *  2. **The arithmetic** — `deadlineMs` refuses anything that is not a positive
 *     finite number of seconds, whatever it was derived from.
 *  3. **The tables** — `constants_json` and the `Constants` interface had drifted
 *     apart in three names, so a check could read a constant TypeScript could not.
 */
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')

// The bytes, as `index.test.ts` does it: under vitest there is no fetch and no
// bundler to resolve `pkg/game_wasm_bg.wasm` by URL.
await Core.init(readFileSync(join(here, 'pkg/game_wasm_bg.wasm')))

/** Every `constants().NAME` read in the browser checks and build scripts. */
function constantReadsInScripts(): Array<{ file: string; name: string }> {
  const out: Array<{ file: string; name: string }> = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (e.endsWith('.mjs')) {
        const src = readFileSync(p, 'utf8')
        for (const m of src.matchAll(/window\.__game\.constants\(\)\.([A-Z][A-Z0-9_]*)/g)) {
          const name = m[1]
          if (name) out.push({ file: p.slice(root.length + 1), name })
        }
      }
    }
  }
  walk(join(root, 'scripts'))
  return out
}

describe('a constant a check reads is a constant that exists (T20.15)', () => {
  const table = C() as unknown as Record<string, number>

  it('reads no constant that is not in constants_json', () => {
    const reads = constantReadsInScripts()
    // The presence half: without reads to check, the assertion below is vacuous.
    expect(reads.length).toBeGreaterThan(5)
    const missing = reads.filter((r) => !(r.name in table)).map((r) => `${r.file}: ${r.name}`)
    expect([...new Set(missing)]).toEqual([])
  })

  it('names the file and the constant when one is missing — the falsification', () => {
    const reads = [
      ...constantReadsInScripts(),
      { file: 'scripts/checks/made-up.mjs', name: 'LOBBY_BOT_TIMEOUT' },
    ]
    const missing = reads.filter((r) => !(r.name in table)).map((r) => `${r.file}: ${r.name}`)
    expect(missing).toEqual(['scripts/checks/made-up.mjs: LOBBY_BOT_TIMEOUT'])
  })
})

describe('constants_json and the Constants interface are the same set (T20.15)', () => {
  /** The `NAME: number` lines of `export interface Constants`. */
  const declared = (() => {
    const src = readFileSync(join(here, 'index.ts'), 'utf8')
    const body = src.slice(src.indexOf('export interface Constants {'))
    return [...body.slice(0, body.indexOf('\n}')).matchAll(/^  ([A-Z][A-Z0-9_]*)\s*:/gm)].map(
      (m) => m[1] as string,
    )
  })()
  const inJson = Object.keys(C())

  it('found both tables — without this the two assertions below are vacuous', () => {
    expect(declared.length).toBeGreaterThan(100)
    expect(inJson.length).toBeGreaterThan(100)
    expect(declared).toContain('VIEWPORT_W')
  })

  it('declares every constant the WASM table exports', () => {
    // `GRAVITY`, `BIRD_DROP_VELOCITY` and `CHUNK_REBAKE_MS` were in the table and
    // not here, so a browser check could read them and TypeScript could not.
    expect(inJson.filter((k) => !declared.includes(k))).toEqual([])
  })

  it('declares nothing the WASM table does not export', () => {
    // The direction that produces the T20.15 defect one layer up: a name TypeScript
    // believes in and `constants_json` has never heard of reads as `undefined`.
    expect(declared.filter((k) => !inJson.includes(k))).toEqual([])
  })
})

describe('strictConstants makes an absent constant loud (T20.15)', () => {
  it('throws on a SCREAMING_CASE key that is not there, and names it', () => {
    const s = strictConstants() as unknown as Record<string, number>
    expect(() => s.LOBBY_BOT_TIMEOUT).toThrowError(/LOBBY_BOT_TIMEOUT is not in constants_json/)
  })

  it('control: the same read on plain C() is undefined and silent — the defect', () => {
    const plain = C() as unknown as Record<string, number>
    expect(plain.LOBBY_BOT_TIMEOUT).toBeUndefined()
    // And this is the whole bug in one line.
    expect(Number.isNaN((plain.LOBBY_BOT_TIMEOUT as unknown as number) + 8)).toBe(true)
  })

  it('control: a constant that IS there still reads through', () => {
    expect(strictConstants().VIEWPORT_W).toBe(C().VIEWPORT_W)
    expect(strictConstants().SIM_HZ).toBe(C().SIM_HZ)
  })

  it('does not police the keys a serialiser asks for', () => {
    // `JSON.stringify` asks for `toJSON`, promise resolution asks for `then`, and
    // Playwright's serialiser walks the object. Throwing on those would break every
    // caller that returns the whole table rather than one number.
    const s = strictConstants() as unknown as Record<string, unknown>
    expect(() => s.toJSON).not.toThrow()
    expect(() => s.then).not.toThrow()
    expect(() => JSON.stringify(strictConstants())).not.toThrow()
    expect(Object.keys(strictConstants()).length).toBeGreaterThan(100)
  })
})

describe('the dev handles are the ones that got the guard (T20.15)', () => {
  // A test calling `strictConstants` is not a caller. The `.mjs` checks reach it
  // only through `window.__game.constants()` and `window.__sandbox.constants()`,
  // and those are the two sites that have to be wired — a guard on a function
  // nobody routes through is the mechanism-with-no-caller shape this repo has paid
  // for twelve times.
  const scenes = join(root, 'client/src/scenes')
  const handles = ['GameScene.ts', 'SandboxScene.ts']

  it('every scene exposing constants() returns the strict view, not plain C()', () => {
    for (const f of handles) {
      const src = readFileSync(join(scenes, f), 'utf8')
      const body = src.slice(src.indexOf('      constants() {'))
      const decl = body.slice(0, body.indexOf('},'))
      expect(decl, `${f} exposes constants() without the guard`).toContain('strictConstants()')
      expect(decl, `${f} still returns plain C()`).not.toMatch(/return C\(\)/)
    }
  })

  it('found the handles — without this the assertion above is vacuous', () => {
    for (const f of handles) {
      expect(readFileSync(join(scenes, f), 'utf8')).toContain('      constants() {')
    }
  })
})

describe('deadlineMs refuses a wait that could never time out (T20.15)', () => {
  it('turns seconds into milliseconds — the control', () => {
    expect(deadlineMs(45, 'a lobby starting')).toBe(45_000)
    expect(deadlineMs(0.5, 'a lobby starting')).toBe(500)
  })

  it('throws on exactly the values that produced a deadline-free wait', () => {
    // `constants().LOBBY_BOT_TIMEOUT` was `undefined`; `undefined + 8` is `NaN`.
    for (const bad of [undefined, null, NaN, Infinity, 0, -1, '45']) {
      expect(() => deadlineMs(bad, 'a solo lobby starting itself')).toThrowError(
        /a solo lobby starting itself/,
      )
    }
  })
})
