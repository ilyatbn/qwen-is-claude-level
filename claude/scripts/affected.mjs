#!/usr/bin/env node
/**
 * What a change touches, and so what is worth running.
 *
 *   node scripts/affected.mjs                 # changes since HEAD~1, human-readable
 *   node scripts/affected.mjs master          # since any git rev
 *   node scripts/affected.mjs --files a b     # these paths, no git
 *   node scripts/affected.mjs --shell         # AFFECTED_* assignments for check.sh
 *   node scripts/affected.mjs --json
 *
 * ## The base
 *
 * **`HEAD~1` against the working tree, plus untracked files.** The loop is
 * "commit, then gate", so the last commit is the change under test; comparing
 * against the working tree also picks up anything not yet committed. Run before
 * committing it covers one commit too many, which only ever adds checks — the
 * safe direction. A task spread over several commits passes its own base.
 * `master` is not the default: this branch is hundreds of commits past it, which
 * would make every run a full run.
 *
 * The rules live in `lib/affected.mjs`, with the reason for each.
 */
import { execFileSync } from 'node:child_process'
import { affected, loadContext, root } from './lib/affected.mjs'
import { CHECKS } from './lib/e2e-checks.mjs'

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node scripts/affected.mjs [<git-rev>] [--files path ...] [--shell | --json]')
  console.log('  default rev: HEAD~1, compared against the working tree, plus untracked files')
  process.exit(0)
}
const mode = argv.includes('--shell') ? 'shell' : argv.includes('--json') ? 'json' : 'text'
const rest = argv.filter((a) => a !== '--shell' && a !== '--json')

let changed
const filesAt = rest.indexOf('--files')
if (filesAt >= 0) {
  changed = rest.slice(filesAt + 1)
} else {
  const base = rest[0] ?? 'HEAD~1'
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  // `--relative`: the repository root is one level up, and paths here are
  // relative to this project. `--no-renames` so a rename reports both ends —
  // the old path's importers are exactly the checks that broke.
  changed = [
    ...git('diff', '--name-only', '--no-renames', '--relative', base),
    ...git('ls-files', '--others', '--exclude-standard'),
  ]
}

const r = affected([...new Set(changed)], loadContext(CHECKS))

if (mode === 'json') {
  console.log(JSON.stringify(r, null, 2))
} else if (mode === 'shell') {
  // Values are crate and check names — `[a-z0-9_-]` — so single quotes suffice.
  console.log(`AFFECTED_CRATES='${r.crates.join(' ')}'`)
  console.log(`AFFECTED_CLIENT=${r.client ? 1 : 0}`)
  console.log(`AFFECTED_E2E='${r.e2e.join(',')}'`)
  console.log(`AFFECTED_NET_SMOKE=${r.netSmoke ? 1 : 0}`)
  console.log(`AFFECTED_ASSETS=${r.assets ? 1 : 0}`)
} else {
  console.log(`${changed.length} changed file(s)${r.everything ? ' — running EVERYTHING' : ''}`)
  for (const { file, why } of r.reasons) console.log(`  ${file}: ${why}`)
  console.log(`crates:    ${r.crates.join(' ') || '(none)'}`)
  console.log(`client:    ${r.client ? 'typecheck + vitest' : '(none)'}`)
  console.log(`e2e:       ${r.e2e.length} check(s)${r.e2e.length ? `: ${r.e2e.join(', ')}` : ''}`)
  console.log(`net smoke: ${r.netSmoke ? 'yes' : 'no'}   assets: ${r.assets ? 'yes' : 'no'}`)
}
