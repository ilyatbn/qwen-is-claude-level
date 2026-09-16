/**
 * The six `backdrop-real-*.test.ts` files together run **every** case in
 * `CASES`, each exactly once.
 *
 * The suite was one file until 2026-09-15, when it was split per map so vitest
 * could spread it across workers (see `backdrop-real.suite.ts`). A split like
 * that has one new way to lose coverage silently: a case added to `CASES` with
 * no file calling it, or a file whose name no longer matches any case. Both
 * would leave the run green. This counts the thing at both ends — the table and
 * the callers read from disk — and asserts the two agree.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CASES } from './backdrop-real.suite'

const here = dirname(fileURLToPath(import.meta.url))

function calledCases(): string[] {
  const files = readdirSync(here).filter(
    (f) => /^backdrop-real-.+\.test\.ts$/.test(f) && f !== 'backdrop-real-cases.test.ts',
  )
  const names: string[] = []
  for (const f of files) {
    const src = readFileSync(join(here, f), 'utf8')
    for (const m of src.matchAll(/backdropRealSuite\('([^']+)'\)/g)) names.push(m[1]!)
  }
  return names
}

describe('backdrop-real is split per map without losing a case', () => {
  it('finds the per-map files at all', () => {
    // Control: an empty directory listing would make the next test compare two
    // empty lists and pass.
    expect(calledCases().length).toBeGreaterThan(0)
  })

  it('runs every case in CASES exactly once', () => {
    const table = CASES.map(([name]) => name as string).sort()
    expect(calledCases().sort()).toEqual(table)
  })
})
