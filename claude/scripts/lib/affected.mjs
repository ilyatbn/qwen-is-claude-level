/**
 * Changed files → what is worth running. The rules behind `scripts/affected.mjs`
 * and `check.sh --changed`.
 *
 * **Missing a check is worse than running an extra one**, so every rule here
 * either derives its answer from the tree or falls back to *everything*. The
 * hand-written part is the two tables below and nothing else.
 *
 * ## What is derived
 *
 * - **Scripts** — the import graph of every `scripts/**.mjs` and every client
 *   `*.test.ts`, walked backwards from the changed file. Reaching a registered
 *   check's file selects that check; reaching `scripts/e2e.mjs` selects all of
 *   them; reaching a client test selects vitest. A scripts file that reaches
 *   none of those and is not in `NOTHING` is unknown, so: everything.
 * - **Crates** — the changed crate plus every workspace crate whose Cargo.toml
 *   names it. Anything reaching `game-wasm` is in every page, so all e2e; anything
 *   reaching `game-server` selects the `standalone` checks (the in-page ones run
 *   on the sandbox and never talk to a server) and the net smoke. Client tests
 *   are selected when the closure includes `game-wasm` (its generated types) or a
 *   client test's text names one of the crates (twenty-odd read Rust sources).
 *
 * ## What is deliberately *not* narrowed
 *
 * **A client source file selects every browser check.** Each check boots
 * `main.ts`, so narrowing by scene would need the TypeScript import graph plus
 * knowledge of which scene each URL reaches, and one missed edge silently drops
 * the check that would have gone red. That is the trade this module refuses.
 *
 * Checks marked `flaky` or `optIn` are selected only by a change to their own
 * file: they are out of the default suite, and a harness change should not put
 * them back in.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Paths that are **everything**, whatever else they look like. Checked first.
 */
export const EVERYTHING = [
  [/^(Cargo\.toml|Cargo\.lock|rust-toolchain\.toml)$/, 'workspace build configuration'],
  [/^assets\//, 'game-core embeds assets/objects/masks.bin; client tests read the manifests'],
  [/^scripts\/wasm-build\.mjs$/, 'builds the wasm every page and the client typecheck use'],
]

/**
 * Paths that need **nothing** beyond what every `--changed` run does anyway
 * (fmt of changed crates, `verify-repo`, this module's own test). Keep it short;
 * each entry is a claim that no test reads the path.
 */
export const NOTHING = [
  [/^(docs|tasks)\/.*\.md$/, 'prose — no test reads it; TASKS.md links are verify-repo’s, which always runs'],
  [/^[^/]+\.md$/, 'root prose'],
  [/^(Makefile|\.gitignore)$/, 'not read by any test'],
  [/^(shots|recordings|replays)\//, 'run output'],
  [/^scripts\/check\.sh$/, 'the gate itself — `check.sh --changed` exercises it'],
  [/^scripts\/(affected\.mjs|lib\/affected(\.test)?\.mjs)$/, 'its own test runs in every gate mode'],
  [/^scripts\/(play|probe|shot|drive)\.mjs$/, 'interactive dev tools'],
  [/^scripts\/(build-atlas|build-audio|catalogue-sprites)\.mjs$|^scripts\/fetch-assets\.sh$/,
    'generators: their output lands in assets/, which is what is tested'],
  [/^scripts\/(verify-repo\.mjs|ignored\.sh)$/, 'repo guards, which always run'],
]

const IMPORT = /(?:^|[\s;])(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm

function walk(dir, keep, out = []) {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'pkg') walk(p, keep, out)
    } else if (keep(e.name)) out.push(p)
  }
  return out
}

/**
 * Read the tree once: the scripts/client-test import graph, the workspace's
 * crate dependency edges, and which crates client tests name.
 */
export function loadContext(checks, dir = root) {
  const rel = (p) => relative(dir, p).split('\\').join('/')
  const files = [
    ...walk(join(dir, 'scripts'), (n) => n.endsWith('.mjs') || n.endsWith('.d.mts')),
    ...walk(join(dir, 'client/src'), (n) => n.endsWith('.test.ts')),
  ]
  /** file → the files it imports (project-relative) */
  const imports = new Map()
  const clientTestText = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    const deps = new Set()
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3]
      if (spec?.startsWith('.')) deps.add(rel(resolve(dirname(f), spec)))
    }
    imports.set(rel(f), deps)
    if (f.endsWith('.test.ts')) clientTestText.push(text)
  }

  const workspace = readFileSync(join(dir, 'Cargo.toml'), 'utf8')
  const membersLine = workspace.match(/^members\s*=\s*\[([^\]]*)\]/m)?.[1] ?? ''
  const members = [...membersLine.matchAll(/"crates\/([\w-]+)"/g)].map((m) => m[1])
  // Two edge kinds. **Any** dependency (dev included) means the dependent's
  // tests can break, so it widens the Rust set. Only a `[dependencies]` edge
  // puts one crate's code *inside* another's artifact — `game-wasm` dev-depends
  // on `game-server` for a codec test, and that must not make a server change
  // look like a wasm change.
  /** crate → crates that depend on it, any section */
  const dependents = new Map(members.map((c) => [c, new Set()]))
  /** crate → crates that link it (`[dependencies]` only) */
  const linkDependents = new Map(members.map((c) => [c, new Set()]))
  for (const c of members) {
    let section = ''
    for (const line of readFileSync(join(dir, 'crates', c, 'Cargo.toml'), 'utf8').split('\n')) {
      const header = line.match(/^\s*\[([^\]]+)\]/)
      if (header) section = header[1]
      for (const other of members) {
        if (other === c || !new RegExp(`^\\s*${other}\\s*(=|\\.workspace)`).test(line)) continue
        if (section.endsWith('dependencies')) dependents.get(other).add(c)
        if (section === 'dependencies') linkDependents.get(other).add(c)
      }
    }
  }
  const namedByClientTests = new Set(
    members.filter((c) => clientTestText.some((t) => t.includes(`crates/${c}`))),
  )
  return { checks, imports, members, dependents, linkDependents, namedByClientTests }
}

/**
 * @param {string[]} changed project-relative paths
 * @param {ReturnType<typeof loadContext>} ctx
 */
export function affected(changed, ctx) {
  const { checks, imports, members, dependents, linkDependents, namedByClientTests } = ctx
  const inDefault = (c) => !c.flaky && !c.optIn
  const byFile = new Map(checks.map((c) => [c.file, c]))
  const e2e = new Set()
  const crates = new Set()
  const reasons = []
  let client = false
  let netSmoke = false
  let assets = false
  let everything = false
  const allE2e = () => checks.filter(inDefault).forEach((c) => e2e.add(c.name))

  for (const file of changed) {
    const why = (w) => reasons.push({ file, why: w })
    const hit = (table) => table.find(([re]) => re.test(file))

    const all = hit(EVERYTHING)
    if (all) {
      everything = true
      why(`everything — ${all[1]}`)
      continue
    }

    const crate = file.match(/^crates\/([\w-]+)\//)?.[1]
    if (crate) {
      if (!members.includes(crate)) {
        everything = true
        why('everything — not a workspace crate')
        continue
      }
      const closure = new Set([crate])
      for (const c of closure) for (const d of dependents.get(c)) closure.add(d)
      closure.forEach((c) => crates.add(c))
      // What the change is *shipped inside*: link edges only.
      const linked = new Set([crate])
      for (const c of linked) for (const d of linkDependents.get(c)) linked.add(d)
      const parts = [`rust ${[...closure].join(' ')}`]
      if (linked.has('game-wasm')) {
        allE2e()
        client = true
        parts.push('all e2e and client (the wasm is in every page)')
      } else if (linked.has('game-server')) {
        checks.filter((c) => c.standalone && inDefault(c)).forEach((c) => e2e.add(c.name))
        netSmoke = true
        parts.push('standalone e2e and net smoke (they run a real server)')
      }
      if (!client && [...closure].some((c) => namedByClientTests.has(c))) {
        client = true
        parts.push('client (a client test reads its source)')
      }
      why(parts.join('; '))
      continue
    }

    if (/^client\/src\/.*\.test\.ts$/.test(file)) {
      client = true
      why('client tests (a test file is not in the bundle)')
      continue
    }
    if (file.startsWith('client/')) {
      client = true
      allE2e()
      why('client and all e2e — every check boots main.ts; not narrowed by scene')
      continue
    }

    if (file.startsWith('scripts/')) {
      // Walk importers backwards from the changed file.
      const reach = new Set([file])
      for (const f of reach) {
        for (const [g, deps] of imports) if (deps.has(f)) reach.add(g)
      }
      const got = []
      for (const f of reach) {
        const check = byFile.get(f)
        if (check && (f === file || inDefault(check))) {
          e2e.add(check.name)
          got.push(check.name)
        }
        if (f === 'scripts/e2e.mjs') {
          allE2e()
          got.push('all e2e (the runner)')
        }
        if (f.startsWith('client/src/')) {
          client = true
          got.push('client tests')
        }
        if (f === 'scripts/net-smoke.mjs') {
          netSmoke = true
          got.push('net smoke')
        }
        if (f === 'scripts/verify-assets.mjs') {
          assets = true
          got.push('assets')
        }
      }
      // A registered check reached only through flaky importers still counts
      // as known: selecting nothing is the right answer for it.
      const known = got.length || [...reach].some((f) => byFile.has(f))
      if (known) {
        why(got.length ? [...new Set(got)].join(', ') : 'only parked (flaky/opt-in) checks use it')
        continue
      }
    }

    const none = hit(NOTHING)
    if (none) {
      why(`nothing — ${none[1]}`)
      continue
    }
    everything = true
    why('everything — no rule knows this path')
  }

  if (everything) {
    members.forEach((c) => crates.add(c))
    client = true
    netSmoke = true
    assets = true
    allE2e()
  }
  return {
    everything,
    crates: members.filter((c) => crates.has(c)),
    client,
    e2e: checks.filter((c) => e2e.has(c.name)).map((c) => c.name),
    netSmoke,
    assets,
    reasons,
  }
}
