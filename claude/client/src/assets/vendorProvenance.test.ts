import { describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { incompleteProvenance, missingProvenance, packsInManifest, packsInReadme } from '../../../scripts/lib/vendor-provenance.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const manifest = JSON.parse(readFileSync(join(root, 'assets/objects/manifest.json'), 'utf8'))
const readme = readFileSync(join(root, 'assets/vendor/README.md'), 'utf8')

describe('vendor provenance (docs/51 §8, docs/73 §D7)', () => {
  it('accounts for every pack the shipped object art derives from', () => {
    expect(missingProvenance(manifest, readme)).toEqual([])
  })

  it('found packs to account for, or the assertion above is vacuous', () => {
    expect(packsInManifest(manifest).length).toBeGreaterThan(0)
  })

  it('goes red when an entry is removed — the falsification, at the live path', () => {
    const packs = packsInManifest(manifest)
    const victim = packs[0]
    const stripped = readme
      .split('\n')
      .filter((line) => !new RegExp('^\\s*\\|\\s*`' + victim + '`\\s*\\|').test(line))
      .join('\n')

    expect(stripped).not.toEqual(readme)
    expect(missingProvenance(manifest, stripped)).toEqual([victim])
  })

  it('names what is missing rather than counting it', () => {
    expect(missingProvenance(manifest, '')).toEqual(packsInManifest(manifest))
  })

  it('does not let a Kenney row vouch for a same-named sprite pack', () => {
    // Both provenance domains live in one file. Scanning every table would let
    // "CC0 by Kenney" stand as the licence for owner-supplied art.
    const kenneyOnly = readme.slice(0, readme.indexOf('## Sprite packs'))
    expect(kenneyOnly).toContain('| `ui-pack` |')
    expect(packsInReadme(kenneyOnly).size).toBe(0)
  })

  it('does not accept a pack merely mentioned in prose', () => {
    const prose = 'The rocks pack is royalty-free and unlimited use.\n'
    expect(packsInReadme(prose).size).toBe(0)
  })

  it('every recorded row carries a source, a licence and a date', () => {
    expect(incompleteProvenance(manifest, readme)).toEqual([])
  })

  it('rejects a row that names a pack and records nothing about it', () => {
    const victim = packsInManifest(manifest)[0]
    const gutted = readme
      .split('\n')
      .map((line) =>
        new RegExp('^\\s*\\|\\s*`' + victim + '`\\s*\\|').test(line)
          ? '| `' + victim + '` | | | | |'
          : line,
      )
      .join('\n')

    expect(gutted).not.toEqual(readme)
    // Still present, so the missing-entry check is satisfied and would pass it.
    expect(missingProvenance(manifest, gutted)).toEqual([])
    expect(incompleteProvenance(manifest, gutted)).toEqual([victim])
  })

  it('accepts "not recorded" as a source — a known gap is still a record', () => {
    const rows = '| `rocks` | not recorded | royalty-free | 2026-08-23 | 2.6M |\n'
    expect(incompleteProvenance({ objects: [{ pack: 'rocks' }] }, rows)).toEqual([])
  })

  it('reads the manifest rather than a hardcoded list', () => {
    const invented = { objects: [{ pack: 'a-pack-that-does-not-exist' }] }
    expect(missingProvenance(invented, readme)).toEqual(['a-pack-that-does-not-exist'])
  })

  // The tests above prove the predicate. This one proves the *script* —
  // `verify-assets.mjs` is what the gate runs, and a predicate that returns the
  // right answer into a loop that forgets to report it is a green gate.
  it('the script itself exits non-zero and names the pack', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provenance-'))
    try {
      cpSync(join(root, 'assets'), join(dir, 'assets'), { recursive: true })
      cpSync(join(root, 'scripts'), join(dir, 'scripts'), { recursive: true })
      // The script resolves pngjs through client/package.json, so the copy needs
      // a client beside it or it dies on an import before reaching the check —
      // and an exit code from the wrong failure would prove nothing.
      symlinkSync(join(root, 'client'), join(dir, 'client'), 'dir')
      const victim = packsInManifest(manifest)[0]
      const stripped = readme
        .split('\n')
        .filter((line) => !new RegExp('^\\s*\\|\\s*`' + victim + '`\\s*\\|').test(line))
        .join('\n')
      writeFileSync(join(dir, 'assets/vendor/README.md'), stripped)

      const strippedRun = spawnSync(process.execPath, [join(dir, 'scripts/verify-assets.mjs')], {
        encoding: 'utf8',
      })

      // Control: the same copy, unedited, must pass. Without it a non-zero exit
      // from a broken import or a missing asset would read as the check working.
      writeFileSync(join(dir, 'assets/vendor/README.md'), readme)
      const intactRun = spawnSync(process.execPath, [join(dir, 'scripts/verify-assets.mjs')], {
        encoding: 'utf8',
      })

      expect(intactRun.status).toBe(0)
      expect(strippedRun.status).not.toBe(0)
      expect(strippedRun.stderr).toContain(victim)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
